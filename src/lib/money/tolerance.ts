import { Decimal, dec } from "./decimal";

export interface Tolerance {
  /** Absolute tolerance in currency units (or quantity units). */
  absolute: string;
  /** Percentage tolerance, e.g. "1.0" = 1%. */
  percent: string;
}

/**
 * True when |actual - expected| is within tolerance. A difference passes if it is
 * within EITHER the absolute OR the percentage limit (the more lenient applies).
 * Set both to "0" for exact matching.
 */
export function withinTolerance(expected: Decimal, actual: Decimal, tol: Tolerance): boolean {
  const diff = actual.minus(expected).abs();
  if (diff.lte(dec(tol.absolute))) return true;
  if (expected.isZero()) return diff.isZero();
  const pctLimit = expected.abs().times(dec(tol.percent)).div(100);
  return diff.lte(pctLimit);
}

export function exceedsUpward(expected: Decimal, actual: Decimal, tol: Tolerance): boolean {
  return actual.gt(expected) && !withinTolerance(expected, actual, tol);
}

export { Decimal };
