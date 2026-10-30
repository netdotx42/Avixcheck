import { expect, test, type Page } from "@playwright/test";
import { healthIntegrations, newAdmin } from "./fixtures";

/**
 * Upload → scan → extraction → matching → review → decision → export through
 * the browser, with the real web app and worker, MinIO for storage and a real
 * ClamAV daemon. Extraction uses the TEST-ONLY fixture provider
 * (EXTRACTION_PROVIDER=fixture, refused outside APP_ENV=test): the PDF carries
 * an AVIX-FIXTURE marker naming tests/fixtures/extraction/invoice-confident.json.
 *
 * When storage or ClamAV are not available (plain local runs) the test skips
 * and names what is missing; in CI (E2E_REQUIRE_WORKFLOW=1) it fails instead.
 */

const CSV = {
  suppliers: "supplier_code,name,tax_id,currency,aliases\nACME,Acme Industrial Supplies Ltd,GB123456789,GBP,Acme Industrial\n",
  purchase_orders:
    "po_number,supplier_code,currency,issued_on,line_no,sku,description,quantity,unit,unit_price\nPO-7781,ACME,GBP,2026-09-01,1,BOLT-M8,M8 hex bolts box of 100,20,box,90.000000\n",
  price_agreements:
    "agreement_ref,supplier_code,sku,description,unit_price,currency,unit,discount_pct,min_quantity,valid_from,valid_to\nAGR-1,ACME,BOLT-M8,M8 hex bolts,90.000000,GBP,box,,,2026-01-01,2026-12-31\n",
  approved_charges: "supplier_code,charge_type,max_amount,currency,valid_from,valid_to\nACME,freight,45.00,GBP,2026-01-01,\n",
} as const;

function fixturePdf(fixture: string): Buffer {
  return Buffer.from(
    `%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n% AVIX-FIXTURE:${fixture} ${Date.now()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

async function importCsv(page: Page, kind: keyof typeof CSV) {
  await page.goto(`/imports?kind=${kind}`, { waitUntil: "networkidle" });
  await page.locator("#import-kind").selectOption(kind);
  await page.locator("#import-file").setInputFiles({ name: `${kind}.csv`, mimeType: "text/csv", buffer: Buffer.from(CSV[kind]) });
  await page.getByRole("button", { name: "Upload and preview" }).click();
  await page.waitForURL(/\/imports\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByText(/^Committed /)).toBeVisible();
}

/** Reload until `locator` shows up; the invoice and export pages reflect background work. */
async function reloadUntil(page: Page, check: () => Promise<boolean>, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "networkidle" });
  }
  throw new Error("timed out waiting for background processing");
}

test.describe("invoice workflow end to end", () => {
  test.setTimeout(300_000);

  test("upload to export", async ({ browser }) => {
    const admin = await newAdmin(browser, "Workflow Ltd");
    const page = admin.page;
    const integrations = await healthIntegrations(page);
    const missing = [
      !integrations.storage && "document storage (E2E_S3_*)",
      !integrations.malwareScan && "malware scanning (E2E_CLAMAV_HOST)",
      !integrations.aiExtraction && "extraction (E2E_EXTRACTION_PROVIDER=fixture)",
    ].filter(Boolean);
    // CI sets E2E_REQUIRE_WORKFLOW so a misconfigured job fails instead of skipping to green.
    if (process.env.E2E_REQUIRE_WORKFLOW) expect(missing, "integrations required for the workflow spec").toEqual([]);
    test.skip(missing.length > 0, `not configured for e2e: ${missing.join(", ")}`);

    for (const kind of Object.keys(CSV) as (keyof typeof CSV)[]) await importCsv(page, kind);

    // Upload the PDF through the real upload page.
    await page.goto("/invoices/upload", { waitUntil: "networkidle" });
    await page.locator("#invoice-files").setInputFiles({ name: "INV-10042.pdf", mimeType: "application/pdf", buffer: fixturePdf("invoice-confident") });
    await expect(page.getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "View", exact: true }).click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);

    // Worker: scan → extract → match → check.
    await reloadUntil(page, async () => (await page.getByRole("link", { name: /price above/i }).count()) > 0);
    await expect(page.getByText("INV-10042").first()).toBeVisible();
    await expect(page.locator('iframe[title^="Original document"]')).toBeVisible();

    // Review the price variance next to the original document and decide it.
    await page.getByRole("link", { name: /price above/i }).first().click();
    await page.waitForURL(/\/exceptions\/[0-9a-f-]{36}$/);
    await expect(page.locator("iframe").first()).toBeVisible();
    await expect(page.getByText(/90\.00/).first()).toBeVisible();
    await expect(page.getByText(/100\.00/).first()).toBeVisible();
    await page.getByLabel(/Request supplier correction/).check();
    await page.getByLabel(/^Reason/).fill("Agreement AGR-1 price is 90.00 per box");
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect(page.getByText("Correction requested").first()).toBeVisible();

    // Export discrepancies and download the file through the signed URL.
    await page.goto("/reports?from=2026-01-01&to=2026-12-31", { waitUntil: "networkidle" });
    await page.getByLabel(/^Discrepancies/).check();
    await page.getByRole("button", { name: "Create CSV export" }).click();
    await reloadUntil(page, async () => (await page.getByRole("link", { name: "Download" }).count()) > 0);
    const href = await page.getByRole("link", { name: "Download" }).first().getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.ok()).toBe(true);
    const csv = await res.text();
    expect(csv).toContain("INV-10042");
    expect(csv).toMatch(/price_variance|Price variance/i);

    // Another tenant can't download it.
    const other = await newAdmin(browser, "Not Workflow Ltd");
    const denied = await other.page.request.get(href!, { maxRedirects: 0 });
    expect(denied.status()).toBeGreaterThanOrEqual(400);

    await other.context.close();
    await admin.context.close();
  });
});
