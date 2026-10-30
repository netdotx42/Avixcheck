import { expect, test } from "@playwright/test";
import { inviteMember, newAdmin, PAGES } from "./fixtures";

test.describe("role permissions in the UI and on the server", () => {
  test("reviewer and viewer see read pages but not admin controls", async ({ browser }) => {
    const admin = await newAdmin(browser, "Roles Co");
    for (const role of ["reviewer", "viewer"] as const) {
      const m = await inviteMember(admin.page, browser, role);
      await expect(m.page.getByText(new RegExp(`${role} · Roles Co`, "i")).first()).toBeVisible();
      for (const p of PAGES) {
        await m.page.goto(p.path);
        await expect(m.page.getByRole("heading", { level: 1, name: p.heading }), `${role} ${p.path}`).toBeVisible();
      }
      await m.page.goto("/settings");
      await expect(m.page.getByRole("heading", { name: "Invite people" })).toHaveCount(0);
      await expect(m.page.getByRole("button", { name: "Remove" })).toHaveCount(0);
      // Failed-job recovery is reviewer-visible but admin-only to act on.
      await expect(m.page.getByRole("button", { name: /retry/i })).toHaveCount(0);
      if (role === "viewer") await expect(m.page.getByRole("link", { name: /upload invoices/i })).toHaveCount(0);
      await m.context.close();
    }
    await admin.context.close();
  });

  test("an invitation cannot be accepted by a different signed-in email", async ({ browser }) => {
    const admin = await newAdmin(browser, "Invite Guard Ltd");
    await admin.page.goto("/settings");
    await admin.page.getByLabel("Email", { exact: true }).fill("intended@e2e.test");
    await admin.page.getByRole("button", { name: "Invite" }).click();
    const link = (await admin.page.getByRole("status").locator("code").textContent())!.trim();

    const intruder = await newAdmin(browser, "Intruder Org");
    await intruder.page.goto(new URL(link).pathname);
    await intruder.page.getByRole("button", { name: "Accept invitation" }).click();
    await intruder.page.goto("/overview");
    await expect(intruder.page.getByText("Invite Guard Ltd")).toHaveCount(0);
    await admin.context.close();
    await intruder.context.close();
  });
});
