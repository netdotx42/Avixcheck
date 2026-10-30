import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(v: string) {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const isoDate = z.string().refine(validIsoDate, "must be a date (YYYY-MM-DD)");

/**
 * Report filters. Dates are inclusive and refer to the UTC day an invoice was
 * received in AvixCheck (`invoices.created_at`), not the printed invoice date,
 * which is extracted from an untrusted document and may be missing.
 */
export const reportFiltersSchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    supplierId: z.string().uuid().optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: "From must be on or before To", path: ["to"] });

export type ReportFilters = z.infer<typeof reportFiltersSchema>;

const blank = (v: unknown) => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
};

/** Parse filters from a query string; invalid input yields an error message instead of throwing. */
export function parseReportFilters(raw: Record<string, string | string[] | undefined>): { filters: ReportFilters; error?: string } {
  const res = reportFiltersSchema.safeParse({ from: blank(raw.from), to: blank(raw.to), supplierId: blank(raw.supplier) });
  if (res.success) return { filters: res.data };
  return { filters: {}, error: res.error.issues.map((i) => i.message).join("; ") };
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function isoDaysAgo(days: number, now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)).toISOString().slice(0, 10);
}
