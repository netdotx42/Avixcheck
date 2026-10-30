import { auditEvents } from "@/db/schema";
import type { Tx } from "@/db/client";

export interface AuditInput {
  orgId: string;
  actorUserId: string | null;
  actorType?: "user" | "system";
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Append an audit event in the SAME transaction as the change it describes, so
 * the change and its audit record commit or roll back together. The table is
 * append-only (enforced by a database trigger).
 *
 * Action naming: `<entity>.<verb>`, e.g. `import.committed`, `invoice.line_corrected`,
 * `check.completed`, `exception.assigned`, `exception.decided`.
 */
export async function audit(tx: Tx, e: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId,
    actorType: e.actorType ?? (e.actorUserId ? "user" : "system"),
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    data: e.data ?? {},
    requestId: e.requestId ?? null,
  });
}
