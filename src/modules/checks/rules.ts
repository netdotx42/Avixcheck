import { Decimal, dec, decOrNull, roundMoney, sum, toFixed, type RoundingMode } from "@/lib/money/decimal";
import { withinTolerance, type Tolerance } from "@/lib/money/tolerance";
import { isTrusted } from "../matching/match";
import { normCurrency, normId, normName, normUnit } from "../matching/normalize";
import type { AgreementRef, RefMatch } from "../matching/types";
import type { Billing, CheckInput, CheckLine, CheckOutcome, DuplicateCandidate, Finding, PoLineState, Reference } from "./types";

interface DiscountShortfall {
  line: CheckLine;
  amount: Decimal;
  refs: Reference[];
  expected: Decimal;
  actual: Decimal;
  /** Whether the line bills a PO line (its exposure then explains PO-level overage). */
  onPo: boolean;
}

/**
 * Deterministic discrepancy rules. Pure: the same input always yields the same
 * findings. All arithmetic uses decimal.js with explicit rounding from the
 * organisation's settings; no floating point touches money.
 *
 * Exposure (`amount`) is the potential overpayment attributable to that finding
 * alone. Overlapping rules subtract what an earlier rule already counted so
 * that summing exposure across findings does not double count.
 *
 * Credit notes are evaluated on absolute values and produce negative billings.
 * For them the adverse direction is reversed (an under-credit is the risk).
 */
export function evaluateInvoice(input: CheckInput): CheckOutcome {
  return new Evaluator(input).run();
}

const ZERO = new Decimal(0);
const PRICE_SCALE = 6;
const QTY_SCALE = 4;

class Evaluator {
  private findings: Finding[] = [];
  private billings: Billing[] = [];
  private readonly mode: RoundingMode;
  private readonly currency: string;
  private readonly isCredit: boolean;
  /** Exposure already attributed per PO line (price, discount, quantity), to net out PO-level overage. */
  private attributed = ZERO;

  constructor(private readonly input: CheckInput) {
    this.mode = input.settings.rounding.mode;
    this.currency = normCurrency(input.invoice.currency) || normCurrency(input.purchaseOrder?.currency) || "";
    this.isCredit = input.invoice.kind === "credit_note";
  }

  run(): CheckOutcome {
    const header = this.checkHeaderData();
    this.checkReferences();
    const currencyOk = this.checkCurrency();
    this.checkArithmetic();
    this.checkGoodsLines(currencyOk);
    if (currencyOk) this.checkPoBalance();
    this.checkCharges();
    if (header.duplicatesComparable) this.checkDuplicates();
    return { findings: this.findings, billings: this.billings };
  }

  // ───────────── helpers ─────────────

  private money(v: Decimal): Decimal {
    return roundMoney(v, this.currency || "XXX", this.mode);
  }

  private fmt(v: Decimal): string {
    return toFixed(this.money(v), 4, this.mode);
  }

  private add(f: Omit<Finding, "currency"> & { currency?: string | null }) {
    this.findings.push({ currency: this.currency || null, ...f });
  }

  private abs(v: string | null): Decimal | null {
    const d = decOrNull(v);
    return d ? d.abs() : null;
  }

  private lineRef(l: CheckLine): Reference {
    return { type: "invoice_line", id: l.id, label: `Invoice line ${l.lineNo}${l.sku ? ` (${l.sku})` : ""}` };
  }

  private poLineRef(pl: PoLineState): Reference {
    const po = this.input.purchaseOrder;
    return { type: "po_line", id: pl.id, label: `PO ${po?.poNumber ?? "?"} line ${pl.lineNo}${pl.sku ? ` (${pl.sku})` : ""}`, version: po?.version };
  }

  private agreementRef(a: AgreementRef): Reference {
    return { type: "agreement", id: a.id, label: `${a.agreementRef} v${a.version} (${a.validFrom}–${a.validTo ?? "open"})`, version: a.version };
  }

  private lineMatch(l: CheckLine) {
    return this.input.match.lines.find((m) => m.invoiceLineId === l.id) ?? null;
  }

  // ───────────── rules ─────────────

  private checkHeaderData() {
    const inv = this.input.invoice;
    const missing: string[] = [];
    if (!inv.invoiceNumber?.trim()) missing.push("invoice number");
    if (!inv.invoiceDate) missing.push("invoice date");
    if (!inv.currency?.trim()) missing.push("currency");
    if (!inv.total) missing.push("total");
    if (this.input.lines.length === 0) missing.push("line items");
    if (missing.length) {
      this.add({
        type: "missing_data",
        severity: "high",
        title: `Missing ${missing.join(", ")}`,
        invoiceLineId: null,
        lineNo: null,
        expectedValue: missing.join(", "),
        actualValue: null,
        amount: null,
        explanation: `The invoice is missing: ${missing.join(", ")}. Checks that depend on these values could not run, so the invoice cannot pass.`,
        references: [{ type: "invoice", id: inv.id, label: inv.invoiceNumber ?? "invoice" }],
      });
    }
    for (const l of this.input.lines) {
      const req = l.lineType === "goods" ? (["quantity", "unitPrice", "amount"] as const) : (["amount"] as const);
      const gaps = req.filter((k) => !l[k]);
      if (gaps.length) {
        const names = gaps.map((g) => (g === "unitPrice" ? "unit price" : g));
        this.add({
          type: "missing_data",
          severity: "high",
          title: `Line ${l.lineNo}: missing ${names.join(", ")}`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: names.join(", "),
          actualValue: null,
          amount: null,
          explanation: `Line ${l.lineNo} is missing ${names.join(", ")}, so its price and quantity checks could not run.`,
          references: [this.lineRef(l)],
        });
      }
    }
    return { duplicatesComparable: true };
  }

  private refFinding(kind: "supplier" | "purchase order", m: RefMatch, line?: CheckLine) {
    if (isTrusted(m) || m.status === "not_applicable") return;
    const type = m.status === "conflicting" ? "conflicting_reference" : "missing_reference";
    const where = line ? `Line ${line.lineNo}: ` : "";
    this.add({
      type,
      severity: "high",
      title: `${where}${m.status === "conflicting" ? "Conflicting" : m.status === "low_confidence" ? "Unconfirmed" : "Missing"} ${kind}`,
      invoiceLineId: line?.id ?? null,
      lineNo: line?.lineNo ?? null,
      expectedValue: m.candidates.length ? m.candidates.map((c) => c.label).join(" | ") : null,
      actualValue: null,
      amount: null,
      explanation: `${where}${m.reason}. The invoice cannot pass until the ${kind} is confirmed.`,
      references: m.candidates.map((c) => ({ type: kind === "supplier" ? "supplier" : kind === "purchase order" ? "purchase_order" : "po_line", id: c.id, label: c.label })),
    });
  }

  private checkReferences() {
    const { match, purchaseOrder } = this.input;
    this.refFinding("supplier", match.supplier);
    this.refFinding("purchase order", match.purchaseOrder);
    if (purchaseOrder && isTrusted(match.purchaseOrder) && purchaseOrder.status !== "open") {
      this.add({
        type: "conflicting_reference",
        severity: "high",
        title: `PO ${purchaseOrder.poNumber} is ${purchaseOrder.status}`,
        invoiceLineId: null,
        lineNo: null,
        expectedValue: "open",
        actualValue: purchaseOrder.status,
        amount: null,
        explanation: `The invoice bills against PO ${purchaseOrder.poNumber}, which is ${purchaseOrder.status}.`,
        references: [{ type: "purchase_order", id: purchaseOrder.id, label: purchaseOrder.poNumber, version: purchaseOrder.version }],
      });
    }
    for (const l of this.input.lines) {
      const m = this.lineMatch(l);
      if (!m) continue;
      // Without a PO the header finding already explains every unmatched line.
      if (isTrusted(match.purchaseOrder)) {
        if (!isTrusted(m.poLine) && m.poLine.status !== "not_applicable") {
          this.add({
            type: m.poLine.status === "conflicting" ? "conflicting_reference" : "missing_reference",
            severity: "high",
            title: `Line ${l.lineNo}: ${m.poLine.status === "conflicting" ? "conflicting" : "no matching"} PO line`,
            invoiceLineId: l.id,
            lineNo: l.lineNo,
            expectedValue: m.poLine.candidates.map((c) => c.label).join(" | ") || null,
            actualValue: [l.sku, l.description].filter(Boolean).join(" — ") || null,
            amount: l.amount ? this.fmt(dec(l.amount).abs()) : null,
            explanation: `Line ${l.lineNo}: ${m.poLine.reason}. The line is not covered by a confirmed PO line.`,
            references: [this.lineRef(l), ...m.poLine.candidates.map((c) => ({ type: "po_line" as const, id: c.id, label: c.label }))],
          });
        }
        const pl = m.poLine.id ? this.input.poLines.find((x) => x.id === m.poLine.id) : undefined;
        if (pl?.cancelled && isTrusted(m.poLine)) {
          this.add({
            type: "conflicting_reference",
            severity: "high",
            title: `Line ${l.lineNo}: PO line ${pl.lineNo} is cancelled`,
            invoiceLineId: l.id,
            lineNo: l.lineNo,
            expectedValue: "active PO line",
            actualValue: "cancelled",
            amount: l.amount ? this.fmt(dec(l.amount).abs()) : null,
            explanation: `Line ${l.lineNo} bills PO line ${pl.lineNo}, which was cancelled by a PO amendment.`,
            references: [this.lineRef(l), this.poLineRef(pl)],
          });
        }
      }
      if (m.agreement.status === "conflicting") {
        this.add({
          type: "conflicting_reference",
          severity: "high",
          title: `Line ${l.lineNo}: conflicting price agreements`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: m.agreement.candidates.map((c) => c.label).join(" | "),
          actualValue: l.unitPrice,
          amount: null,
          explanation: `Line ${l.lineNo}: ${m.agreement.reason}. The agreed price is ambiguous, so the price was not checked against an agreement.`,
          references: [this.lineRef(l), ...m.agreement.candidates.map((c) => ({ type: "agreement" as const, id: c.id, label: c.label }))],
        });
      }
    }
  }

  /** Returns false when the invoice and PO currencies differ, which disables monetary comparison with the PO. */
  private checkCurrency(): boolean {
    const inv = normCurrency(this.input.invoice.currency);
    const po = this.input.purchaseOrder;
    if (!inv) return false;
    if (po && isTrusted(this.input.match.purchaseOrder) && normCurrency(po.currency) !== inv) {
      this.add({
        type: "currency_mismatch",
        severity: "high",
        title: `Invoice in ${inv}, PO ${po.poNumber} in ${normCurrency(po.currency)}`,
        invoiceLineId: null,
        lineNo: null,
        expectedValue: normCurrency(po.currency),
        actualValue: inv,
        amount: null,
        explanation: `The invoice currency (${inv}) differs from PO ${po.poNumber} (${normCurrency(po.currency)}). Prices and balances were not compared; no conversion is applied.`,
        references: [{ type: "purchase_order", id: po.id, label: po.poNumber, version: po.version }],
      });
      return false;
    }
    const sup = this.input.supplier;
    if (!po && sup?.currency && normCurrency(sup.currency) !== inv) {
      this.add({
        type: "currency_mismatch",
        severity: "medium",
        title: `Invoice in ${inv}, supplier bills in ${normCurrency(sup.currency)}`,
        invoiceLineId: null,
        lineNo: null,
        expectedValue: normCurrency(sup.currency),
        actualValue: inv,
        amount: null,
        explanation: `Supplier ${sup.name} is set up to bill in ${normCurrency(sup.currency)} but this invoice is in ${inv}.`,
        references: [{ type: "supplier", id: sup.id, label: sup.name, version: sup.version }],
      });
    }
    return true;
  }

  private checkArithmetic() {
    const inv = this.input.invoice;
    const tol = this.input.settings.tolerances;
    const perLine = this.input.settings.rounding.roundPerLine;
    const signed = (l: CheckLine, v: Decimal) => (l.lineType === "discount" ? v.neg() : v);
    const computedParts: Decimal[] = [];
    const unrounded: Decimal[] = [];
    let allComputable = true;
    for (const l of this.input.lines) {
      const q = this.abs(l.quantity);
      const p = this.abs(l.unitPrice);
      const a = this.abs(l.amount);
      if (q && p) {
        const raw = q.times(p);
        const expected = this.money(raw);
        computedParts.push(signed(l, expected));
        unrounded.push(signed(l, raw));
        if (a && !withinTolerance(expected, a, tol.lineAmount)) {
          const diff = a.minus(expected);
          this.add({
            type: "arithmetic_error",
            severity: "medium",
            title: `Line ${l.lineNo}: amount ≠ quantity × price`,
            invoiceLineId: l.id,
            lineNo: l.lineNo,
            expectedValue: this.fmt(expected),
            actualValue: this.fmt(a),
            amount: this.adverse(diff, l.lineType === "discount"),
            explanation: `Line ${l.lineNo}: ${q.toString()} × ${p.toString()} = ${this.fmt(expected)} (rounded ${this.mode}), but the line amount is ${this.fmt(a)}.`,
            references: [this.lineRef(l)],
          });
        }
      } else if (a) {
        computedParts.push(signed(l, a));
        unrounded.push(signed(l, a));
      } else {
        allComputable = false;
      }
    }
    const subtotal = this.abs(inv.subtotal);
    const tax = this.abs(inv.taxTotal);
    const total = this.abs(inv.total);
    const stated = this.input.lines.map((l) => this.abs(l.amount));
    if (subtotal && stated.every((x) => x !== null)) {
      const statedSum = this.money(sum(this.input.lines.map((l, i) => signed(l, stated[i]!))));
      if (!withinTolerance(statedSum, subtotal, tol.invoiceTotal)) {
        this.add({
          type: "arithmetic_error",
          severity: "high",
          title: "Line amounts do not add up to the subtotal",
          invoiceLineId: null,
          lineNo: null,
          expectedValue: this.fmt(statedSum),
          actualValue: this.fmt(subtotal),
          amount: this.adverse(subtotal.minus(statedSum)),
          explanation: `The line amounts sum to ${this.fmt(statedSum)} but the subtotal is ${this.fmt(subtotal)}.`,
          references: [{ type: "invoice", id: inv.id, label: inv.invoiceNumber ?? "invoice" }],
        });
      } else if (allComputable && computedParts.length) {
        // Recompute from quantity × price using the org's rounding policy.
        const recomputed = perLine ? this.money(sum(computedParts)) : this.money(sum(unrounded));
        if (!withinTolerance(recomputed, subtotal, tol.invoiceTotal)) {
          this.add({
            type: "arithmetic_error",
            severity: "medium",
            title: "Subtotal differs from quantity × price",
            invoiceLineId: null,
            lineNo: null,
            expectedValue: this.fmt(recomputed),
            actualValue: this.fmt(subtotal),
            amount: this.adverse(subtotal.minus(recomputed)),
            explanation: `Recomputing every line as quantity × unit price (${perLine ? "rounded per line" : "rounded on the total"}, ${this.mode}) gives ${this.fmt(recomputed)}, but the subtotal is ${this.fmt(subtotal)}.`,
            references: [{ type: "invoice", id: inv.id, label: inv.invoiceNumber ?? "invoice" }],
          });
        }
      }
    }
    if (subtotal && total) {
      const expected = this.money(subtotal.plus(tax ?? ZERO));
      if (!withinTolerance(expected, total, tol.invoiceTotal)) {
        this.add({
          type: "arithmetic_error",
          severity: "high",
          title: "Subtotal + tax ≠ total",
          invoiceLineId: null,
          lineNo: null,
          expectedValue: this.fmt(expected),
          actualValue: this.fmt(total),
          amount: this.adverse(total.minus(expected)),
          explanation: `Subtotal ${this.fmt(subtotal)} + tax ${this.fmt(tax ?? ZERO)} = ${this.fmt(expected)}, but the total is ${this.fmt(total)}.`,
          references: [{ type: "invoice", id: inv.id, label: inv.invoiceNumber ?? "invoice" }],
        });
      }
    }
  }

  /** Exposure of a difference (actual − expected): over-billing on invoices, under-crediting on credit notes. */
  private adverse(diff: Decimal, reversed = false): string {
    let d = this.isCredit ? diff.neg() : diff;
    if (reversed) d = d.neg();
    return this.fmt(Decimal.max(d, ZERO));
  }

  private agreementFor(l: CheckLine): AgreementRef | null {
    const m = this.lineMatch(l);
    if (!m || !isTrusted(m.agreement) || !m.agreement.id) return null;
    return this.input.agreements.find((a) => a.id === m.agreement.id) ?? null;
  }

  private checkGoodsLines(currencyOk: boolean) {
    const tol = this.input.settings.tolerances;
    const po = this.input.purchaseOrder;
    const poTrusted = Boolean(po && isTrusted(this.input.match.purchaseOrder));
    // Quantity consumed by earlier lines of THIS invoice on the same PO line.
    const consumed = new Map<string, Decimal>();
    const missingDiscount: DiscountShortfall[] = [];

    for (const l of this.input.lines) {
      if (l.lineType !== "goods") continue;
      const m = this.lineMatch(l);
      const pl = poTrusted && m && isTrusted(m.poLine) ? this.input.poLines.find((x) => x.id === m.poLine.id) : undefined;
      // Billing a cancelled PO line is already a conflicting_reference carrying the full line amount.
      if (pl?.cancelled) continue;
      const q = this.abs(l.quantity);
      const p = this.abs(l.unitPrice);
      const a = this.abs(l.amount);
      const agreement = this.agreementFor(l);

      // Unit of measure.
      const lineUnit = normUnit(l.unit);
      const expectedUnit = pl ? normUnit(pl.unit) : agreement ? normUnit(agreement.unit) : "";
      if (lineUnit && expectedUnit && lineUnit !== expectedUnit) {
        this.add({
          type: "unit_mismatch",
          severity: "high",
          title: `Line ${l.lineNo}: billed per ${l.unit}, agreed per ${pl?.unit ?? agreement?.unit}`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: pl?.unit ?? agreement?.unit ?? null,
          actualValue: l.unit,
          amount: null,
          explanation: `Line ${l.lineNo} is billed per "${l.unit}" but ${pl ? `PO line ${pl.lineNo}` : "the agreement"} is per "${pl?.unit ?? agreement?.unit}". Price and quantity were not compared because no unit conversion is defined.`,
          references: [this.lineRef(l), ...(pl ? [this.poLineRef(pl)] : []), ...(agreement ? [this.agreementRef(agreement)] : [])],
        });
        continue;
      }

      // Agreement currency.
      let usableAgreement = agreement;
      if (agreement && normCurrency(agreement.currency) !== normCurrency(this.input.invoice.currency)) {
        usableAgreement = null;
        this.add({
          type: "currency_mismatch",
          severity: "high",
          title: `Line ${l.lineNo}: agreement priced in ${normCurrency(agreement.currency)}`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: normCurrency(agreement.currency),
          actualValue: normCurrency(this.input.invoice.currency) || null,
          amount: null,
          explanation: `Agreement ${agreement.agreementRef} is priced in ${normCurrency(agreement.currency)} but the invoice is in ${normCurrency(this.input.invoice.currency)}. ${pl && currencyOk ? "The PO price was used instead." : "The price was not compared."}`,
          references: [this.lineRef(l), this.agreementRef(agreement)],
        });
      }

      // Expected price: agreement first, PO line price as fallback.
      const listPrice = usableAgreement ? dec(usableAgreement.unitPrice) : pl && currencyOk ? dec(pl.unitPrice) : null;
      const discountApplies = Boolean(
        usableAgreement && dec(usableAgreement.discountPct).gt(0) && q && (!usableAgreement.minQuantity || q.gte(dec(usableAgreement.minQuantity))),
      );
      const netPrice = listPrice && discountApplies ? listPrice.times(new Decimal(100).minus(dec(usableAgreement!.discountPct))).div(100).toDecimalPlaces(PRICE_SCALE) : listPrice;
      const priceRefs: Reference[] = [this.lineRef(l), ...(usableAgreement ? [this.agreementRef(usableAgreement)] : pl ? [this.poLineRef(pl)] : [])];

      if (listPrice && netPrice && p && q) {
        this.checkPrice(l, { q, p, listPrice, netPrice, discountApplies, source: usableAgreement ? "agreement" : "po", refs: priceRefs, missingDiscount, onPo: Boolean(pl) });
      }

      if (!pl || !q) continue;
      const billedBefore = dec(pl.billedQuantityOther).plus(consumed.get(pl.id) ?? ZERO);
      consumed.set(pl.id, (consumed.get(pl.id) ?? ZERO).plus(q));
      const unitForExposure = netPrice ?? (currencyOk ? dec(pl.unitPrice) : null);
      let poExcess = ZERO;

      if (!this.isCredit) {
        const remaining = dec(pl.quantity).minus(billedBefore);
        if (q.gt(remaining) && !withinTolerance(Decimal.max(remaining, ZERO), q, tol.quantity)) {
          poExcess = q.minus(Decimal.max(remaining, ZERO));
          const amount = unitForExposure ? this.money(poExcess.times(unitForExposure)) : null;
          if (amount) this.attributed = this.attributed.plus(amount);
          this.add({
            type: "quantity_excess",
            severity: "high",
            title: `Line ${l.lineNo}: quantity exceeds PO line balance`,
            invoiceLineId: l.id,
            lineNo: l.lineNo,
            expectedValue: toFixed(Decimal.max(remaining, ZERO), QTY_SCALE),
            actualValue: toFixed(q, QTY_SCALE),
            amount: amount ? this.fmt(amount) : null,
            explanation: `PO line ${pl.lineNo} ordered ${toFixed(dec(pl.quantity), QTY_SCALE)} ${pl.unit}; ${toFixed(billedBefore, QTY_SCALE)} already billed leaves ${toFixed(Decimal.max(remaining, ZERO), QTY_SCALE)}, but this line bills ${toFixed(q, QTY_SCALE)} (excess ${toFixed(poExcess, QTY_SCALE)}).`,
            references: [this.lineRef(l), this.poLineRef(pl)],
          });
        }

        // Receipts: only when receipt data exists for the PO line.
        if (pl.receivedQuantity !== null) {
          const unbilledReceived = dec(pl.receivedQuantity).minus(billedBefore);
          if (q.gt(unbilledReceived) && !withinTolerance(Decimal.max(unbilledReceived, ZERO), q, tol.quantity)) {
            const excess = q.minus(Decimal.max(unbilledReceived, ZERO));
            const extra = Decimal.max(excess.minus(poExcess), ZERO);
            const amount = unitForExposure ? this.money(extra.times(unitForExposure)) : null;
            if (amount) this.attributed = this.attributed.plus(amount);
            this.add({
              type: "receipt_quantity_exceeded",
              severity: "high",
              title: `Line ${l.lineNo}: billed more than received`,
              invoiceLineId: l.id,
              lineNo: l.lineNo,
              expectedValue: toFixed(Decimal.max(unbilledReceived, ZERO), QTY_SCALE),
              actualValue: toFixed(q, QTY_SCALE),
              amount: amount ? this.fmt(amount) : null,
              explanation: `${toFixed(dec(pl.receivedQuantity), QTY_SCALE)} ${pl.unit} received against PO line ${pl.lineNo}, ${toFixed(billedBefore, QTY_SCALE)} already billed; this line bills ${toFixed(q, QTY_SCALE)} (excess ${toFixed(excess, QTY_SCALE)}${poExcess.gt(0) ? `, of which ${toFixed(poExcess, QTY_SCALE)} is already counted as PO excess` : ""}).`,
              references: [this.lineRef(l), this.poLineRef(pl), ...pl.receiptIds.map((id) => ({ type: "receipt" as const, id, label: "Goods receipt" }))],
            });
          }
        }
      }

      const billedAmount = a ?? (p ? this.money(q.times(p)) : ZERO);
      this.billings.push({
        invoiceLineId: l.id,
        poLineId: pl.id,
        quantity: toFixed(this.isCredit ? q.neg() : q, QTY_SCALE),
        amount: this.fmt(this.isCredit ? billedAmount.neg() : billedAmount),
      });
    }

    this.reportMissingDiscounts(missingDiscount);
  }

  private checkPrice(
    l: CheckLine,
    o: { q: Decimal; p: Decimal; listPrice: Decimal; netPrice: Decimal; discountApplies: boolean; source: "agreement" | "po"; refs: Reference[]; missingDiscount: DiscountShortfall[]; onPo: boolean },
  ) {
    const tol = this.input.settings.tolerances.unitPrice;
    const { q, p, listPrice, netPrice } = o;
    const src = o.source === "agreement" ? "agreed price" : "PO price";
    if (this.isCredit) {
      // A credit below the price that was charged under-credits the buyer.
      if (p.lt(netPrice) && !withinTolerance(netPrice, p, tol)) {
        this.add({
          type: "price_variance",
          severity: "high",
          title: `Line ${l.lineNo}: credited below ${src}`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: toFixed(netPrice, PRICE_SCALE),
          actualValue: toFixed(p, PRICE_SCALE),
          amount: this.fmt(netPrice.minus(p).times(q)),
          explanation: `Credit line ${l.lineNo} credits ${toFixed(p, PRICE_SCALE)} per unit; the ${src} is ${toFixed(netPrice, PRICE_SCALE)}.`,
          references: o.refs,
        });
      }
      return;
    }
    if (!o.discountApplies) {
      if (p.gt(listPrice) && !withinTolerance(listPrice, p, tol)) {
        const amount = this.money(p.minus(listPrice).times(q));
        if (o.onPo) this.attributed = this.attributed.plus(amount);
        this.add({
          type: "price_variance",
          severity: "high",
          title: `Line ${l.lineNo}: price above ${src}`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: toFixed(listPrice, PRICE_SCALE),
          actualValue: toFixed(p, PRICE_SCALE),
          amount: this.fmt(amount),
          explanation: `Line ${l.lineNo} is billed at ${toFixed(p, PRICE_SCALE)} per unit; the ${src} is ${toFixed(listPrice, PRICE_SCALE)}. ${toFixed(q, QTY_SCALE)} × ${toFixed(p.minus(listPrice), PRICE_SCALE)} = ${this.fmt(amount)}.`,
          references: o.refs,
        });
      }
      return;
    }
    if (withinTolerance(netPrice, p, tol) || p.lt(netPrice)) return;
    if (p.gt(listPrice) && !withinTolerance(listPrice, p, tol)) {
      const amount = this.money(p.minus(listPrice).times(q));
      if (o.onPo) this.attributed = this.attributed.plus(amount);
      this.add({
        type: "price_variance",
        severity: "high",
        title: `Line ${l.lineNo}: price above ${src}`,
        invoiceLineId: l.id,
        lineNo: l.lineNo,
        expectedValue: toFixed(listPrice, PRICE_SCALE),
        actualValue: toFixed(p, PRICE_SCALE),
        amount: this.fmt(amount),
        explanation: `Line ${l.lineNo} is billed at ${toFixed(p, PRICE_SCALE)} per unit, above the ${src} of ${toFixed(listPrice, PRICE_SCALE)} (before the agreed discount).`,
        references: o.refs,
      });
      o.missingDiscount.push({ line: l, amount: this.money(listPrice.minus(netPrice).times(q)), refs: o.refs, expected: netPrice, actual: listPrice, onPo: o.onPo });
    } else {
      o.missingDiscount.push({ line: l, amount: this.money(p.minus(netPrice).times(q)), refs: o.refs, expected: netPrice, actual: p, onPo: o.onPo });
    }
  }

  private reportMissingDiscounts(items: DiscountShortfall[]) {
    if (!items.length) return;
    // A discount given as a separate invoice line covers line-level shortfalls up to its value.
    let invoiceDiscount = sum(this.input.lines.filter((l) => l.lineType === "discount").map((l) => this.abs(l.amount) ?? ZERO));
    const tol: Tolerance = this.input.settings.tolerances.lineAmount;
    for (const it of items) {
      const covered = Decimal.min(invoiceDiscount, it.amount);
      invoiceDiscount = invoiceDiscount.minus(covered);
      const shortfall = it.amount.minus(covered);
      if (withinTolerance(ZERO, shortfall, tol)) continue;
      if (it.onPo) this.attributed = this.attributed.plus(shortfall);
      const agreement = this.agreementFor(it.line);
      this.add({
        type: "missing_discount",
        severity: "medium",
        title: `Line ${it.line.lineNo}: agreed discount not applied`,
        invoiceLineId: it.line.id,
        lineNo: it.line.lineNo,
        expectedValue: toFixed(it.expected, PRICE_SCALE),
        actualValue: toFixed(it.actual, PRICE_SCALE),
        amount: this.fmt(shortfall),
        explanation: `Agreement ${agreement?.agreementRef ?? ""} gives ${agreement ? toFixed(dec(agreement.discountPct), 2) : "?"}% off${agreement?.minQuantity ? ` from ${toFixed(dec(agreement.minQuantity), QTY_SCALE)} units` : ""}, so the net price is ${toFixed(it.expected, PRICE_SCALE)}${covered.gt(0) ? `; an invoice discount line covers ${this.fmt(covered)}` : ""}. Shortfall ${this.fmt(shortfall)}.`,
        references: it.refs,
      });
    }
  }

  private checkPoBalance() {
    const po = this.input.purchaseOrder;
    if (!po || !isTrusted(this.input.match.purchaseOrder) || this.isCredit) return;
    const poValue = this.money(sum(this.input.poLines.filter((l) => l.poId === po.id && !l.cancelled).map((l) => dec(l.quantity).times(dec(l.unitPrice)))));
    const billedOther = dec(this.input.poBilledAmountOther);
    const thisInvoice = sum(this.billings.map((b) => dec(b.amount)));
    if (thisInvoice.lte(0)) return;
    const remaining = poValue.minus(billedOther);
    if (thisInvoice.lte(remaining) || withinTolerance(Decimal.max(remaining, ZERO), thisInvoice, this.input.settings.tolerances.invoiceTotal)) return;
    const overage = thisInvoice.minus(Decimal.max(remaining, ZERO));
    const unexplained = this.money(overage.minus(this.attributed));
    if (unexplained.lte(0)) return;
    this.add({
      type: "po_balance_exceeded",
      severity: "high",
      title: `Cumulative billing exceeds PO ${po.poNumber}`,
      invoiceLineId: null,
      lineNo: null,
      expectedValue: this.fmt(Decimal.max(remaining, ZERO)),
      actualValue: this.fmt(thisInvoice),
      amount: this.fmt(unexplained),
      explanation: `PO ${po.poNumber} (v${po.version}) is worth ${this.fmt(poValue)}; ${this.fmt(billedOther)} is already billed by other invoices, leaving ${this.fmt(Decimal.max(remaining, ZERO))}. This invoice bills ${this.fmt(thisInvoice)} against it.${this.attributed.gt(0) ? ` ${this.fmt(this.attributed)} of the overage is already counted in line findings.` : ""}`,
      references: [{ type: "purchase_order", id: po.id, label: po.poNumber, version: po.version }],
    });
  }

  private checkCharges() {
    const date = this.input.invoice.invoiceDate;
    const supplierId = isTrusted(this.input.match.supplier) ? this.input.match.supplier.id : null;
    const cur = normCurrency(this.input.invoice.currency);
    for (const l of this.input.lines) {
      if (l.lineType !== "charge") continue;
      const a = this.abs(l.amount);
      if (!a || this.isCredit) continue;
      const type = normName(l.chargeType ?? l.description);
      const approvals = this.input.approvedCharges.filter(
        (c) => supplierId && c.supplierId === supplierId && normName(c.chargeType) === type && normCurrency(c.currency) === cur && date && c.validFrom <= date && (c.validTo === null || date <= c.validTo),
      );
      const label = l.chargeType ?? l.description ?? "charge";
      if (!approvals.length) {
        this.add({
          type: "unapproved_charge",
          severity: "high",
          title: `Line ${l.lineNo}: unapproved charge "${label}"`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: "approved charge",
          actualValue: this.fmt(a),
          amount: this.fmt(a),
          explanation: supplierId
            ? `No approved "${label}" charge in ${cur || "this currency"} is on file for this supplier on ${date ?? "the invoice date"}.`
            : `The supplier is not confirmed, so the "${label}" charge cannot be verified against approved charges.`,
          references: [this.lineRef(l)],
        });
        continue;
      }
      if (approvals.some((c) => c.maxAmount === null)) continue;
      const best = approvals.reduce((m, c) => (dec(c.maxAmount!).gt(dec(m.maxAmount!)) ? c : m));
      const max = dec(best.maxAmount!);
      if (a.gt(max) && !withinTolerance(max, a, this.input.settings.tolerances.lineAmount)) {
        this.add({
          type: "unapproved_charge",
          severity: "medium",
          title: `Line ${l.lineNo}: "${label}" above approved maximum`,
          invoiceLineId: l.id,
          lineNo: l.lineNo,
          expectedValue: this.fmt(max),
          actualValue: this.fmt(a),
          amount: this.fmt(a.minus(max)),
          explanation: `The approved maximum for "${best.chargeType}" is ${this.fmt(max)}; the invoice charges ${this.fmt(a)}.`,
          references: [this.lineRef(l), { type: "approved_charge", id: best.id, label: `${best.chargeType} max ${this.fmt(max)}` }],
        });
      }
    }
  }

  private checkDuplicates() {
    const inv = this.input.invoice;
    const supplierId = isTrusted(this.input.match.supplier) ? this.input.match.supplier.id : null;
    const number = normId(inv.invoiceNumber);
    const total = decOrNull(inv.total);
    const reasons = new Map<string, { c: DuplicateCandidate; why: string[] }>();
    const note = (c: DuplicateCandidate, why: string) => {
      const e = reasons.get(c.id) ?? { c, why: [] };
      e.why.push(why);
      reasons.set(c.id, e);
    };
    for (const c of this.input.duplicateCandidates) {
      if (c.id === inv.id || c.status === "rejected") continue;
      if (c.documentId === inv.documentId || (inv.documentSha256 && c.documentSha256 === inv.documentSha256)) note(c, "same document file");
      if (c.kind !== inv.kind || !supplierId || c.supplierId !== supplierId) continue;
      if (number && normId(c.invoiceNumber) === number) note(c, "same supplier and invoice number");
      if (total && c.total && inv.invoiceDate && c.invoiceDate === inv.invoiceDate && dec(c.total).abs().eq(total.abs())) note(c, "same supplier, total and date");
    }
    if (!reasons.size) return;
    const list = [...reasons.values()];
    const strong = list.some((e) => e.why.some((w) => w !== "same supplier, total and date"));
    this.add({
      type: "duplicate_invoice",
      severity: strong ? "high" : "medium",
      title: `Possible duplicate of ${list.map((e) => e.c.invoiceNumber ?? "an earlier upload").join(", ")}`,
      invoiceLineId: null,
      lineNo: null,
      expectedValue: null,
      actualValue: inv.invoiceNumber,
      amount: total ? this.fmt(total.abs()) : null,
      explanation: list.map((e) => `${e.c.invoiceNumber ?? "Invoice"} (${e.c.invoiceDate ?? "no date"}, ${e.c.status}): ${e.why.join("; ")}`).join(". ") + ".",
      references: list.map((e) => ({ type: "invoice" as const, id: e.c.id, label: e.c.invoiceNumber ?? e.c.id })),
    });
  }
}

