import { createHash } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { importBatches, importRows } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { assertCan, type Role } from "@/lib/auth/permissions";
import { DomainError } from "@/lib/orgs";
import { parseCsv, type RawRow } from "./csv";
import type { RowError } from "./fields";
import { HANDLERS } from "./kinds";
import { chunk, type ImportKind, type Plan, type RowResult } from "./types";

export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

export type ImportSummary = Record<string, number>;

function summarise(plan: Plan): { summary: ImportSummary; errorCount: number } {
  const summary: ImportSummary = { rows: plan.rows.length };
  let errorCount = 0;
  for (const r of plan.rows) {
    if (r.errors.length) errorCount++;
    else if (r.action) summary[r.action] = (summary[r.action] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(plan.extra)) if (v) summary[k] = v;
  summary.errors = errorCount;
  return { summary, errorCount };
}

/** Serialises imports per organisation so two commits cannot interleave reference changes. */
async function lockOrgImports(tx: Tx, orgId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`avix:imports:${orgId}`}, 0))`);
}

/**
 * Parse and validate a CSV, store it as a previewed batch with row-level
 * errors, and return the batch id. Nothing is written to reference data.
 */
export async function previewImport(actor: Actor, input: { kind: ImportKind; fileName: string; bytes: Uint8Array }) {
  assertCan(actor.role, "reference.import");
  const handler = HANDLERS[input.kind];
  if (!handler) throw new DomainError("Unknown import type", "unknown_kind");
  const fileName = input.fileName.trim().slice(0, 200) || "upload.csv";
  if (!/\.csv$/i.test(fileName)) throw new DomainError("Upload a .csv file", "not_csv");
  const rows = parseCsv(input.bytes, handler.columns, handler.required);
  const sha = createHash("sha256").update(input.bytes).digest("hex");

  return withTenant(actor.orgId, async (tx) => {
    const plan = await handler.plan(tx, actor.orgId, rows, { lock: false });
    const { summary, errorCount } = summarise(plan);
    const [batch] = await tx
      .insert(importBatches)
      .values({ orgId: actor.orgId, kind: input.kind, fileName, fileSha256: sha, rowCount: rows.length, errorCount, summary, createdBy: actor.userId })
      .returning();
    const byRow = new Map(plan.rows.map((r) => [r.rowNumber, r]));
    for (const part of chunk(rows, 1000)) {
      await tx.insert(importRows).values(
        part.map((r) => ({ orgId: actor.orgId, batchId: batch!.id, rowNumber: r.rowNumber, raw: r.data, errors: byRow.get(r.rowNumber)?.errors ?? [], action: byRow.get(r.rowNumber)?.action ?? null })),
      );
    }
    const [previous] = await tx
      .select({ id: importBatches.id, committedAt: importBatches.committedAt })
      .from(importBatches)
      .where(and(eq(importBatches.kind, input.kind), eq(importBatches.fileSha256, sha), eq(importBatches.status, "committed"), ne(importBatches.id, batch!.id)))
      .orderBy(desc(importBatches.committedAt))
      .limit(1);
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "import.previewed",
      entityType: "import_batch",
      entityId: batch!.id,
      data: { kind: input.kind, fileName, fileSha256: sha, summary },
    });
    return { batchId: batch!.id, summary, errorCount, previouslyCommittedBatchId: previous?.id ?? null };
  });
}

export type CommitResult =
  | { status: "committed"; summary: ImportSummary }
  | { status: "already_committed"; summary: ImportSummary }
  | { status: "blocked"; errorCount: number; summary: ImportSummary };

/**
 * Commit a previewed batch in one transaction. Rows are re-validated against
 * the current reference data under lock; if anything is now invalid the batch
 * stays in preview with refreshed errors and nothing is written. Committing an
 * already-committed batch is a no-op, so retries and double clicks are safe.
 */
export async function commitImport(actor: Actor, batchId: string): Promise<CommitResult> {
  assertCan(actor.role, "reference.import");
  return withTenant(actor.orgId, async (tx) => {
    await lockOrgImports(tx, actor.orgId);
    const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId)).for("update");
    if (!batch) throw new DomainError("Import not found", "not_found");
    if (batch.status === "committed") return { status: "already_committed", summary: batch.summary as ImportSummary };
    if (batch.status !== "previewed") throw new DomainError(`This import is ${batch.status} and cannot be committed`, "invalid_state");

    const stored = await tx.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber));
    const raw: RawRow[] = stored.map((r) => ({ rowNumber: r.rowNumber, data: r.raw as Record<string, string> }));
    // Parser errors were recorded at preview; they cannot change, so keep them.
    const parseErrors = new Map(stored.map((r) => [r.rowNumber, (r.errors as RowError[]).filter((e) => e.source === "csv")]));
    for (const r of raw) {
      const pe = parseErrors.get(r.rowNumber);
      if (pe?.length) r.parseErrors = pe.map((e) => e.message);
    }
    const plan = await HANDLERS[batch.kind].plan(tx, actor.orgId, raw, { lock: true });
    const { summary, errorCount } = summarise(plan);
    await persistRowResults(tx, stored, plan.rows);

    if (errorCount > 0) {
      await tx.update(importBatches).set({ errorCount, summary }).where(eq(importBatches.id, batchId));
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "import.commit_blocked", entityType: "import_batch", entityId: batchId, data: { kind: batch.kind, summary } });
      return { status: "blocked", errorCount, summary };
    }

    await plan.apply(tx, { orgId: actor.orgId, userId: actor.userId, batchId, fileName: batch.fileName });
    await tx
      .update(importBatches)
      .set({ status: "committed", committedAt: new Date(), committedBy: actor.userId, errorCount: 0, summary })
      .where(eq(importBatches.id, batchId));
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: "import.committed",
      entityType: "import_batch",
      entityId: batchId,
      data: { kind: batch.kind, fileName: batch.fileName, fileSha256: batch.fileSha256, summary },
    });
    return { status: "committed", summary };
  });
}

export async function discardImport(actor: Actor, batchId: string) {
  assertCan(actor.role, "reference.import");
  return withTenant(actor.orgId, async (tx) => {
    const res = await tx
      .update(importBatches)
      .set({ status: "discarded" })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.status, "previewed")))
      .returning({ id: importBatches.id, kind: importBatches.kind });
    if (res.length === 0) throw new DomainError("Only an import in preview can be discarded", "invalid_state");
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "import.discarded", entityType: "import_batch", entityId: batchId, data: { kind: res[0]!.kind } });
  });
}

async function persistRowResults(tx: Tx, stored: (typeof importRows.$inferSelect)[], results: RowResult[]) {
  const byRow = new Map(results.map((r) => [r.rowNumber, r]));
  const changed = stored.filter((s) => {
    const r = byRow.get(s.rowNumber);
    return JSON.stringify(s.errors) !== JSON.stringify(r?.errors ?? []) || (s.action ?? null) !== (r?.action ?? null);
  });
  for (const s of changed) {
    const r = byRow.get(s.rowNumber);
    await tx.update(importRows).set({ errors: r?.errors ?? [], action: r?.action ?? null }).where(eq(importRows.id, s.id));
  }
}

export async function getBatch(orgId: string, batchId: string) {
  return withTenant(orgId, async (tx) => {
    const [b] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId));
    return b ?? null;
  });
}
