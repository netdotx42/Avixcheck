import { dec, currencyScale } from "./money/decimal";

/** Display a NUMERIC string as money without converting through floats. */
export function formatMoney(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const cur = (currency ?? "").toUpperCase();
  const scale = /^[A-Z]{3}$/.test(cur) ? currencyScale(cur) : 2;
  const fixed = dec(amount).toFixed(scale);
  const [int, frac] = fixed.replace("-", "").split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = fixed.startsWith("-") ? "−" : "";
  return `${sign}${cur ? `${cur} ` : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

export function formatAmounts(list: { currency: string; amount: string }[]): string {
  if (list.length === 0) return formatMoney("0", "");
  return list.map((a) => formatMoney(a.amount, a.currency)).join(" · ");
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
