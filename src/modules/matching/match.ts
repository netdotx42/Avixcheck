import { dec } from "@/lib/money/decimal";
import { RULE_SET_VERSION } from "../checks/version";
import { normCurrency, normId, normName, normUnit, parseLineRef, similarity } from "./normalize";
import type {
  AgreementRef,
  Candidate,
  InvoiceHeaderInput,
  InvoiceLineInput,
  LineMatch,
  MatchResult,
  PoLineRef,
  PoRef,
  RefMatch,
  SupplierRef,
} from "./types";

/**
 * Deterministic matcher: invoice -> supplier, purchase order, PO lines and
 * dated price agreements. Pure (no I/O); the caller loads reference data.
 *
 * It never guesses silently: a unique weak candidate is `low_confidence`
 * (routes to review), several candidates or disagreeing references are
 * `conflicting`, nothing is `missing`. Only `matched`/`manual` are trusted.
 */
export interface MatchInput {
  revision: number;
  header: InvoiceHeaderInput;
  lines: InvoiceLineInput[];
  suppliers: SupplierRef[];
  purchaseOrders: PoRef[];
  /** PO lines of every PO in `purchaseOrders`. */
  poLines: PoLineRef[];
  /** Agreements of the candidate supplier(s). */
  agreements: AgreementRef[];
  /** Organisation threshold, e.g. "0.90". */
  minConfidence: string;
  now?: Date;
}

const conf = (n: number) => n.toFixed(4);

function ref(status: RefMatch["status"], reason: string, pick?: { id: string; confidence: number; method: string } | null, candidates: Candidate[] = []): RefMatch {
  return {
    status,
    id: pick?.id ?? null,
    confidence: pick ? conf(pick.confidence) : null,
    method: pick?.method ?? null,
    reason,
    candidates,
  };
}

/** Downgrade a `matched` result whose confidence is under the org threshold. */
function applyThreshold(m: RefMatch, minConfidence: string): RefMatch {
  if (m.status === "matched" && m.confidence !== null && dec(m.confidence).lt(dec(minConfidence))) {
    return { ...m, status: "low_confidence", reason: `${m.reason} (confidence ${m.confidence} is below the review threshold ${minConfidence})` };
  }
  return m;
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

const supplierLabel = (s: SupplierRef) => `${s.code} — ${s.name}`;

export function resolveSupplier(header: InvoiceHeaderInput, suppliers: SupplierRef[]): RefMatch {
  const active = suppliers.filter((s) => s.active);
  const taxId = normId(header.supplierTaxIdRaw);
  const name = normName(header.supplierNameRaw);
  const nameId = normId(header.supplierNameRaw);
  if (!taxId && !name) return ref("missing", "The invoice has no supplier name or tax id");

  const byTax = taxId ? active.filter((s) => s.taxId && normId(s.taxId) === taxId) : [];
  const byCode = nameId ? active.filter((s) => normId(s.code) === nameId) : [];
  const byName = name ? active.filter((s) => normName(s.name) === name) : [];
  const byAlias = name ? active.filter((s) => s.aliases.some((a) => normName(a) === name)) : [];

  const cand = (s: SupplierRef, confidence: number, method: string): Candidate => ({ id: s.id, label: supplierLabel(s), confidence: conf(confidence), method });

  if (byTax.length > 1) return ref("conflicting", `Tax id matches ${byTax.length} suppliers`, null, byTax.map((s) => cand(s, 1, "tax_id")));
  const exactByName = uniq([...byCode, ...byName, ...byAlias]);
  if (byTax.length === 1) {
    const s = byTax[0]!;
    // A printed name that exactly identifies a DIFFERENT supplier contradicts the tax id.
    const others = exactByName.filter((x) => x.id !== s.id);
    if (others.length && !exactByName.some((x) => x.id === s.id)) {
      return ref("conflicting", "The tax id and the supplier name point to different suppliers", null, [cand(s, 1, "tax_id"), ...others.map((o) => cand(o, 0.95, "name"))]);
    }
    return ref("matched", "Matched by tax id", { id: s.id, confidence: 1, method: "tax_id" });
  }
  for (const [hits, confidence, method] of [
    [byCode, 0.97, "code"],
    [byName, 0.95, "name"],
    [byAlias, 0.93, "alias"],
  ] as const) {
    if (hits.length === 1) return ref("matched", `Matched by supplier ${method}`, { id: hits[0]!.id, confidence, method });
    if (hits.length > 1) return ref("conflicting", `Supplier ${method} matches ${hits.length} suppliers`, null, hits.map((s) => cand(s, confidence, method)));
  }
  if (!name) return ref("missing", "No supplier has this tax id");
  const scored = active
    .map((s) => ({ s, score: Math.max(similarity(name, s.name), ...s.aliases.map((a) => similarity(name, a))) }))
    .filter((x) => x.score >= 0.75)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return ref("missing", "No supplier matches the printed name or tax id");
  const best = scored[0]!;
  const close = scored.filter((x) => best.score - x.score < 0.05);
  const candidates = scored.slice(0, 5).map((x) => cand(x.s, x.score * 0.9, "name_similarity"));
  if (close.length > 1) return ref("conflicting", "Several suppliers have similar names", null, candidates);
  return ref("matched", "Matched by similar supplier name", { id: best.s.id, confidence: best.score * 0.9, method: "name_similarity" }, candidates);
}

export function resolvePurchaseOrder(header: InvoiceHeaderInput, supplier: RefMatch, pos: PoRef[]): { po: RefMatch; supplier: RefMatch } {
  const number = normId(header.poNumberRaw);
  const poCand = (p: PoRef, confidence: number, method: string): Candidate => ({ id: p.id, label: p.poNumber, confidence: conf(confidence), method });
  if (!number) {
    if (supplier.status === "matched" && supplier.id) {
      const open = pos.filter((p) => p.supplierId === supplier.id && p.status === "open");
      if (open.length === 1) {
        return { supplier, po: ref("matched", "No PO number on the invoice; the supplier has exactly one open PO", { id: open[0]!.id, confidence: 0.6, method: "only_open_po" }, [poCand(open[0]!, 0.6, "only_open_po")]) };
      }
      if (open.length > 1) return { supplier, po: ref("missing", `No PO number on the invoice and the supplier has ${open.length} open POs`, null, open.slice(0, 10).map((p) => poCand(p, 0.3, "open_po"))) };
    }
    return { supplier, po: ref("missing", "No PO number on the invoice") };
  }
  const hits = pos.filter((p) => normId(p.poNumber) === number);
  if (hits.length === 0) return { supplier, po: ref("missing", `PO number "${header.poNumberRaw}" was not found`) };
  if (hits.length > 1) return { supplier, po: ref("conflicting", `PO number "${header.poNumberRaw}" matches ${hits.length} purchase orders`, null, hits.map((p) => poCand(p, 1, "po_number"))) };
  const po = hits[0]!;
  const poMatch = ref("matched", "Matched by PO number", { id: po.id, confidence: 1, method: "po_number" });
  if (supplier.status === "matched" || supplier.status === "low_confidence") {
    if (supplier.id !== po.supplierId) {
      return {
        supplier: { ...supplier, status: "conflicting", reason: `${supplier.reason}, but PO ${po.poNumber} belongs to a different supplier`, candidates: supplier.candidates },
        po: { ...poMatch, status: "conflicting", reason: `PO ${po.poNumber} belongs to a different supplier than the one on the invoice` },
      };
    }
    // Two independent references agree; that confirms a weak supplier match.
    if (supplier.status === "low_confidence" || (supplier.confidence && dec(supplier.confidence).lt(dec("0.95")))) {
      return { po: poMatch, supplier: { ...supplier, status: "matched", confidence: conf(0.95), method: `${supplier.method}+po`, reason: `${supplier.reason}; confirmed by PO ${po.poNumber}` } };
    }
    return { supplier, po: poMatch };
  }
  if (supplier.status === "conflicting") {
    if (supplier.candidates.some((c) => c.id === po.supplierId)) {
      return { po: poMatch, supplier: ref("matched", `Supplier resolved by PO ${po.poNumber} among several candidates`, { id: po.supplierId, confidence: 0.95, method: "purchase_order" }, supplier.candidates) };
    }
    return { supplier, po: { ...poMatch, status: "conflicting", reason: `PO ${po.poNumber} belongs to none of the candidate suppliers` } };
  }
  // Supplier missing from the document: take it from the PO.
  return { po: poMatch, supplier: ref("matched", `Supplier taken from PO ${po.poNumber}`, { id: po.supplierId, confidence: 0.95, method: "purchase_order" }) };
}

const lineLabel = (l: PoLineRef) => `Line ${l.lineNo}${l.sku ? ` (${l.sku})` : ""}: ${l.description}`;

export function matchLineToPoLine(line: InvoiceLineInput, po: PoRef | null, poLines: PoLineRef[]): RefMatch {
  if (line.lineType !== "goods") return ref("not_applicable", "Charge and discount lines are not matched to PO lines");
  if (!po) return ref("missing", "No purchase order was matched for this invoice");
  const lines = poLines.filter((l) => l.poId === po.id);
  const active = lines.filter((l) => !l.cancelled);
  const cand = (l: PoLineRef, confidence: number, method: string): Candidate => ({ id: l.id, label: lineLabel(l), confidence: conf(confidence), method });

  const refNo = line.poLineRef && normId(line.poLineRef) !== normId(po.poNumber) ? parseLineRef(line.poLineRef) : null;
  const refLine = refNo !== null ? lines.find((l) => l.lineNo === refNo) ?? null : null;
  const sku = normId(line.sku);
  const skuLines = sku ? active.filter((l) => normId(l.sku) === sku) : [];

  if (refNo !== null && !refLine && skuLines.length === 0) return ref("missing", `PO ${po.poNumber} has no line ${refNo}`);
  if (refLine) {
    if (sku && refLine.sku && normId(refLine.sku) !== sku) {
      return ref("conflicting", `The line reference points to PO line ${refLine.lineNo} (${refLine.sku}) but the SKU is ${line.sku}`, null, uniq([cand(refLine, 1, "po_line_ref"), ...skuLines.map((l) => cand(l, 0.97, "sku"))]));
    }
    return ref("matched", `Matched by PO line reference ${refLine.lineNo}`, { id: refLine.id, confidence: 1, method: "po_line_ref" });
  }
  if (skuLines.length === 1) return ref("matched", "Matched by SKU", { id: skuLines[0]!.id, confidence: 0.97, method: "sku" });
  if (skuLines.length > 1) {
    const price = line.unitPrice;
    const unit = normUnit(line.unit);
    const narrowed = skuLines.filter((l) => (price ? dec(l.unitPrice).eq(dec(price)) : false) && (!unit || normUnit(l.unit) === unit));
    if (narrowed.length === 1) return ref("matched", "Matched by SKU and unit price", { id: narrowed[0]!.id, confidence: 0.9, method: "sku_price" }, skuLines.map((l) => cand(l, 0.5, "sku")));
    return ref("conflicting", `SKU ${line.sku} appears on ${skuLines.length} lines of PO ${po.poNumber}`, null, skuLines.map((l) => cand(l, 0.5, "sku")));
  }
  const desc = normName(line.description);
  if (!desc) return ref("missing", sku ? `SKU ${line.sku} is not on PO ${po.poNumber}` : "The line has no SKU, reference or description to match");
  const exact = active.filter((l) => normName(l.description) === desc);
  const skuDisagrees = (l: PoLineRef) => Boolean(sku && l.sku && normId(l.sku) !== sku);
  if (exact.length === 1) {
    const l = exact[0]!;
    if (skuDisagrees(l)) return ref("low_confidence", `Description matches PO line ${l.lineNo} but its SKU ${l.sku} differs from ${line.sku}`, { id: l.id, confidence: 0.7, method: "description" }, [cand(l, 0.7, "description")]);
    return ref("matched", "Matched by description", { id: l.id, confidence: 0.9, method: "description" });
  }
  if (exact.length > 1) return ref("conflicting", `Description matches ${exact.length} PO lines`, null, exact.map((l) => cand(l, 0.9, "description")));
  const scored = active
    .map((l) => ({ l, score: similarity(desc, l.description) }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return ref("missing", sku ? `SKU ${line.sku} is not on PO ${po.poNumber} and no line has a similar description` : `No line on PO ${po.poNumber} matches this description`);
  const best = scored[0]!;
  const candidates = scored.slice(0, 5).map((x) => cand(x.l, x.score * 0.85, "description_similarity"));
  if (scored.filter((x) => best.score - x.score < 0.1).length > 1) return ref("conflicting", "Several PO lines have similar descriptions", null, candidates);
  const c = skuDisagrees(best.l) ? Math.min(best.score * 0.85, 0.7) : best.score * 0.85;
  return ref("matched", "Matched by similar description", { id: best.l.id, confidence: c, method: "description_similarity" }, candidates);
}

function onDate(a: AgreementRef, date: string) {
  return a.validFrom <= date && (a.validTo === null || date <= a.validTo);
}

export function resolveAgreement(line: InvoiceLineInput, supplierId: string | null, poLine: PoLineRef | null, invoiceDate: string | null, agreements: AgreementRef[]): RefMatch {
  if (line.lineType !== "goods") return ref("not_applicable", "Agreements apply to goods lines only");
  const sku = normId(line.sku) || normId(poLine?.sku);
  if (!sku) return ref("not_applicable", "No SKU to look up a price agreement");
  if (!supplierId) return ref("missing", "Supplier not resolved, so no agreement can be selected");
  if (!invoiceDate) return ref("missing", "Invoice date missing, so the applicable agreement cannot be determined");
  const unit = normUnit(line.unit) || normUnit(poLine?.unit);
  const current = agreements.filter((a) => a.supplierId === supplierId && a.supersededAt === null && normId(a.sku) === sku);
  const dated = current.filter((a) => onDate(a, invoiceDate));
  const hits = dated.filter((a) => !unit || normUnit(a.unit) === unit);
  const cand = (a: AgreementRef): Candidate => ({ id: a.id, label: `${a.agreementRef} v${a.version} ${a.unitPrice} ${a.currency}/${a.unit} (${a.validFrom}–${a.validTo ?? "open"})`, confidence: conf(1), method: "sku_date" });
  if (hits.length === 0) {
    if (dated.length) return ref("missing", `Agreements for ${sku} on ${invoiceDate} are priced per ${dated.map((a) => a.unit).join(", ")}, not per ${unit}`, null, dated.map(cand));
    return ref("missing", current.length ? `No agreement for ${sku} is valid on ${invoiceDate}` : `No agreement for ${sku}`, null, current.slice(0, 5).map(cand));
  }
  const same = (a: AgreementRef, b: AgreementRef) =>
    dec(a.unitPrice).eq(dec(b.unitPrice)) && normCurrency(a.currency) === normCurrency(b.currency) && dec(a.discountPct).eq(dec(b.discountPct)) && (a.minQuantity ?? "") === (b.minQuantity ?? "");
  if (hits.length > 1 && !hits.every((a) => same(a, hits[0]!))) {
    return ref("conflicting", `${hits.length} different agreements for ${sku} are valid on ${invoiceDate}`, null, hits.map(cand));
  }
  const pick = [...hits].sort((a, b) => (a.validFrom === b.validFrom ? b.version - a.version : a.validFrom < b.validFrom ? 1 : -1))[0]!;
  return ref("matched", `Agreement ${pick.agreementRef} v${pick.version} valid on ${invoiceDate}`, { id: pick.id, confidence: 1, method: "sku_date" }, hits.length > 1 ? hits.map(cand) : []);
}

export function matchInvoice(input: MatchInput): MatchResult {
  const t = input.minConfidence;
  const supplier0 = resolveSupplier(input.header, input.suppliers);
  const resolved = resolvePurchaseOrder(input.header, supplier0, input.purchaseOrders);
  const supplier = applyThreshold(resolved.supplier, t);
  const purchaseOrder = applyThreshold(resolved.po, t);
  const po = purchaseOrder.status === "matched" || purchaseOrder.status === "low_confidence" ? input.purchaseOrders.find((p) => p.id === purchaseOrder.id) ?? null : null;
  const supplierId = supplier.status === "matched" || supplier.status === "low_confidence" ? supplier.id : null;

  const lines: LineMatch[] = [...input.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line) => {
      const poLine = applyThreshold(matchLineToPoLine(line, po, input.poLines), t);
      const poLineRow = poLine.id ? input.poLines.find((l) => l.id === poLine.id) ?? null : null;
      const agreement = applyThreshold(resolveAgreement(line, supplierId, poLineRow, input.header.invoiceDate, input.agreements), t);
      return { invoiceLineId: line.id, lineNo: line.lineNo, poLine, agreement };
    });

  const needsReview = [supplier, purchaseOrder, ...lines.flatMap((l) => [l.poLine, l.agreement])].some((m) => m.status === "low_confidence");
  return {
    ruleSetVersion: RULE_SET_VERSION,
    revision: input.revision,
    supplier,
    purchaseOrder,
    lines,
    needsReview,
    matchedAt: (input.now ?? new Date()).toISOString(),
  };
}

/** True when the match is trusted enough to drive checks and billing. */
export function isTrusted(m: RefMatch): boolean {
  return m.status === "matched" || m.status === "manual";
}
