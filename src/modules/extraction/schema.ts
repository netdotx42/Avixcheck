import { z } from "zod";
import { dec, isDecimalString } from "@/lib/money/decimal";

/** Bumped when the prompt, output schema or normalisation rules change. Stored with every extraction. */
export const EXTRACTION_SCHEMA_VERSION = "extraction@1.0.0";

const nullableString = { type: ["string", "null"] } as const;
const field = {
  type: "object",
  properties: { value: nullableString, confidence: { type: "number" } },
  required: ["value", "confidence"],
  additionalProperties: false,
} as const;

/** JSON schema sent to the model as the structured output format. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    document_type: { type: "string", enum: ["invoice", "credit_note", "not_an_invoice"] },
    supplier_name: field,
    supplier_tax_id: field,
    invoice_number: field,
    invoice_date: field,
    due_date: field,
    currency: field,
    po_number: field,
    credited_invoice_number: field,
    subtotal: field,
    tax_total: field,
    total: field,
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_type: { type: "string", enum: ["goods", "charge", "discount"] },
          charge_type: nullableString,
          sku: nullableString,
          description: nullableString,
          quantity: nullableString,
          unit: nullableString,
          unit_price: nullableString,
          amount: nullableString,
          tax_rate: nullableString,
          po_line_ref: nullableString,
          confidence: { type: "number" },
        },
        required: ["line_type", "charge_type", "sku", "description", "quantity", "unit", "unit_price", "amount", "tax_rate", "po_line_ref", "confidence"],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "document_type",
    "supplier_name",
    "supplier_tax_id",
    "invoice_number",
    "invoice_date",
    "due_date",
    "currency",
    "po_number",
    "credited_invoice_number",
    "subtotal",
    "tax_total",
    "total",
    "lines",
    "warnings",
  ],
  additionalProperties: false,
} as const;

// ───────────── Validation of the (untrusted) model output ─────────────

const MAX_TEXT = 500;
const confidence = z.number().finite().min(0).max(1);
const rawField = z.object({ value: z.string().nullable(), confidence });
const rawLine = z.object({
  line_type: z.enum(["goods", "charge", "discount"]),
  charge_type: z.string().nullable(),
  sku: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  unit_price: z.string().nullable(),
  amount: z.string().nullable(),
  tax_rate: z.string().nullable(),
  po_line_ref: z.string().nullable(),
  confidence,
});
export const rawExtractionSchema = z.object({
  document_type: z.enum(["invoice", "credit_note", "not_an_invoice"]),
  supplier_name: rawField,
  supplier_tax_id: rawField,
  invoice_number: rawField,
  invoice_date: rawField,
  due_date: rawField,
  currency: rawField,
  po_number: rawField,
  credited_invoice_number: rawField,
  subtotal: rawField,
  tax_total: rawField,
  total: rawField,
  lines: z.array(rawLine).max(500),
  warnings: z.array(z.string()).max(50),
});
export type RawExtraction = z.infer<typeof rawExtractionSchema>;

export interface NormalizedHeader {
  kind: "invoice" | "credit_note";
  supplierNameRaw: string | null;
  supplierTaxId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  poNumberRaw: string | null;
  creditedInvoiceNumber: string | null;
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
}

export interface NormalizedLine {
  lineNo: number;
  lineType: "goods" | "charge" | "discount";
  chargeType: string | null;
  sku: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string | null;
  taxRate: string | null;
  poLineRef: string | null;
  extractionConfidence: string;
}

export interface NormalizedExtraction {
  header: NormalizedHeader;
  lines: NormalizedLine[];
  /** Overall confidence: the minimum over required header fields and all lines. */
  confidence: string;
  /** Reasons this extraction must be reviewed by a person. Empty means it may proceed to matching. */
  issues: string[];
  warnings: string[];
}

/** Strip control characters and collapse whitespace; cap length. Text is displayed, never interpreted. */
export function cleanText(v: string | null | undefined, max = MAX_TEXT): string | null {
  if (v === null || v === undefined) return null;
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * Parse a decimal written by the model. Accepts plain decimals and removes
 * thousands separators only when unambiguous (`1,234.50`). Returns null and an
 * issue for anything else; never guesses.
 */
export function parseDecimalField(v: string | null, maxScale: number): { value: string | null; issue?: string } {
  const s = cleanText(v, 64);
  if (s === null) return { value: null };
  let t = s.replace(/\s/g, "");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (/^\(\d+(\.\d+)?\)$/.test(t)) t = `-${t.slice(1, -1)}`;
  if (!isDecimalString(t)) return { value: null, issue: `not a plain decimal: ${JSON.stringify(s)}` };
  const d = dec(t);
  if (d.decimalPlaces() > maxScale) return { value: null, issue: `more than ${maxScale} decimal places: ${s}` };
  if (d.abs().greaterThanOrEqualTo("1e15")) return { value: null, issue: `value out of range: ${s}` };
  return { value: d.toFixed() };
}

export function parseIsoDate(v: string | null): { value: string | null; issue?: string } {
  const s = cleanText(v, 32);
  if (s === null) return { value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { value: null, issue: `not an ISO date: ${JSON.stringify(s)}` };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return { value: null, issue: `invalid calendar date: ${s}` };
  }
  if (Number(m[1]) < 1990 || Number(m[1]) > 2100) return { value: null, issue: `implausible year: ${s}` };
  return { value: s };
}

export function parseCurrency(v: string | null): { value: string | null; issue?: string } {
  const s = cleanText(v, 16);
  if (s === null) return { value: null };
  const up = s.toUpperCase();
  if (!/^[A-Z]{3}$/.test(up)) return { value: null, issue: `not an ISO 4217 code: ${JSON.stringify(s)}` };
  return { value: up };
}

const conf = (n: number) => n.toFixed(4);

/**
 * Turn raw model output into invoice fields. Every rule here is deterministic.
 * `minConfidence` comes from org settings (review.minExtractionConfidence).
 */
export function normalizeExtraction(raw: unknown, minConfidence: string): { ok: true; result: NormalizedExtraction } | { ok: false; issues: string[] } {
  const parsed = rawExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.slice(0, 10).map((i) => `output schema: ${i.path.join(".") || "(root)"} ${i.message}`) };
  }
  const r = parsed.data;
  const issues: string[] = [];
  const fieldIssue = (name: string, res: { value: string | null; issue?: string }) => {
    if (res.issue) issues.push(`${name}: ${res.issue}`);
    return res.value;
  };

  if (r.document_type === "not_an_invoice") issues.push("The document does not look like an invoice or credit note.");

  const header: NormalizedHeader = {
    kind: r.document_type === "credit_note" ? "credit_note" : "invoice",
    supplierNameRaw: cleanText(r.supplier_name.value),
    supplierTaxId: cleanText(r.supplier_tax_id.value, 64),
    invoiceNumber: cleanText(r.invoice_number.value, 100),
    invoiceDate: fieldIssue("invoice_date", parseIsoDate(r.invoice_date.value)),
    dueDate: fieldIssue("due_date", parseIsoDate(r.due_date.value)),
    currency: fieldIssue("currency", parseCurrency(r.currency.value)),
    poNumberRaw: cleanText(r.po_number.value, 100),
    creditedInvoiceNumber: cleanText(r.credited_invoice_number.value, 100),
    subtotal: fieldIssue("subtotal", parseDecimalField(r.subtotal.value, 4)),
    taxTotal: fieldIssue("tax_total", parseDecimalField(r.tax_total.value, 4)),
    total: fieldIssue("total", parseDecimalField(r.total.value, 4)),
  };

  const required: [string, string | null, number][] = [
    ["supplier name", header.supplierNameRaw, r.supplier_name.confidence],
    ["invoice number", header.invoiceNumber, r.invoice_number.confidence],
    ["invoice date", header.invoiceDate, r.invoice_date.confidence],
    ["currency", header.currency, r.currency.confidence],
    ["total", header.total, r.total.confidence],
  ];
  for (const [name, value] of required) if (value === null) issues.push(`Missing required field: ${name}.`);

  const lines: NormalizedLine[] = r.lines.map((l, i) => {
    const n = i + 1;
    const line: NormalizedLine = {
      lineNo: n,
      lineType: l.line_type,
      chargeType: cleanText(l.charge_type, 100),
      sku: cleanText(l.sku, 100),
      description: cleanText(l.description),
      quantity: fieldIssue(`line ${n} quantity`, parseDecimalField(l.quantity, 4)),
      unit: cleanText(l.unit, 32),
      unitPrice: fieldIssue(`line ${n} unit_price`, parseDecimalField(l.unit_price, 6)),
      amount: fieldIssue(`line ${n} amount`, parseDecimalField(l.amount, 4)),
      taxRate: fieldIssue(`line ${n} tax_rate`, parseDecimalField(l.tax_rate, 4)),
      poLineRef: cleanText(l.po_line_ref, 100),
      extractionConfidence: conf(l.confidence),
    };
    if (line.amount === null) issues.push(`Line ${n}: missing amount.`);
    if (line.lineType === "goods" && (line.quantity === null || line.unitPrice === null)) issues.push(`Line ${n}: missing quantity or unit price.`);
    if (!line.description && !line.sku) issues.push(`Line ${n}: no description or SKU.`);
    return line;
  });
  if (lines.length === 0) issues.push("No line items were found.");

  const confidences = [...required.map(([, , c]) => c), ...r.lines.map((l) => l.confidence)];
  const overall = Math.min(...confidences);
  if (dec(conf(overall)).lessThan(dec(minConfidence))) {
    const low = [...required.filter(([, , c]) => c < Number(minConfidence)).map(([name]) => name), ...r.lines.flatMap((l, i) => (l.confidence < Number(minConfidence) ? [`line ${i + 1}`] : []))];
    issues.push(`Low extraction confidence (${conf(overall)} < ${minConfidence}) on: ${low.join(", ")}.`);
  }

  const warnings = r.warnings.map((w) => cleanText(w, 300)).filter((w): w is string => !!w).slice(0, 20);
  // Anything the extractor itself was unsure about (illegible text, handwritten edits, embedded instructions) goes to a person.
  if (warnings.length > 0) issues.push(`The extractor reported ${warnings.length} warning${warnings.length === 1 ? "" : "s"}; see details.`);
  return { ok: true, result: { header, lines, confidence: conf(overall), issues, warnings } };
}
