import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export const PAGES = [
  { path: "/overview", heading: /overview/i },
  { path: "/invoices", heading: /invoices/i },
  { path: "/exceptions", heading: /exceptions/i },
  { path: "/suppliers", heading: /suppliers/i },
  { path: "/purchase-orders", heading: /purchase orders/i },
  { path: "/reports", heading: /reports/i },
  { path: "/settings", heading: /settings/i },
] as const;

export function uniqueEmail(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}@e2e.test`;
}

/** Sign in through the dev provider form (the same server action users hit). */
export async function signIn(page: Page, email: string, name?: string) {
  await page.goto("/sign-in", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  if (name) await page.getByLabel("Name (optional)").fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(overview|onboarding)/);
}

export async function createOrg(page: Page, name: string, opts: { demo?: boolean } = {}) {
  await page.goto("/onboarding", { waitUntil: "networkidle" });
  await page.getByLabel("Organisation name").fill(name);
  if (opts.demo) await page.getByLabel(/Demo organisation/).check();
  await page.getByRole("button", { name: "Create organisation" }).click();
  await page.waitForURL(/\/overview/);
  await expect(page.getByText(name).first()).toBeVisible();
}

/** A signed-in user with their own org, in an isolated browser context. */
export async function newAdmin(browser: Browser, orgName: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail("admin");
  await signIn(page, email);
  await createOrg(page, orgName);
  return { context, page, email };
}

/** Admin invites `role`; the invitee signs in in a fresh context and accepts. */
export async function inviteMember(admin: Page, browser: Browser, role: "admin" | "reviewer" | "viewer") {
  const email = uniqueEmail(role);
  await admin.goto("/settings", { waitUntil: "networkidle" });
  await admin.getByLabel("Email", { exact: true }).fill(email);
  await admin.getByLabel("Role", { exact: true }).selectOption(role);
  await admin.getByRole("button", { name: "Invite" }).click();
  const link = (await admin.getByRole("status").locator("code").textContent())?.trim();
  if (!link) throw new Error("invitation link not shown");
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  await page.goto(new URL(link).pathname);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await page.waitForURL(/\/overview/);
  return { context, page, email, link };
}

export async function healthIntegrations(page: Page): Promise<Record<string, boolean>> {
  const res = await page.request.get("/api/health");
  const body = (await res.json()) as { integrations: { key: string; configured: boolean }[] };
  return Object.fromEntries(body.integrations.map((i) => [i.key, i.configured]));
}
