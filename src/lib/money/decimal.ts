import DecimalJs from "decimal.js";

/**
 * Isolated Decimal constructor for all financial maths. Never use JS numbers
 * for money, quantities or unit prices.
 */
export const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 30 });
export type Decimal = InstanceType<typeof Decimal>;

export type RoundingMode = "half_even" | "half_up" | "half_down" | "up" | "down";

const MODE: Record<RoundingMode, DecimalJs.Rounding> = {
  half_even: DecimalJs.ROUND_HALF_EVEN,
  half_up: DecimalJs.ROUND_HALF_UP,
  half_down: DecimalJs.ROUND_HALF_DOWN,
  up: DecimalJs.ROUND_UP,
  down: DecimalJs.ROUND_DOWN,
};

const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal from a DB numeric string or validated user/CSV input.
 * Rejects JS numbers (to avoid float contamination), blanks, NaN and Infinity.
 */
export function dec(value: string | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value !== "string") throw new TypeError("dec() accepts strings or Decimal only");
  const s = value.trim();
  if (!NUMERIC_RE.test(s)) throw new RangeError(`Not a decimal: ${JSON.stringify(value)}`);
  return new Decimal(s);
}

/** Like dec() but returns null for null/undefined/blank. */
export function decOrNull(value: string | Decimal | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return dec(value);
}

export function isDecimalString(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

/** Round to `scale` decimal places using an explicit rounding mode. */
export function round(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  return value.toDecimalPlaces(scale, MODE[mode]);
}

/** Fixed-scale string suitable for NUMERIC columns and display. */
export function toFixed(value: Decimal, scale: number, mode: RoundingMode = "half_even"): string {
  return value.toFixed(scale, MODE[mode]);
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}

/** Minor-unit scale per ISO 4217 currency (defaults to 2). */
const CURRENCY_SCALE: Record<string, number> = { JPY: 0, KRW: 0, ISK: 0, CLP: 0, VND: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };
export function currencyScale(currency: string): number {
  return CURRENCY_SCALE[currency.toUpperCase()] ?? 2;
}

export function roundMoney(value: Decimal, currency: string, mode: RoundingMode): Decimal {
  return round(value, currencyScale(currency), mode);
}
