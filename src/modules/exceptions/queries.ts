import { aliasedTable, and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  auditEvents,
  checkRuns,
  discrepancies,
  discrepancyTypeEnum,
  documents,
  exceptions,
  invoiceLines,
  invoices,
  memberships,
  poLines,
  priceAgreements,
  purchaseOrders,
  receipts,
  suppliers,
  users,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import type { ExceptionKind, ExceptionStatus } from "./rules";

export const PAGE_SIZE = 25;

export const STATUS_FILTERS = ["unresolved", "all", "open", "in_review", "accepted_variance", "correction_requested", "rejected_invoice", "dismissed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const KIND_FILTERS = ["extraction_review", "matching_review", "processing_failure"] as const;
export const TYPE_FILTERS = discrepancyTypeEnum.enumValues;

export interface ListFilters {
  q?: string;
  status?: StatusFilter;
  /** A discrepancy type or a non-discrepancy exception kind. */
  type?: string;
  /** "me", "unassigned" or a user id. */
  assignee?: string;
  supplierId?: string;
  page?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escape LIKE wildcards so search text is matched literally. */
function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function unresolvedSql(): SQL {
  return sql`(${exceptions.status} in ('open','in_review') or (${exceptions.status} = 'correction_requested' and ${exceptions.confirmedCorrectionAmount} is null))`;
}

export function buildWhere(f: ListFilters, currentUserId: string): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  const status = f.status ?? "unresolved";
  if (status === "unresolved") conds.push(unresolvedSql());
  else if (status !== "all") conds.push(eq(exceptions.status, status));
  if (f.type) {
    if ((TYPE_FILTERS as readonly string[]).includes(f.type)) conds.push(eq(discrepancies.type, f.type as (typeof TYPE_FILTERS)[number]));
    else if ((KIND_FILTERS as readonly string[]).includes(f.type)) conds.push(eq(exceptions.kind, f.type as ExceptionKind));
  }
  if (f.assignee === "me") conds.push(eq(exceptions.assigneeUserId, currentUserId));
  else if (f.assignee === "unassigned") conds.push(isNull(exceptions.assigneeUserId));
  else if (f.assignee && UUID_RE.test(f.assignee)) conds.push(eq(exceptions.assigneeUserId, f.assignee));
  if (f.supplierId && UUID_RE.test(f.supplierId)) conds.push(eq(invoices.supplierId, f.supplierId));
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const t = likeTerm(q);
    conds.push(or(ilike(exceptions.title, t), ilike(invoices.invoiceNumber, t), ilike(suppliers.name, t), ilike(invoices.supplierNameRaw, t), ilike(invoices.poNumberRaw, t)));
  }
  const present = conds.filter((c): c is SQL => !!c);
  return present.length ? and(...present) : undefined;
}

export async function listExceptions(orgId: string, currentUserId: string, f: ListFilters) {
  const page = f.page && f.page > 0 ? f.page : 1;
  const where = buildWhere(f, currentUserId);
  const assignee = aliasedTable(users, "assignee");
  return withTenant(orgId, async (tx) => {
    const base = tx
      .select({
        id: exceptions.id,
        title: exceptions.title,
        kind: exceptions.kind,
        status: exceptions.status,
        revision: exceptions.revision,
        createdAt: exceptions.createdAt,
        confirmedCorrectionAmount: exceptions.confirmedCorrectionAmount,
        assigneeUserId: exceptions.assigneeUserId,
        assigneeName: assignee.name,
        assigneeEmail: assignee.email,
        type: discrepancies.type,
        severity: discrepancies.severity,
        amount: discrepancies.amount,
        currency: discrepancies.currency,
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        supplierName: suppliers.name,
        supplierNameRaw: invoices.supplierNameRaw,
      })
      .from(exceptions)
      .innerJoin(invoices, eq(invoices.id, exceptions.invoiceId))
      .leftJoin(discrepancies, eq(discrepancies.id, exceptions.discrepancyId))
      .leftJoin(suppliers, eq(suppliers.id, invoices.supplierId))
      .leftJoin(assignee, eq(assignee.id, exceptions.assigneeUserId))
      .where(where);
    const rows = await base.orderBy(desc(exceptions.createdAt), asc(exceptions.id)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(exceptions)
      .innerJoin(invoices, eq(invoices.id, exceptions.invoiceId))
      .leftJoin(discrepancies, eq(discrepancies.id, exceptions.discrepancyId))
      .leftJoin(suppliers, eq(suppliers.id, invoices.supplierId))
      .where(where)) as [{ n: number }];
    return { rows, total: n, page, pageSize: PAGE_SIZE };
  });
}

/** Members who can be assigned exceptions, and the supplier list for filters. */
export async function listFilterOptions(orgId: string) {
  return withTenant(orgId, async (tx) => ({
    assignees: await tx
      .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, orgId), inArray(memberships.role, ["admin", "reviewer"])))
      .orderBy(users.email),
    suppliers: await tx.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(suppliers.name).limit(500),
  }));
}

export interface Reference {
  label: string;
  value: string;
}

/** Discrepancy `references` is free-form JSON written by the engine; render it defensively. */
export function normaliseReferences(raw: unknown): Reference[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((r): Reference[] => {
    if (typeof r === "string") return [{ label: "Reference", value: r }];
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const label = String(o.label ?? o.type ?? o.kind ?? "Reference");
    const parts = ["ref", "number", "id", "version"].filter((k) => o[k] !== undefined && o[k] !== null).map((k) => (k === "version" ? `v${String(o[k])}` : String(o[k])));
    return [{ label, value: parts.join(" · ") || JSON.stringify(o).slice(0, 200) }];
  });
}

export async function getExceptionDetail(orgId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const assignee = aliasedTable(users, "assignee");
  const decider = aliasedTable(users, "decider");
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({
        e: exceptions,
        assigneeName: assignee.name,
        assigneeEmail: assignee.email,
        deciderName: decider.name,
        deciderEmail: decider.email,
        d: discrepancies,
        run: checkRuns,
        invoice: invoices,
        supplierName: suppliers.name,
        supplierCode: suppliers.code,
        document: { id: documents.id, storageKey: documents.storageKey, scanStatus: documents.scanStatus, originalName: documents.originalName, deletedAt: documents.deletedAt },
      })
      .from(exceptions)
      .innerJoin(invoices, eq(invoices.id, exceptions.invoiceId))
      .innerJoin(documents, eq(documents.id, invoices.documentId))
      .leftJoin(discrepancies, eq(discrepancies.id, exceptions.discrepancyId))
      .leftJoin(checkRuns, eq(checkRuns.id, discrepancies.checkRunId))
      .leftJoin(suppliers, eq(suppliers.id, invoices.supplierId))
      .leftJoin(assignee, eq(assignee.id, exceptions.assigneeUserId))
      .leftJoin(decider, eq(decider.id, exceptions.decidedBy))
      .where(eq(exceptions.id, id));
    if (!row) return null;

    const lineId = row.d?.invoiceLineId ?? null;
    const [line] = lineId ? await tx.select().from(invoiceLines).where(eq(invoiceLines.id, lineId)) : [];
    const [poLine] = line?.matchedPoLineId
      ? await tx
          .select({ l: poLines, poNumber: purchaseOrders.poNumber, poVersion: purchaseOrders.version, poId: purchaseOrders.id })
          .from(poLines)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, poLines.poId))
          .where(eq(poLines.id, line.matchedPoLineId))
      : [];
    const [agreement] = line?.matchedAgreementId ? await tx.select().from(priceAgreements).where(eq(priceAgreements.id, line.matchedAgreementId)) : [];
    const receiptRows = line?.matchedPoLineId ? await tx.select().from(receipts).where(eq(receipts.poLineId, line.matchedPoLineId)).orderBy(asc(receipts.receivedOn)) : [];
    const history = await tx
      .select({ id: auditEvents.id, action: auditEvents.action, data: auditEvents.data, createdAt: auditEvents.createdAt, actorType: auditEvents.actorType, actorName: users.name, actorEmail: users.email })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.entityType, "exception"), eq(auditEvents.entityId, id)))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(100);
    return {
      ...row,
      kind: row.e.kind as ExceptionKind,
      status: row.e.status as ExceptionStatus,
      line: line ?? null,
      poLine: poLine ?? null,
      agreement: agreement ?? null,
      receipts: receiptRows,
      references: normaliseReferences(row.d?.references),
      history,
    };
  });
}

export type ExceptionDetail = NonNullable<Awaited<ReturnType<typeof getExceptionDetail>>>;
