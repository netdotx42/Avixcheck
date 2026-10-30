/**
 * Normalisation for comparing untrusted invoice text against reference data.
 * Pure functions; no I/O.
 */

/** Uppercase alphanumerics only: "GB 123-456 789" -> "GB123456789". */
export function normId(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const COMPANY_SUFFIXES = new Set(["LTD", "LIMITED", "PLC", "LLC", "INC", "CO", "CORP", "CORPORATION", "GMBH", "SA", "SAS", "BV", "AG", "LLP", "THE"]);

/** Lowercased words without punctuation or legal suffixes: "The ACME Ltd." -> "acme". */
export function normName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !COMPANY_SUFFIXES.has(w))
    .join(" ")
    .toLowerCase();
}

const UNIT_SYNONYMS: Record<string, string> = {
  ea: "each",
  each: "each",
  unit: "each",
  units: "each",
  pc: "each",
  pcs: "each",
  piece: "each",
  pieces: "each",
  no: "each",
  nr: "each",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  h: "hour",
  kg: "kg",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  l: "litre",
  ltr: "litre",
  litre: "litre",
  litres: "litre",
  liter: "litre",
  liters: "litre",
  m: "metre",
  metre: "metre",
  metres: "metre",
  meter: "metre",
  meters: "metre",
  box: "box",
  boxes: "box",
  bx: "box",
  case: "case",
  cases: "case",
  cs: "case",
  pack: "pack",
  packs: "pack",
  pk: "pack",
};

/** Canonical unit of measure; unknown units are compared case/space-insensitively. */
export function normUnit(value: string | null | undefined): string {
  const u = (value ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ");
  return UNIT_SYNONYMS[u] ?? u;
}

export function normCurrency(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/** Sørensen–Dice coefficient over character bigrams of normalised names (0..1). */
export function similarity(a: string, b: string): number {
  const x = normName(a).replace(/\s+/g, " ");
  const y = normName(b).replace(/\s+/g, " ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/**
 * Extract a PO line number from a reference printed on the invoice line:
 * "3", "L3", "PO-1001/3", "PO1001-03" -> 3. Returns null when none is present.
 */
export function parseLineRef(ref: string | null | undefined): number | null {
  const m = (ref ?? "").trim().match(/(\d{1,5})\s*$/);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
