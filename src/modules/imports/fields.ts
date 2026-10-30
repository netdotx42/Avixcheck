import { z } from "zod";
import { isDecimalString } from "@/lib/money/decimal";
import { dec } from "@/lib/money/decimal";

/**
 * Field validators for CSV rows. Inputs are already-trimmed strings; blank
 * means "not provided". Financial values stay strings (never JS numbers) and
 * are rejected, not rounded, when they exceed the column's precision.
 */

const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export const text = (max = 200) => z.string().min(1, "Required").max(max, `At most ${max} characters`);
export const optionalText = (max = 500) =>
  z
    .string()
    .max(max, `At most ${max} characters`)
    .transform((v) => (v === "" ? null : v));

export const code = (max = 64) =>
  text(max).regex(/^[\p{L}\p{N}][\p{L}\p{N}._\-/ ]*$/u, "Use letters, numbers, spaces, dot, dash, underscore or slash");

export const currency = () =>
  z
    .string()
    .min(1, "Required")
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{3}$/.test(v) && CURRENCIES.has(v), "Must be an ISO 4217 currency code such as GBP");

export const optionalCurrency = () =>
  z
    .string()
    .transform((v) => (v === "" ? null : v.toUpperCase()))
    .refine((v) => v === null || (/^[A-Z]{3}$/.test(v) && CURRENCIES.has(v)), "Must be an ISO 4217 currency code such as GBP");

function isRealDate(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const isoDate = () => z.string().min(1, "Required").refine(isRealDate, "Must be a date in YYYY-MM-DD format");
export const optionalIsoDate = () =>
  z
    .string()
    .refine((v) => v === "" || isRealDate(v), "Must be a date in YYYY-MM-DD format")
    .transform((v) => (v === "" ? null : v));

interface DecimalOpts {
  /** Digits allowed after the decimal point (column scale). */
  scale: number;
  /** Total digits allowed (column precision). */
  precision?: number;
  min?: string;
  minExclusive?: boolean;
  max?: string;
  maxExclusive?: boolean;
}

function decimalIssue(v: string, o: DecimalOpts): string | null {
  if (!isDecimalString(v) || /e/i.test(v)) return "Must be a plain number such as 12.50 (no currency symbols or thousands separators)";
  const d = dec(v);
  const [intPart, frac = ""] = d.abs().toFixed().split(".");
  if (frac.replace(/0+$/, "").length > o.scale) return `At most ${o.scale} decimal places`;
  if (intPart!.replace(/^0+/, "").length > (o.precision ?? 20) - o.scale) return "Number is too large";
  if (o.min !== undefined && (o.minExclusive ? d.lte(o.min) : d.lt(o.min))) return o.minExclusive ? `Must be greater than ${o.min}` : `Must be at least ${o.min}`;
  if (o.max !== undefined && (o.maxExclusive ? d.gte(o.max) : d.gt(o.max))) return o.maxExclusive ? `Must be less than ${o.max}` : `Must be at most ${o.max}`;
  return null;
}

/** Decimal string normalised to a canonical form (no leading "+", no exponent). */
export const decimal = (o: DecimalOpts) =>
  z
    .string()
    .min(1, "Required")
    .superRefine((v, ctx) => {
      const issue = decimalIssue(v, o);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    })
    .transform((v) => dec(v).toFixed());

export const optionalDecimal = (o: DecimalOpts) =>
  z
    .string()
    .superRefine((v, ctx) => {
      if (v === "") return;
      const issue = decimalIssue(v, o);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    })
    .transform((v) => (v === "" ? null : dec(v).toFixed()));

export const positiveInt = () =>
  z
    .string()
    .min(1, "Required")
    .regex(/^\d{1,6}$/, "Must be a whole number")
    .transform((v) => Number(v))
    .refine((n) => n >= 1, "Must be 1 or more");

export interface RowError {
  field?: string;
  message: string;
  /** "csv" for structural problems found by the parser (they never change on re-validation). */
  source?: "csv";
}

/** Validate a raw row against a zod object schema; map issues to per-field errors. */
export function validateRow<S extends z.ZodType>(schema: S, data: Record<string, string>): { value: z.infer<S> | null; errors: RowError[] } {
  const r = schema.safeParse(data);
  if (r.success) return { value: r.data, errors: [] };
  return {
    value: null,
    errors: r.error.issues.map((i) => ({ field: i.path.length ? String(i.path[0]) : undefined, message: i.message })),
  };
}

/** Equality for NUMERIC values regardless of trailing zeros ("0.42" == "0.420000"). */
export function decEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return dec(a).eq(dec(b));
}

/** Inclusive date ranges; null end = open-ended. ISO strings compare lexically. */
export function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  return (bTo === null || aFrom <= bTo) && (aTo === null || bFrom <= aTo);
}
