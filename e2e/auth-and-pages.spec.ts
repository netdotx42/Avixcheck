import { expect, test } from "@playwright/test";
import { createOrg, PAGES, signIn, uniqueEmail } from "./fixtures";

test.describe("sign-in, onboarding and the app shell", () => {
  test("signed-out visitors are sent to sign-in from every app page", async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page, p.path).toHaveURL(/\/sign-in/);
    }
  });

  test("a new user creates an organisation and lands on the overview", async ({ page }) => {
    await signIn(page, uniqueEmail("founder"), "Founder");
    await expect(page).toHaveURL(/\/onboarding/);
    await createOrg(page, "Northwind Foods");
    await expect(page.getByRole("heading", { level: 1, name: /overview/i })).toBeVisible();
    await expect(page.getByText("Every invoice. Checked.").first()).toBeVisible();
  });

  test("every page renders for an admin with a heading and no error state", async ({ page }) => {
    await signIn(page, uniqueEmail("pages"));
    await createOrg(page, "Page Tour Ltd");
    for (const p of PAGES) {
      const res = await page.goto(p.path);
      expect(res?.status(), p.path).toBeLessThan(400);
      await expect(page.getByRole("heading", { level: 1, name: p.heading }), p.path).toBeVisible();
      await expect(page.getByText(/something went wrong/i), p.path).toHaveCount(0);
    }
  });

  test("health reports configuration without leaking values", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).toContain('"database":"ok"');
    expect(body).not.toMatch(/postgres:\/\/|secret|password/i);
  });

  test("a forged session cookie is rejected", async ({ page, context }) => {
    await context.addCookies([{ name: "avix_dev_session", value: "eyJlbWFpbCI6ImFkbWluQHguY29tIn0.forged", url: "http://localhost" }]);
    await page.goto("/overview");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
