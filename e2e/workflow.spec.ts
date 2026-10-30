import { expect, test } from "@playwright/test";
import { healthIntegrations, newAdmin } from "./fixtures";

/**
 * Full upload → scan → extraction → matching → review → decision → export flow.
 *
 * It needs the imports, documents and engine modules plus real storage and a
 * malware scanner (E2E_S3_*, E2E_CLAMAV_HOST) and the test-only extraction
 * fixture provider. Until those exist the test skips and says why; it never
 * reports a pass for a flow it did not run.
 */
test.describe("invoice workflow end to end", () => {
  test("upload to export", async ({ browser }) => {
    const admin = await newAdmin(browser, "Workflow Ltd");
    const page = admin.page;

    const upload = await page.goto("/invoices/upload");
    test.skip(!upload || upload.status() === 404, "invoice upload page is not built yet (documents module)");
    const integrations = await healthIntegrations(page);
    test.skip(!integrations.storage, "document storage not configured for e2e (set E2E_S3_*)");
    test.skip(!integrations.malwareScan, "malware scanning not configured for e2e (set E2E_CLAMAV_HOST)");

    // Reached only once the modules land; the steps below are filled in against their UI.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    test.fixme(true, "workflow steps pending imports/documents/engine PRs");
    await admin.context.close();
  });
});
