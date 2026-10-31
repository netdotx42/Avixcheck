import { afterEach, describe, expect, it } from "vitest";
import { setupTestEnv } from "./helpers";

setupTestEnv();
const { resetEnvCache } = await import("../src/env");
const live = await import("../src/modules/ops/live-checks");

/**
 * Unit tests for the go-live verifier's own logic. The live checks themselves
 * talk to real services; here HTTP providers are replaced with a recording
 * transport, and the database check runs against the real test database.
 */
type Route = (url: string) => Response;
function transport(route: Route) {
  const urls: string[] = [];
  const f = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return route(String(u));
  }) as typeof fetch;
  return { f, urls };
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});

function setEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars);
  resetEnvCache();
}

describe("verdict and roll-up", () => {
  it("never treats a skipped required check as passed", () => {
    const v = live.verdict([
      { check: "database", required: true, status: "pass", steps: [], durationMs: 1 },
      { check: "aiExtraction", required: true, status: "skip", steps: [], durationMs: 1 },
      { check: "email", required: false, status: "skip", steps: [], durationMs: 1 },
    ]);
    expect(v.ok).toBe(false);
    expect(v.blocking).toEqual(["aiExtraction: not verified (skipped)"]);
  });

  it("fails on any failed step, warns on warn or partial skip", () => {
    expect(live.rollUp([{ name: "a", status: "pass" }, { name: "b", status: "fail" }])).toBe("fail");
    expect(live.rollUp([{ name: "a", status: "pass" }, { name: "b", status: "warn" }])).toBe("warn");
    expect(live.rollUp([{ name: "a", status: "pass" }, { name: "b", status: "skip" }])).toBe("warn");
    expect(live.rollUp([{ name: "a", status: "skip" }])).toBe("skip");
    expect(live.rollUp([])).toBe("skip");
  });
});

describe("database check (real test database)", () => {
  it("passes RLS, role and migration checks for the non-superuser test role", async () => {
    const steps = await live.checkDatabase();
    const by = Object.fromEntries(steps.map((s) => [s.name, s]));
    expect(by["connect"]!.status).toBe("pass");
    expect(by["app role cannot bypass row-level security"]!.status).toBe("pass");
    expect(by["all migrations applied"]!.status).toBe("pass");
    expect(by["row-level security forced on tenant tables"]!.status).toBe("pass");
  });

  it("fails the role check when connected as a superuser", async () => {
    const admin = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://avix:avix@localhost:5432/postgres";
    const u = new URL(process.env.DATABASE_URL!);
    const a = new URL(admin);
    u.username = a.username;
    u.password = a.password;
    setEnv({ DATABASE_URL: u.toString() });
    const steps = await live.checkDatabase();
    expect(steps.find((s) => s.name === "app role cannot bypass row-level security")!.status).toBe("fail");
  });
});

describe("Clerk check", () => {
  const host = "clerk.avixcheck.example.com";
  const pk = `pk_live_${Buffer.from(`${host}$`).toString("base64")}`;

  it("decodes the Frontend API host from a publishable key", () => {
    expect(live.clerkFrontendApi(pk)).toBe(host);
    expect(live.clerkFrontendApi("not-a-key")).toBeNull();
  });

  it("refuses development keys when APP_ENV=production and reports a rejected secret", async () => {
    setEnv({ APP_ENV: "production", AUTH_PROVIDER: "clerk", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk.replace("live", "test"), CLERK_SECRET_KEY: "sk_test_abc" });
    const t = transport((u) => new Response("{}", { status: u.includes("api.clerk.com") ? 401 : 200 }));
    const steps = await live.checkAuth(t.f);
    expect(steps[0]).toMatchObject({ name: "production keys in production", status: "fail" });
    expect(steps[1]).toMatchObject({ status: "fail" });
    expect(steps[1]!.detail).toContain("401");
    expect(JSON.stringify(steps)).not.toContain("sk_test_abc");
  });

  it("passes with live keys that Clerk accepts, and leaves MFA as a manual step", async () => {
    setEnv({ APP_ENV: "production", AUTH_PROVIDER: "clerk", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk, CLERK_SECRET_KEY: "sk_live_abc" });
    const t = transport(() => new Response("{}", { status: 200 }));
    const steps = await live.checkAuth(t.f);
    expect(steps.map((s) => s.status)).toEqual(["pass", "pass", "pass", "skip"]);
    expect(t.urls).toContain(`https://${host}/v1/environment`);
    expect(live.rollUp(steps)).toBe("warn");
  });

  it("is skipped, not passed, without keys", async () => {
    setEnv({ AUTH_PROVIDER: "clerk", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "" });
    expect(live.rollUp(await live.checkAuth())).toBe("skip");
  });
});

describe("app check", () => {
  const headers = {
    "strict-transport-security": "max-age=1",
    "content-security-policy": "default-src 'self'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-type": "application/json",
  };

  it("passes a ready deployment with headers and a sign-in redirect", async () => {
    const t = transport((u) => {
      if (u.endsWith("/api/health")) return new Response(JSON.stringify({ status: "ready", database: "ok", integrations: [{ key: "email", configured: true, required: false }] }), { headers });
      if (u.endsWith("/invoices")) return new Response(null, { status: 307, headers: { location: "/sign-in" } });
      return new Response("<html>Sign in</html>", { status: 200, headers });
    });
    const steps = await live.checkApp("https://app.example.com", t.f);
    expect(steps.every((s) => s.status === "pass")).toBe(true);
  });

  it("fails a degraded deployment and names the missing integrations", async () => {
    const t = transport((u) =>
      u.endsWith("/api/health")
        ? new Response(JSON.stringify({ status: "degraded", database: "ok", integrations: [{ key: "aiExtraction", configured: false, required: true }] }), { status: 200 })
        : new Response("ok", { status: 200 }),
    );
    const steps = await live.checkApp("https://app.example.com", t.f);
    const health = steps.find((s) => s.name === "/api/health reports ready")!;
    expect(health.status).toBe("fail");
    expect(health.detail).toContain("aiExtraction");
    expect(steps.find((s) => s.name === "security headers present")!.status).toBe("fail");
    expect(steps.find((s) => s.name === "protected pages require sign-in")!.status).toBe("fail");
  });
});

describe("email check", () => {
  it("skips without a recipient rather than claiming delivery", async () => {
    setEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@example.com" });
    const steps = await live.checkEmail(undefined);
    expect(steps).toEqual([expect.objectContaining({ status: "skip" })]);
  });
});

describe("sample invoice PDF", () => {
  it("is a structurally valid PDF with a correct xref table", () => {
    const pdf = live.textPdf(live.SMOKE_INVOICE.lines).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    const startxref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(pdf).toContain("(Invoice number: SMOKE-20410) '");
  });

  it("uses the real EICAR test string", async () => {
    const { createHash } = await import("node:crypto");
    expect(createHash("md5").update(live.EICAR).digest("hex")).toBe("44d88612fea8a8f36de82e1278abb02f");
  });
});
