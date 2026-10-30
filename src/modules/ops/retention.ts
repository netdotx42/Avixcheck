import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { documents, exportsTable, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { assertCan, type Role } from "@/lib/auth/permissions";
import { parseOrgSettings } from "@/lib/org-settings";
import { DomainError } from "@/lib/orgs";
import { assertKeyInOrg, deleteObject } from "@/lib/storage";

/**
 * Retention controls.
 *
 * - Documents: the stored PDF is deleted once `retain_until` has passed, or,
 *   when unset, `documentDays` after upload (org setting). Documents on legal
 *   hold are never deleted. The `documents` row is kept with `deleted_at` set,
 *   so invoices, check runs and the audit trail stay intact.
 * - Exports: the generated file is deleted `exportDays` after completion and the
 *   export is marked `expired`.
 * Every deletion is audited in the same transaction that records it.
 */

export interface RetentionDeps {
  deleteObject: (key: string) => Promise<void>;
}

export interface RetentionResult {
  documentsDeleted: number;
  exportsExpired: number;
  /** True when more candidates remain than one batch handles; the next sweep continues. */
  more: boolean;
  policy: { documentDays: number; exportDays: number };
}

const DAY_MS = 86_400_000;

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function retentionPolicy(orgId: string) {
  return withTenant(orgId, async (tx) => {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new Error("Organisation not found");
    return parseOrgSettings(org.settings).retention;
  });
}

/** Ids of documents and exports due for deletion (read-only; used by the sweep and the Settings preview). */
export async function retentionCandidates(orgId: string, now: Date, limit: number) {
  const policy = await retentionPolicy(orgId);
  const docCutoff = new Date(now.getTime() - policy.documentDays * DAY_MS);
  const exportCutoff = new Date(now.getTime() - policy.exportDays * DAY_MS);
  return withTenant(orgId, async (tx) => {
    const docs = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          isNull(documents.deletedAt),
          eq(documents.legalHold, false),
          or(
            lt(documents.retainUntil, isoDate(now)),
            and(isNull(documents.retainUntil), lt(documents.createdAt, docCutoff)),
          ),
        ),
      )
      .orderBy(documents.createdAt)
      .limit(limit + 1);
    const exps = await tx
      .select({ id: exportsTable.id })
      .from(exportsTable)
      .where(and(eq(exportsTable.status, "ready"), isNotNull(exportsTable.completedAt), lt(exportsTable.completedAt, exportCutoff)))
      .orderBy(exportsTable.completedAt)
      .limit(limit + 1);
    return { policy, documentIds: docs.map((d) => d.id), exportIds: exps.map((e) => e.id), docCutoff, exportCutoff };
  });
}

export async function sweepRetention(
  orgId: string,
  opts: { now?: Date; batchSize?: number; deps?: RetentionDeps; jobId?: string } = {},
): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 200;
  const deps = opts.deps ?? { deleteObject };
  const c = await retentionCandidates(orgId, now, batchSize);
  let documentsDeleted = 0;
  let exportsExpired = 0;

  for (const id of c.documentIds.slice(0, batchSize)) {
    // One transaction per document. The row lock makes a concurrent legal hold
    // either win (we skip) or wait until the deletion is recorded.
    const deleted = await withTenant(orgId, async (tx) => {
      const res = await tx.execute(sql`
        select id, storage_key from documents
        where id = ${id} and deleted_at is null and legal_hold = false
        for update`);
      const row = res.rows[0] as { id: string; storage_key: string } | undefined;
      if (!row) return false;
      assertKeyInOrg(orgId, row.storage_key);
      await deps.deleteObject(row.storage_key);
      await tx.update(documents).set({ deletedAt: now }).where(eq(documents.id, id));
      await audit(tx, {
        orgId,
        actorUserId: null,
        actorType: "system",
        action: "retention.document_deleted",
        entityType: "document",
        entityId: id,
        data: { storageKey: row.storage_key, policyDays: c.policy.documentDays, jobId: opts.jobId ?? null },
      });
      return true;
    });
    if (deleted) documentsDeleted++;
  }

  for (const id of c.exportIds.slice(0, batchSize)) {
    const expired = await withTenant(orgId, async (tx) => {
      const res = await tx.execute(sql`select id, storage_key from exports where id = ${id} and status = 'ready' for update`);
      const row = res.rows[0] as { id: string; storage_key: string | null } | undefined;
      if (!row) return false;
      if (row.storage_key) {
        assertKeyInOrg(orgId, row.storage_key);
        await deps.deleteObject(row.storage_key);
      }
      await tx.update(exportsTable).set({ status: "expired" }).where(eq(exportsTable.id, id));
      await audit(tx, {
        orgId,
        actorUserId: null,
        actorType: "system",
        action: "retention.export_expired",
        entityType: "export",
        entityId: id,
        data: { storageKey: row.storage_key, policyDays: c.policy.exportDays, jobId: opts.jobId ?? null },
      });
      return true;
    });
    if (expired) exportsExpired++;
  }

  const more = c.documentIds.length > batchSize || c.exportIds.length > batchSize;
  await withTenant(orgId, (tx) =>
    audit(tx, {
      orgId,
      actorUserId: null,
      actorType: "system",
      action: "retention.swept",
      entityType: "organization",
      entityId: orgId,
      data: { documentsDeleted, exportsExpired, more, policy: c.policy, at: now.toISOString(), jobId: opts.jobId ?? null },
    }),
  );
  return { documentsDeleted, exportsExpired, more, policy: c.policy };
}

/** Place or release a legal hold on a document. Admin only; reason required; audited. */
export async function setLegalHold(
  actor: { userId: string; orgId: string; role: Role },
  documentId: string,
  hold: boolean,
  reason: string,
  requestId?: string | null,
) {
  assertCan(actor.role, "retention.manage");
  const why = reason.trim();
  if (why.length < 3 || why.length > 500) throw new DomainError("Give a reason (3–500 characters)", "reason_required");
  return withTenant(actor.orgId, async (tx) => {
    const [doc] = await tx
      .update(documents)
      .set({ legalHold: hold })
      .where(and(eq(documents.id, documentId), eq(documents.orgId, actor.orgId), isNull(documents.deletedAt)))
      .returning({ id: documents.id });
    if (!doc) throw new DomainError("Document not found or already deleted under retention", "not_found");
    await audit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: hold ? "document.legal_hold_set" : "document.legal_hold_released",
      entityType: "document",
      entityId: documentId,
      data: { reason: why },
      requestId,
    });
  });
}
