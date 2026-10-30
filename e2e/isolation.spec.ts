import { expect, test } from "@playwright/test";
import { newAdmin, PAGES } from "./fixtures";

test.describe("tenant isolation through the browser", () => {
  test("pointing the active-org cookie at another tenant falls back to your own org", async ({ browser }) => {
    const a = await newAdmin(browser, "Tenant Alpha");
    const b = await newAdmin(browser, "Tenant Beta");
    const alphaId = (await a.context.cookies()).find((c) => c.name === "avix_org")?.value;
    expect(alphaId).toMatch(/^[0-9a-f-]{36}$/);

    await b.context.addCookies([{ name: "avix_org", value: alphaId!, url: "http://localhost" }]);
    for (const p of PAGES) {
      await b.page.goto(p.path);
      await expect(b.page.getByText("Tenant Alpha"), p.path).toHaveCount(0);
      await expect(b.page.getByText("Tenant Beta").first(), p.path).toBeVisible();
    }
    await a.context.close();
    await b.context.close();
  });

  test("members list never shows another tenant's people", async ({ browser }) => {
    const a = await newAdmin(browser, "Members Alpha");
    const b = await newAdmin(browser, "Members Beta");
    await b.page.goto("/settings");
    await expect(b.page.getByText(a.email)).toHaveCount(0);
    await expect(b.page.getByText(b.email).first()).toBeVisible();
    await a.context.close();
    await b.context.close();
  });
});
