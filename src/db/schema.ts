import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Conventions
 * - Every tenant-owned table has `org_id` and is protected by row-level
 *   security (see drizzle/0001_security.sql). Queries must run inside
 *   `withTenant()` so `app.org_id` is set.
 * - Money and quantities are NUMERIC and handled with decimal.js in code.
 *   Amounts: numeric(20,4). Unit prices: numeric(20,6). Quantities: numeric(20,4).
 * - Never store floats for financial values.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 20, scale: 4 });
const unitPrice = (name: string) => numeric(name, { precision: 20, scale: 6 });
const qty = (name: string) => numeric(name, { precision: 20, scale: 4 });

export const roleEnum = pgEnum("member_role", ["admin", "reviewer", "viewer"]);

// ───────────────────────────── Identity & tenancy ─────────────────────────────

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Demo organisations hold synthetic data only and are excluded from production reporting. */
  isDemo: boolean("is_demo").notNull().default(false),
  baseCurrency: text("base_currency").notNull().default("GBP"),
  /** See `OrgSettings` in src/lib/org-settings.ts (tolerances, rounding, retention). */
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  /** Subject from the managed auth provider (e.g. Clerk user id) or `dev:<email>` locally. */
  authSubject: text("auth_subject").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId), index("memberships_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: orgId(),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    /** sha256 of the invitation token; the raw token is shown once. */
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").notNull().references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_org_idx").on(t.orgId)],
);

/** Append-only. UPDATE/DELETE are rejected by a trigger. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: orgId(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    /** `system` for worker actions, `user` for people. */
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_entity_idx").on(t.orgId, t.entityType, t.entityId), index("audit_org_created_idx").on(t.orgId, t.createdAt)],
);

// ───────────────────────────── Reference data ─────────────────────────────

export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    orgId: orgId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    taxId: text("tax_id"),
    currency: text("currency"),
    /** Alternative names seen on invoices, used for matching. */
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    active: boolean("active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("suppliers_org_code_uq").on(t.orgId, t.code)],
);

export const poStatusEnum = pgEnum("po_status", ["open", "closed", "cancelled"]);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    orgId: orgId(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    poNumber: text("po_number").notNull(),
    currency: text("currency").notNull(),
    status: poStatusEnum("status").notNull().default("open"),
    issuedOn: date("issued_on"),
    /** Incremented on every amendment; prior state is kept in po_revisions. */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("po_org_number_uq").on(t.orgId, t.poNumber), index("po_supplier_idx").on(t.orgId, t.supplierId)],
);

export const poLines = pgTable(
  "po_lines",
  {
    id: id(),
    orgId: orgId(),
    poId: uuid("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    sku: text("sku"),
    description: text("description").notNull(),
    quantity: qty("quantity").notNull(),
    unit: text("unit").notNull(),
    unitPrice: unitPrice("unit_price").notNull(),
    cancelled: boolean("cancelled").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("po_lines_po_line_uq").on(t.poId, t.lineNo)],
);

/** Snapshot of a PO (header + lines) before each amendment. */
export const poRevisions = pgTable(
  "po_revisions",
  {
    id: id(),
    orgId: orgId(),
    poId: uuid("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("po_revisions_po_version_uq").on(t.poId, t.version)],
);

export const priceAgreements = pgTable(
  "price_agreements",
  {
    id: id(),
    orgId: orgId(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    agreementRef: text("agreement_ref").notNull(),
    sku: text("sku").notNull(),
    description: text("description"),
    unitPrice: unitPrice("unit_price").notNull(),
    currency: text("currency").notNull(),
    unit: text("unit").notNull(),
    /** Percentage, e.g. 2.5000 = 2.5%. */
    discountPct: numeric("discount_pct", { precision: 9, scale: 4 }).notNull().default("0"),
    minQuantity: qty("min_quantity"),
    validFrom: date("valid_from").notNull(),
    /** Inclusive. Null = open-ended. */
    validTo: date("valid_to"),
    version: integer("version").notNull().default(1),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("agreements_lookup_idx").on(t.orgId, t.supplierId, t.sku, t.validFrom)],
);

/** Non-goods charges (freight, handling, ...) a supplier is allowed to bill. */
export const approvedCharges = pgTable(
  "approved_charges",
  {
    id: id(),
    orgId: orgId(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    chargeType: text("charge_type").notNull(),
    maxAmount: money("max_amount"),
    currency: text("currency").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    /** Charges are versioned like agreements: a changed row supersedes, never overwrites. */
    version: integer("version").notNull().default(1),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("approved_charges_lookup_idx").on(t.orgId, t.supplierId, t.chargeType)],
);

/** Goods receipts. Receipt checks run only when receipts exist for a PO line. */
export const receipts = pgTable(
  "receipts",
  {
    id: id(),
    orgId: orgId(),
    poLineId: uuid("po_line_id").notNull().references(() => poLines.id),
    receiptRef: text("receipt_ref").notNull(),
    quantity: qty("quantity").notNull(),
    receivedOn: date("received_on").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("receipts_org_ref_line_uq").on(t.orgId, t.receiptRef, t.poLineId)],
);

// ───────────────────────────── Imports ─────────────────────────────

export const importKindEnum = pgEnum("import_kind", ["suppliers", "purchase_orders", "price_agreements", "approved_charges", "receipts"]);
export const importStatusEnum = pgEnum("import_status", ["previewed", "committing", "committed", "failed", "discarded"]);

export const importBatches = pgTable(
  "import_batches",
  {
    id: id(),
    orgId: orgId(),
    kind: importKindEnum("kind").notNull(),
    status: importStatusEnum("status").notNull().default("previewed"),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    committedBy: uuid("committed_by").references(() => users.id),
    /** Counts per action (create/update/unchanged/...) computed at preview and at commit. */
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("import_batches_org_idx").on(t.orgId, t.createdAt), index("import_batches_org_sha_idx").on(t.orgId, t.kind, t.fileSha256)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    orgId: orgId(),
    batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").notNull(),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    action: text("action"),
  },
  (t) => [uniqueIndex("import_rows_batch_row_uq").on(t.batchId, t.rowNumber)],
);

// ───────────────────────────── Documents & invoices ─────────────────────────────

export const scanStatusEnum = pgEnum("scan_status", ["pending", "clean", "infected", "error"]);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: orgId(),
    storageKey: text("storage_key").notNull().unique(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mimeType: text("mime_type").notNull(),
    originalName: text("original_name").notNull(),
    scanStatus: scanStatusEnum("scan_status").notNull().default("pending"),
    scanDetail: text("scan_detail"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    retainUntil: date("retain_until"),
    legalHold: boolean("legal_hold").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("documents_org_sha_uq").on(t.orgId, t.sha256)],
);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "uploaded",
  "scanning",
  "quarantined",
  "extracting",
  "extraction_review",
  "matching",
  "matching_review",
  "checking",
  "exceptions_open",
  "passed",
  "failed",
  "rejected",
]);
export const invoiceKindEnum = pgEnum("invoice_kind", ["invoice", "credit_note"]);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: orgId(),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    status: invoiceStatusEnum("status").notNull().default("uploaded"),
    kind: invoiceKindEnum("kind").notNull().default("invoice"),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    /** Supplier name exactly as printed; untrusted. */
    supplierNameRaw: text("supplier_name_raw"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    currency: text("currency"),
    poNumberRaw: text("po_number_raw"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    /** For credit notes: the invoice being credited, when known. */
    creditsInvoiceId: uuid("credits_invoice_id"),
    subtotal: money("subtotal"),
    taxTotal: money("tax_total"),
    total: money("total"),
    extractionConfidence: numeric("extraction_confidence", { precision: 5, scale: 4 }),
    extractionModel: text("extraction_model"),
    /** Raw model output, stored for audit; never trusted without validation. */
    extractionRaw: jsonb("extraction_raw"),
    failureReason: text("failure_reason"),
    /** Optimistic concurrency for edits. */
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_org_status_idx").on(t.orgId, t.status),
    index("invoices_org_supplier_number_idx").on(t.orgId, t.supplierId, t.invoiceNumber),
    index("invoices_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export const lineTypeEnum = pgEnum("invoice_line_type", ["goods", "charge", "discount"]);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    lineType: lineTypeEnum("line_type").notNull().default("goods"),
    chargeType: text("charge_type"),
    sku: text("sku"),
    description: text("description"),
    quantity: qty("quantity"),
    unit: text("unit"),
    unitPrice: unitPrice("unit_price"),
    amount: money("amount"),
    taxRate: numeric("tax_rate", { precision: 9, scale: 4 }),
    poLineRef: text("po_line_ref"),
    matchedPoLineId: uuid("matched_po_line_id").references(() => poLines.id),
    matchedAgreementId: uuid("matched_agreement_id").references(() => priceAgreements.id),
    matchConfidence: numeric("match_confidence", { precision: 5, scale: 4 }),
    extractionConfidence: numeric("extraction_confidence", { precision: 5, scale: 4 }),
    /** True when a person corrected extracted values. */
    manuallyCorrected: boolean("manually_corrected").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("invoice_lines_invoice_line_uq").on(t.invoiceId, t.lineNo)],
);

// ───────────────────────────── Checks, discrepancies, exceptions ─────────────────────────────

export const checkStatusEnum = pgEnum("check_status", ["running", "completed", "failed", "superseded"]);

export const checkRuns = pgTable(
  "check_runs",
  {
    id: id(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    status: checkStatusEnum("status").notNull().default("running"),
    /** Version of the deterministic rule engine, e.g. "rules@1.0.0". */
    ruleSetVersion: text("rule_set_version").notNull(),
    /** Tolerances and rounding settings in force for this run. */
    settingsSnapshot: jsonb("settings_snapshot").notNull(),
    /** Exact reference rows (with versions) the run used. */
    referenceSnapshot: jsonb("reference_snapshot").notNull(),
    /** Invoice revision checked. */
    invoiceRevision: integer("invoice_revision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [uniqueIndex("check_runs_org_idem_uq").on(t.orgId, t.idempotencyKey), index("check_runs_invoice_idx").on(t.invoiceId)],
);

export const discrepancyTypeEnum = pgEnum("discrepancy_type", [
  "price_variance",
  "quantity_excess",
  "receipt_quantity_exceeded",
  "duplicate_invoice",
  "missing_discount",
  "unapproved_charge",
  "arithmetic_error",
  "currency_mismatch",
  "unit_mismatch",
  "po_balance_exceeded",
  "missing_reference",
  "conflicting_reference",
  "missing_data",
]);

export const discrepancies = pgTable(
  "discrepancies",
  {
    id: id(),
    orgId: orgId(),
    checkRunId: uuid("check_run_id").notNull().references(() => checkRuns.id),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    invoiceLineId: uuid("invoice_line_id").references(() => invoiceLines.id),
    type: discrepancyTypeEnum("type").notNull(),
    severity: text("severity").notNull(),
    expectedValue: text("expected_value"),
    actualValue: text("actual_value"),
    /** Potential exposure (not realised savings). */
    amount: money("amount"),
    currency: text("currency"),
    explanation: text("explanation").notNull(),
    references: jsonb("references").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("discrepancies_invoice_idx").on(t.orgId, t.invoiceId), index("discrepancies_run_idx").on(t.checkRunId)],
);

export const exceptionKindEnum = pgEnum("exception_kind", ["discrepancy", "extraction_review", "matching_review", "processing_failure"]);
export const exceptionStatusEnum = pgEnum("exception_status", ["open", "in_review", "accepted_variance", "correction_requested", "rejected_invoice", "dismissed"]);

export const exceptions = pgTable(
  "exceptions",
  {
    id: id(),
    orgId: orgId(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    discrepancyId: uuid("discrepancy_id").references(() => discrepancies.id),
    kind: exceptionKindEnum("kind").notNull(),
    status: exceptionStatusEnum("status").notNull().default("open"),
    title: text("title").notNull(),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    decisionReason: text("decision_reason"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Realised savings: set only when a supplier correction is confirmed. */
    confirmedCorrectionAmount: money("confirmed_correction_amount"),
    confirmedCorrectionRef: text("confirmed_correction_ref"),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("exceptions_org_status_idx").on(t.orgId, t.status),
    index("exceptions_assignee_idx").on(t.orgId, t.assigneeUserId),
    uniqueIndex("exceptions_discrepancy_uq").on(t.discrepancyId),
  ],
);

/**
 * Ledger of quantities/amounts billed against PO lines. The unique constraint on
 * (invoice_line_id, check_run_id) prevents double counting on retries; only
 * rows whose run is the invoice's current run count toward balances.
 */
export const poLineBillings = pgTable(
  "po_line_billings",
  {
    id: id(),
    orgId: orgId(),
    poLineId: uuid("po_line_id").notNull().references(() => poLines.id),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    invoiceLineId: uuid("invoice_line_id").notNull().references(() => invoiceLines.id),
    checkRunId: uuid("check_run_id").notNull().references(() => checkRuns.id),
    /** Negative for credit notes. */
    quantity: qty("quantity").notNull(),
    amount: money("amount").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("po_line_billings_line_run_uq").on(t.invoiceLineId, t.checkRunId), index("po_line_billings_po_line_idx").on(t.orgId, t.poLineId)],
);

// ───────────────────────────── Jobs, exports, ops ─────────────────────────────

export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    /** Null only for system-wide maintenance jobs. */
    orgId: uuid("org_id").references(() => organizations.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    result: jsonb("result"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_type_idem_uq").on(t.type, t.idempotencyKey),
    index("jobs_claim_idx").on(t.status, t.runAfter),
    index("jobs_org_idx").on(t.orgId, t.createdAt),
  ],
);

export const exportStatusEnum = pgEnum("export_status", ["queued", "ready", "failed", "expired"]);

export const exportsTable = pgTable(
  "exports",
  {
    id: id(),
    orgId: orgId(),
    kind: text("kind").notNull(),
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    status: exportStatusEnum("status").notNull().default("queued"),
    storageKey: text("storage_key"),
    rowCount: integer("row_count"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("exports_org_idx").on(t.orgId, t.createdAt)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});
