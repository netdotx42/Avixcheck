import { randomUUID } from "node:crypto";

/**
 * Test-only fixtures for reports and exports: inserts invoices, check runs,
 * discrepancies and exceptions directly so report figures can be verified
 * without the extraction or rules engine.
 */
export async function reportFixtures() {
  const { withTenant } = await import("../src/db/tenant");
  const s = await import("../src/db/schema");

  type Status = (typeof s.invoiceStatusEnum.enumValues)[number];
  type ExStatus = (typeof s.exceptionStatusEnum.enumValues)[number];
  type DType = (typeof s.discrepancyTypeEnum.enumValues)[number];

  async function supplier(orgId: string, code: string, name: string) {
    const [row] = await withTenant(orgId, (tx) => tx.insert(s.suppliers).values({ orgId, code, name }).returning());
    return row!;
  }

  async function invoice(
    orgId: string,
    o: { supplierId?: string | null; number?: string; status?: Status; kind?: "invoice" | "credit_note"; currency?: string; total?: string; createdAt?: Date; failureReason?: string },
  ) {
    return withTenant(orgId, async (tx) => {
      const [doc] = await tx
        .insert(s.documents)
        .values({ orgId, storageKey: `org/${orgId}/documents/${randomUUID()}.pdf`, sha256: randomUUID(), sizeBytes: 100, mimeType: "application/pdf", originalName: `${o.number ?? "doc"}.pdf` })
        .returning();
      const [inv] = await tx
        .insert(s.invoices)
        .values({
          orgId,
          documentId: doc!.id,
          supplierId: o.supplierId ?? null,
          invoiceNumber: o.number ?? null,
          status: o.status ?? "passed",
          kind: o.kind ?? "invoice",
          currency: o.currency ?? "GBP",
          total: o.total ?? null,
          failureReason: o.failureReason ?? null,
          createdAt: o.createdAt ?? new Date(),
        })
        .returning();
      return inv!;
    });
  }

  async function checkRun(orgId: string, invoiceId: string, status: "completed" | "superseded" = "completed") {
    const [run] = await withTenant(orgId, (tx) =>
      tx
        .insert(s.checkRuns)
        .values({ orgId, invoiceId, status, ruleSetVersion: "rules@test", settingsSnapshot: {}, referenceSnapshot: {}, invoiceRevision: 1, idempotencyKey: randomUUID() })
        .returning(),
    );
    return run!;
  }

  async function discrepancy(
    orgId: string,
    o: { invoiceId: string; runId: string; type?: DType; amount?: string | null; currency?: string; status?: ExStatus; confirmed?: string; createdAt?: Date; explanation?: string; title?: string },
  ) {
    return withTenant(orgId, async (tx) => {
      const [d] = await tx
        .insert(s.discrepancies)
        .values({
          orgId,
          checkRunId: o.runId,
          invoiceId: o.invoiceId,
          type: o.type ?? "price_variance",
          severity: "high",
          expectedValue: "10.00",
          actualValue: "10.50",
          amount: o.amount === undefined ? "0.0000" : o.amount,
          currency: o.currency ?? "GBP",
          explanation: o.explanation ?? "Billed above agreed price",
        })
        .returning();
      const [e] = await tx
        .insert(s.exceptions)
        .values({
          orgId,
          invoiceId: o.invoiceId,
          discrepancyId: d!.id,
          kind: "discrepancy",
          status: o.status ?? "open",
          title: o.title ?? "Price variance",
          confirmedCorrectionAmount: o.confirmed ?? null,
          createdAt: o.createdAt ?? new Date(),
        })
        .returning();
      return { discrepancy: d!, exception: e! };
    });
  }

  async function reviewException(orgId: string, invoiceId: string, kind: "extraction_review" | "processing_failure", status: ExStatus = "open") {
    const [e] = await withTenant(orgId, (tx) => tx.insert(s.exceptions).values({ orgId, invoiceId, kind, status, title: kind }).returning());
    return e!;
  }

  return { supplier, invoice, checkRun, discrepancy, reviewException };
}
