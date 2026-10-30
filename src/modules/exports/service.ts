import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { exportsTable, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { IntegrationNotConfiguredError, requireIntegration } from "@/env";
import { audit } from "@/lib/audit";
import { assertCan, type Role } from "@/lib/auth/permissions";
import { enqueue, PermanentJobError } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES, type JobContext } from "@/lib/jobs/registry";
import { parseOrgSettings } from "@/lib/org-settings";
import { rateLimit } from "@/lib/ratelimit";
import { objectKey, putObject, signedGetUrl } from "@/lib/storage";
import { reportFiltersSchema, type ReportFilters } from "@/modules/reports/filters";
import { toCsv } from "./csv";
import { EXPORT_KINDS, exportColumns, exportRows, MAX_EXPORT_ROWS, type ExportKind } from "./definitions";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

export class ExportError extends Error {
  constructor(message: string, readonly status: number = 422) {
    super(message);
    this.name = "ExportError";
  }
}

/** Storage seam so tests can run without S3; production uses the private bucket. */
export interface ExportStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  signedUrl(orgId: string, key: string, filename: string): Promise<string>;
}

export const s3ExportStorage: ExportStorage = {
  put: (key, body, contentType) => putObject(key, body, contentType),
  signedUrl: (orgId, key, filename) => signedGetUrl(orgId, key, { filename }),
};

export const exportRequestSchema = z.object({
  kind: z.enum(EXPORT_KINDS),
  filters: reportFiltersSchema,
});

export const EXPORT_RATE_LIMIT = { limit: 20, windowSeconds: 3600 };

/**
 * Queue an export. Checks permission, that storage is configured (never pretends
 * a file will be produced), rate limits per user, and records the request,
 * the job and the audit event in one tenant transaction.
 */
export async function requestExport(actor: Actor, input: { kind: ExportKind; filters: ReportFilters }): Promise<{ id: string }> {
  assertCan(actor.role, "export.create");
  const parsed = exportRequestSchema.parse(input);
  requireIntegration("storage");
  await rateLimit(`export:${actor.userId}`, EXPORT_RATE_LIMIT.limit, EXPORT_RATE_LIMIT.windowSeconds);
  return withTenant(actor.orgId, async (tx) => {
    const [row] = await tx
      .insert(exportsTable)
      .values({ orgId: actor.orgId, kind: parsed.kind, filters: parsed.filters, createdBy: actor.userId })
      .returning({ id: exportsTable.id });
    const id = row!.id;
    await enqueue(tx, {
      orgId: actor.orgId,
      type: JOB_TYPES.generateExport,
      payload: { exportId: id },
      idempotencyKey: idempotencyKey(actor.orgId, JOB_TYPES.generateExport, id),
      maxAttempts: 4,
      createdBy: actor.userId,
    });
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "export.requested", entityType: "export", entityId: id, data: { kind: parsed.kind, filters: parsed.filters } });
    return { id };
  });
}

const payloadSchema = z.object({ exportId: z.string().uuid() });

/**
 * `export.generate` job. Idempotent: a ready export is left alone; the object
 * key is derived from the export id, so a retry after a partial failure simply
 * overwrites the same object. Terminal failures are written to the export row
 * so the UI shows them, and the job stays recoverable from Settings.
 */
export async function generateExport(ctx: JobContext, storage: ExportStorage = s3ExportStorage, now: () => Date = () => new Date()) {
  const parsed = payloadSchema.safeParse(ctx.job.payload);
  if (!parsed.success) throw new PermanentJobError("Invalid export job payload");
  const { exportId } = parsed.data;
  const { orgId } = ctx;
  try {
    const prepared = await withTenant(orgId, async (tx) => {
      const [exp] = await tx.select().from(exportsTable).where(eq(exportsTable.id, exportId));
      if (!exp) throw new PermanentJobError("Export not found for this organisation");
      if (exp.status === "ready" || exp.status === "expired") return { skipped: true as const, status: exp.status };
      const kind = z.enum(EXPORT_KINDS).safeParse(exp.kind);
      const filters = reportFiltersSchema.safeParse(exp.filters);
      if (!kind.success || !filters.success) throw new PermanentJobError("Export has an unknown kind or invalid filters");
      const rows = await exportRows(tx, kind.data, filters.data);
      if (rows.length > MAX_EXPORT_ROWS) throw new PermanentJobError(`Export exceeds ${MAX_EXPORT_ROWS.toLocaleString("en-GB")} rows; narrow the date range or supplier filter`);
      const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
      return { skipped: false as const, csv: toCsv(exportColumns(kind.data), rows), rowCount: rows.length, settings: parseOrgSettings(org?.settings) };
    });
    if (prepared.skipped) return { exportId, skipped: prepared.status };

    const key = objectKey(orgId, "exports", exportId, "csv");
    await storage.put(key, Buffer.from(prepared.csv, "utf8"), "text/csv; charset=utf-8");

    const finishedAt = now();
    const expiresAt = new Date(finishedAt.getTime() + prepared.settings.retention.exportDays * 86_400_000);
    await withTenant(orgId, async (tx) => {
      const updated = await tx
        .update(exportsTable)
        .set({ status: "ready", storageKey: key, rowCount: prepared.rowCount, completedAt: finishedAt, expiresAt, error: null })
        .where(and(eq(exportsTable.id, exportId), eq(exportsTable.orgId, orgId)))
        .returning({ id: exportsTable.id });
      if (!updated[0]) throw new PermanentJobError("Export disappeared while generating");
      await audit(tx, {
        orgId,
        actorUserId: null,
        actorType: "system",
        action: "export.generated",
        entityType: "export",
        entityId: exportId,
        data: { rowCount: prepared.rowCount, expiresAt: expiresAt.toISOString(), jobId: ctx.job.id },
      });
    });
    return { exportId, rowCount: prepared.rowCount };
  } catch (err) {
    const permanent =
      err instanceof IntegrationNotConfiguredError ? new PermanentJobError(`Document storage is not configured (missing ${err.missing.join(", ")})`) : err;
    const terminal = permanent instanceof PermanentJobError || ctx.job.attempts >= ctx.job.maxAttempts;
    if (terminal) await markFailed(orgId, exportId, permanent instanceof Error ? permanent.message : String(permanent));
    throw permanent;
  }
}

async function markFailed(orgId: string, exportId: string, message: string) {
  await withTenant(orgId, async (tx) => {
    const res = await tx
      .update(exportsTable)
      .set({ status: "failed", error: message.slice(0, 500) })
      .where(and(eq(exportsTable.id, exportId), eq(exportsTable.status, "queued")))
      .returning({ id: exportsTable.id });
    if (res[0]) await audit(tx, { orgId, actorUserId: null, actorType: "system", action: "export.failed", entityType: "export", entityId: exportId, data: { error: message.slice(0, 500) } });
  });
}

/**
 * Issue a short-lived signed download URL for a ready export in the caller's
 * organisation. Expired exports are marked expired and refused. Audited.
 */
export async function exportDownloadUrl(actor: Actor, exportId: string, storage: ExportStorage = s3ExportStorage, now: Date = new Date()): Promise<string> {
  assertCan(actor.role, "export.create");
  if (!z.string().uuid().safeParse(exportId).success) throw new ExportError("Export not found", 404);
  const found = await withTenant(actor.orgId, async (tx) => {
    const [exp] = await tx.select().from(exportsTable).where(and(eq(exportsTable.id, exportId), eq(exportsTable.orgId, actor.orgId)));
    if (!exp) return { error: new ExportError("Export not found", 404) };
    if (exp.status === "ready" && exp.expiresAt && exp.expiresAt <= now) {
      await tx.update(exportsTable).set({ status: "expired" }).where(eq(exportsTable.id, exp.id));
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "export.expired", entityType: "export", entityId: exp.id });
      return { error: new ExportError("This export has expired. Create a new one.", 410) };
    }
    if (exp.status === "expired") return { error: new ExportError("This export has expired. Create a new one.", 410) };
    if (exp.status !== "ready" || !exp.storageKey) return { error: new ExportError("This export is not ready yet", 409) };
    const [org] = await tx.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, actor.orgId));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "export.downloaded", entityType: "export", entityId: exp.id, data: { kind: exp.kind } });
    return { exp, isDemo: org?.isDemo ?? false };
  });
  if ("error" in found) throw found.error;
  const { exp, isDemo } = found;
  return storage.signedUrl(actor.orgId, exp.storageKey!, exportFileName(exp.kind, exp.createdAt, isDemo));
}

export function exportFileName(kind: string, createdAt: Date, isDemo: boolean) {
  return `avixcheck-${isDemo ? "DEMO-" : ""}${kind}-${createdAt.toISOString().slice(0, 10)}.csv`;
}

export type ExportRow = typeof exportsTable.$inferSelect;

export async function listExports(orgId: string, page = 1, pageSize = 10): Promise<{ rows: ExportRow[]; total: number }> {
  return withTenant(orgId, async (tx) => {
    const [t] = await tx.select({ n: count() }).from(exportsTable);
    const rows = await tx
      .select()
      .from(exportsTable)
      .orderBy(desc(exportsTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { rows, total: t?.n ?? 0 };
  });
}
