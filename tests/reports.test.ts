import { beforeAll, describe, expect, it } from "vitest";
import { setupTestEnv, makeOrg } from "./helpers";
import { reportFixtures } from "./report-fixtures";

setupTestEnv();
const { withTenant } = await import("../src/db/tenant");
const q = await import("../src/modules/reports/queries");
const { parseReportFilters } = await import("../src/modules/reports/filters");
const { overviewMetrics, overviewTrends } = await import("../src/lib/metrics");

const DAY = 86_400_000;
const now = new Date();

describe("reports", () => {
  let a: Awaited<ReturnType<typeof makeOrg>>;
  let b: Awaited<ReturnType<typeof makeOrg>>;
  let s1: { id: string };
  let s2: { id: string };

  beforeAll(async () => {
    const fx = await reportFixtures();
    a = await makeOrg("Reports A");
    b = await makeOrg("Reports B");
    s1 = await fx.supplier(a.org.id, "S1", "Acme Fasteners");
    s2 = await fx.supplier(a.org.id, "S2", "Euro Parts");

    const inv1 = await fx.invoice(a.org.id, { supplierId: s1.id, number: "INV-1", status: "exceptions_open", total: "1000.1000" });
    const run1 = await fx.checkRun(a.org.id, inv1.id);
    // Decimal precision: 0.1 + 0.2 + |−12.3456| must be exactly 12.6456.
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "0.1000" });
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "0.2000", status: "in_review" });
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "-12.3456", type: "arithmetic_error" });
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "100.0000", type: "quantity_excess", status: "correction_requested" });
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "50.0000", status: "accepted_variance" });
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "30.0000", status: "correction_requested", confirmed: "25.5000" });
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: run1.id, amount: "9.0000", status: "dismissed" });
    // A superseded run's discrepancies must never count.
    const old = await fx.checkRun(a.org.id, inv1.id, "superseded");
    await fx.discrepancy(a.org.id, { invoiceId: inv1.id, runId: old.id, amount: "999.0000" });

    const inv2 = await fx.invoice(a.org.id, { supplierId: s2.id, number: "EU-7", status: "exceptions_open", currency: "EUR", total: "70.0000" });
    const run2 = await fx.checkRun(a.org.id, inv2.id);
    await fx.discrepancy(a.org.id, { invoiceId: inv2.id, runId: run2.id, amount: "7.0000", currency: "EUR", createdAt: new Date(now.getTime() - 40 * DAY) });

    const inv3 = await fx.invoice(a.org.id, { number: "BROKEN", status: "failed", failureReason: "Extraction timed out" });
    await fx.reviewException(a.org.id, inv3.id, "processing_failure");

    await fx.invoice(a.org.id, { supplierId: s1.id, number: "CN-1", kind: "credit_note", total: "-50.0000" });
    await fx.invoice(a.org.id, { supplierId: s1.id, number: "OLD-1", total: "1.0000", createdAt: new Date(now.getTime() - 200 * DAY) });

    const binv = await fx.invoice(b.org.id, { number: "B-1", status: "exceptions_open", total: "5000.0000" });
    const brun = await fx.checkRun(b.org.id, binv.id);
    await fx.discrepancy(b.org.id, { invoiceId: binv.id, runId: brun.id, amount: "5000.0000", confirmed: "4000.0000", status: "correction_requested" });
  });

  it("keeps potential exposure, awaiting correction, accepted variance and realised savings separate, per currency", async () => {
    const out = await withTenant(a.org.id, (tx) => q.outcomesByCurrency(tx, {}));
    expect(out).toEqual([
      { currency: "EUR", potentialExposure: "7.0000", awaitingCorrection: "0", acceptedVariance: "0", realisedSavings: "0" },
      { currency: "GBP", potentialExposure: "12.6456", awaitingCorrection: "100.0000", acceptedVariance: "50.0000", realisedSavings: "25.5000" },
    ]);
  });

  it("overview metrics exclude superseded runs and match the report figures", async () => {
    const m = await overviewMetrics(a.org.id);
    expect(m.potentialExposure).toEqual([
      { currency: "EUR", amount: "7.0000" },
      { currency: "GBP", amount: "12.6456" },
    ]);
    expect(m.confirmedCorrections).toEqual([{ currency: "GBP", amount: "25.5000" }]);
    // 4 open/in-review discrepancies + 1 processing failure; the superseded run's exception is not counted.
    expect(m.unresolvedExceptions).toBe(5);
  });

  it("groups unresolved items by type and by age", async () => {
    const byType = await withTenant(a.org.id, (tx) => q.unresolvedByType(tx, {}));
    const pv = byType.find((g) => g.key === "price_variance")!;
    expect(pv.count).toBe(3);
    expect(pv.exposure).toEqual(expect.arrayContaining([{ currency: "GBP", amount: "0.3000" }, { currency: "EUR", amount: "7.0000" }]));
    expect(byType.find((g) => g.key === "arithmetic_error")).toMatchObject({ count: 1, exposure: [{ currency: "GBP", amount: "12.3456" }] });
    expect(byType.find((g) => g.key === "processing_failure")).toMatchObject({ count: 1, exposure: [] });
    expect(byType.some((g) => g.key === "quantity_excess")).toBe(false);

    const byAge = await withTenant(a.org.id, (tx) => q.unresolvedByAge(tx, {}, now));
    expect(byAge.map((g) => g.key)).toEqual([...q.AGE_BUCKETS]);
    expect(byAge[0]!.count).toBe(4);
    expect(byAge[2]).toMatchObject({ count: 1, exposure: [{ currency: "EUR", amount: "7.0000" }] });
  });

  it("summarises invoices and volume within the date range", async () => {
    const f = q.withDefaultRange({}, now);
    const summary = await withTenant(a.org.id, (tx) => q.invoiceSummary(tx, f));
    expect(summary).toMatchObject({ total: 4, invoices: 3, creditNotes: 1, exceptionsOpen: 2, failed: 1 });
    const vol = await withTenant(a.org.id, (tx) => q.invoiceVolume(tx, f));
    expect(vol.reduce((n, p) => n + p.invoices + p.creditNotes, 0)).toBe(4);
    expect(vol.reduce((n, p) => n + p.failed, 0)).toBe(1);
    expect(q.chooseBucket(f.from, f.to)).toBe("week");
    // Including the old invoice when the range covers it.
    const wide = await withTenant(a.org.id, (tx) => q.invoiceSummary(tx, q.withDefaultRange({ from: new Date(now.getTime() - 400 * DAY).toISOString().slice(0, 10) }, now)));
    expect(wide.total).toBe(5);
  });

  it("reports billed totals with credit notes kept apart", async () => {
    const billed = await withTenant(a.org.id, (tx) => q.billedTotals(tx, q.withDefaultRange({}, now)));
    expect(billed).toEqual([
      { currency: "EUR", invoiced: "70.0000", credited: "0" },
      { currency: "GBP", invoiced: "1000.1000", credited: "50.0000" },
    ]);
  });

  it("filters by supplier", async () => {
    const out = await withTenant(a.org.id, (tx) => q.outcomesByCurrency(tx, { supplierId: s2.id }));
    expect(out).toEqual([{ currency: "EUR", potentialExposure: "7.0000", awaitingCorrection: "0", acceptedVariance: "0", realisedSavings: "0" }]);
  });

  it("lists processing failures with reasons", async () => {
    const f = await withTenant(a.org.id, (tx) => q.processingFailures(tx, {}));
    expect(f.failedInvoices).toBe(1);
    expect(f.openProcessingExceptions).toBe(1);
    expect(f.recentInvoices[0]).toMatchObject({ name: "BROKEN", reason: "Extraction timed out", status: "failed" });
  });

  it("breaks down by supplier including unmatched invoices", async () => {
    const { rows, total } = await withTenant(a.org.id, (tx) => q.supplierBreakdown(tx, q.withDefaultRange({}, now)));
    expect(total).toBe(3);
    const acme = rows.find((r) => r.code === "S1")!;
    expect(acme).toMatchObject({ invoices: 2, openExceptions: 3, exposure: [{ currency: "GBP", amount: "12.6456" }], realised: [{ currency: "GBP", amount: "25.5000" }] });
    expect(rows.find((r) => r.supplierId === null)).toMatchObject({ name: "Unmatched supplier", invoices: 1 });
  });

  it("never shows another tenant's figures", async () => {
    const outB = await withTenant(b.org.id, (tx) => q.outcomesByCurrency(tx, {}));
    expect(outB).toEqual([{ currency: "GBP", potentialExposure: "0", awaitingCorrection: "0", acceptedVariance: "0", realisedSavings: "4000.0000" }]);
    const data = await q.reportData(a.org.id, {}, { now });
    expect(JSON.stringify(data)).not.toContain("5000.0000");
    expect(JSON.stringify(data)).not.toContain("4000.0000");
    // A supplier id from org A used as a filter in org B yields nothing.
    const cross = await withTenant(b.org.id, (tx) => q.invoiceSummary(tx, { supplierId: s1.id }));
    expect(cross.total).toBe(0);
  });

  it("overview trends cover 12 weeks", async () => {
    const t = await overviewTrends(a.org.id, now);
    expect(t.volume).toHaveLength(12);
    expect(t.failures.failedInvoices).toBe(1);
  });

  it("validates filters", () => {
    expect(parseReportFilters({ from: "2026-02-30" }).error).toMatch(/date/);
    expect(parseReportFilters({ from: "2026-05-02", to: "2026-05-01" }).error).toMatch(/on or before/);
    expect(parseReportFilters({ supplier: "x' or 1=1" }).error).toBeTruthy();
    expect(parseReportFilters({ from: "2026-01-01", to: "2026-01-31", supplier: "" })).toEqual({ filters: { from: "2026-01-01", to: "2026-01-31" } });
  });
});
