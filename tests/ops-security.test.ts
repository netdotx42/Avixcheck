import { afterEach, describe, expect, it, vi } from "vitest";
import { setupTestEnv, makeOrg } from "./helpers";

setupTestEnv();
const { buildCsp, clerkFrontendApiHost, storageOrigin } = await import("../src/lib/security/csp");
const { enforceRateLimit, policyLimits, rateLimitResponse } = await import("../src/lib/rate-limit-policies");
const { RateLimitedError } = await import("../src/lib/ratelimit");
const { reportError } = await import("../src/lib/logger");
const { initMonitoring, resetMonitoringForTests, scrub } = await import("../src/lib/monitoring");

describe("content security policy", () => {
  const pk = `pk_test_${Buffer.from("clerk.example.accounts.dev$").toString("base64")}`;

  it("derives the Clerk frontend host and storage origin", () => {
    expect(clerkFrontendApiHost(pk)).toBe("clerk.example.accounts.dev");
    expect(clerkFrontendApiHost("garbage")).toBeUndefined();
    expect(storageOrigin({ s3Bucket: "docs", s3Region: "eu-west-2" })).toBe("https://docs.s3.eu-west-2.amazonaws.com");
    expect(storageOrigin({ s3Endpoint: "http://localhost:9000/", s3Bucket: "b", s3ForcePathStyle: "true" })).toBe("http://localhost:9000");
  });

  it("locks down production", () => {
    const csp = buildCsp({ nodeEnv: "production", clerkPublishableKey: pk, s3Bucket: "docs", s3Region: "eu-west-2" });
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("https://clerk.example.accounts.dev");
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com https://docs.s3.eu-west-2.amazonaws.com");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("upgrade-insecure-requests");
  });
});

describe("rate limit policies", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_UPLOAD;
  });

  it("allows overrides via env", () => {
    process.env.RATE_LIMIT_UPLOAD = "3/60";
    expect(policyLimits("upload")).toEqual({ limit: 3, windowSeconds: 60 });
    expect(policyLimits("inviteAccept")).toEqual({ limit: 20, windowSeconds: 3600 });
  });

  it("blocks after the limit and maps to a 429 with Retry-After", async () => {
    process.env.RATE_LIMIT_UPLOAD = "2/60";
    const { admin } = await makeOrg("RL");
    await enforceRateLimit("upload", admin.id);
    await enforceRateLimit("upload", admin.id);
    const err = await enforceRateLimit("upload", admin.id).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    const res = rateLimitResponse(err);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(() => rateLimitResponse(new Error("other"))).toThrow("other");
  });
});

describe("error monitoring", () => {
  afterEach(() => resetMonitoringForTests());

  it("is logs-only without SENTRY_DSN and does not install a hook", async () => {
    delete process.env.SENTRY_DSN;
    expect(await initMonitoring("worker")).toBe("logs-only");
    expect((globalThis as { __avixErrorHook?: unknown }).__avixErrorHook).toBeUndefined();
  });

  it("installs a Sentry hook when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.example.invalid/1";
    try {
      expect(await initMonitoring("web")).toBe("sentry");
      expect(typeof (globalThis as { __avixErrorHook?: unknown }).__avixErrorHook).toBe("function");
    } finally {
      delete process.env.SENTRY_DSN;
    }
  });

  it("reportError forwards to the installed hook", () => {
    const hook = vi.fn();
    (globalThis as { __avixErrorHook?: unknown }).__avixErrorHook = hook;
    const e = new Error("boom");
    reportError(e, { jobId: "j1" });
    expect(hook).toHaveBeenCalledWith(e, { jobId: "j1" });
  });

  it("scrubs sensitive keys from context", () => {
    expect(scrub({ orgId: "o", token: "t", nested: { apiKey: "k", ok: 1 }, list: [{ password: "p" }] })).toEqual({
      orgId: "o",
      token: "[redacted]",
      nested: { apiKey: "[redacted]", ok: 1 },
      list: [{ password: "[redacted]" }],
    });
  });
});
