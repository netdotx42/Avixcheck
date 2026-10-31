import { afterEach, describe, expect, it } from "vitest";
import { setupTestEnv } from "./helpers";

setupTestEnv();
const { resetEnvCache } = await import("../src/env");
const { invitationEmail, sendEmail } = await import("../src/lib/email/resend");

/** TEST-ONLY transport: records the request instead of calling Resend. */
function transport(status: number, body: unknown) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const msg = { to: "new.user@example.com", subject: "s", text: "t", html: "<p>h</p>", idempotencyKey: "invitation-1" };

function configure(on: boolean) {
  process.env.RESEND_API_KEY = on ? "re_test_not_real" : "";
  process.env.EMAIL_FROM = on ? "AvixCheck <no-reply@example.com>" : "";
  resetEnvCache();
}

afterEach(() => configure(false));

describe("invitation email (Resend)", () => {
  it("sends nothing and reports not_configured without credentials", async () => {
    configure(false);
    const t = transport(200, { id: "x" });
    const r = await sendEmail(msg, t.fetchImpl);
    expect(r).toEqual({ status: "not_configured", missing: ["RESEND_API_KEY", "EMAIL_FROM"] });
    expect(t.calls).toHaveLength(0);
  });

  it("posts to the Resend API with auth and an idempotency key, and returns the email id", async () => {
    configure(true);
    const t = transport(200, { id: "email_123" });
    const r = await sendEmail(msg, t.fetchImpl);
    expect(r).toEqual({ status: "sent", id: "email_123" });
    expect(t.calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(t.calls[0]!.headers.get("authorization")).toBe("Bearer re_test_not_real");
    expect(t.calls[0]!.headers.get("idempotency-key")).toBe("invitation-1");
    expect(t.calls[0]!.body).toMatchObject({ from: "AvixCheck <no-reply@example.com>", to: ["new.user@example.com"], subject: "s" });
  });

  it("reports a rejected send as failed, never as sent", async () => {
    configure(true);
    const t = transport(403, { name: "validation_error", message: "The domain is not verified" });
    const r = await sendEmail(msg, t.fetchImpl);
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.detail).toContain("domain is not verified");
  });

  it("reports a network error as failed", async () => {
    configure(true);
    const r = await sendEmail(msg, (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch);
    expect(r).toEqual({ status: "failed", detail: "ECONNRESET" });
  });

  it("escapes organisation names in the HTML body", () => {
    const e = invitationEmail({ orgName: `<script>x</script> & "Co"`, role: "reviewer", link: "https://app.example.com/invite/abc", expiresDays: 7 });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.text).toContain("https://app.example.com/invite/abc");
  });
});
