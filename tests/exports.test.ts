import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupTestEnv, makeOrg, makeUser } from "./helpers";
import { reportFixtures } from "./report-fixtures";

setupTestEnv();
// Storage credentials so requireIntegration("storage") passes; the S3 client itself is replaced by an in-memory store below.
Object.assign(process.env, { S3_BUCKET: "test-bucket", S3_REGION: "eu-west-2", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test" });
const { resetEnvCache } = await import("../src/env");
resetEnvCache();

const { withTenant } = await import("../src/db/tenant");
const { exportsTable, jobs, auditEvents, memberships } = await import("../src/db/schema");
const { toCsv, csvCell, sanitizeText } = await import("../src/modules/exports/csv");
const svc = await import("../src/modules/exports/service");
const { PermanentJobError } = await import("../src/lib/jobs/queue");
const { ForbiddenError } = await import("../src/lib/auth/permissions");
const { IntegrationNotConfiguredError } = await import("../src/env");

type JobContext = import("../src/lib/jobs/registry").JobContext;

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const signed: { orgId: string; key: string; filename: string }[] = [];
  let failPuts = 0;
  return {
    objects,
    signed,
    failNext(n = 1) {
      failPuts = n;
    },
    put: async (key: string, body: Buffer) => {
      if (failPuts > 0) {
        failPuts--;
        throw new Error("S3 unavailable");
      }
      objects.set(key, body);
    },
    signedUrl: async (orgId: string, key: string, filename: string) => {
      if (!key.startsWith(`org/${orgId}/`)) throw new Error("cross-tenant key");
      signed.push({ orgId, key, filename });
      return `https://signed.example.test/${key}?sig=1`;
    },
  };
}

function jobCtx(orgId: string, exportId: string, attempts = 1, maxAttempts = 4): JobContext {
  return { orgId, workerId: "test", job: { id: crypto.randomUUID(), payload: { exportId }, attempts, maxAttempts } as JobContext["job"] };
}

describe("CSV writer", () => {
  it("neutralises formula injection in text cells", () => {
    for (const bad of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) expect(sanitizeText(bad).startsWith("'")).toBe(true);
    expect(csvCell("=1+1", "text")).toBe("'=1+1");
    expect(csvCell("Acme, Ltd \"UK\"", "text")).toBe('"Acme, Ltd ""UK"""');
    expect(csvCell("line1\nline2", "text")).toBe('"line1\nline2"');
  });

  it("keeps plain decimals numeric, including negative credit-note amounts", () => {
    expect(csvCell("-12.5000", "decimal")).toBe("-12.5000");
    expect(csvCell("0.1000", "decimal")).toBe("0.1000");
    expect(csvCell("-1+cmd", "decimal")).toBe("'-1+cmd");
    expect(csvCell(null, "decimal")).toBe("");
  });

  it("writes a BOM, header and CRLF rows", () => {
    const csv = toCsv([{ header: "a", type: "text", value: (r: { a: string }) => r.a }], [{ a: "x" }]);
    expect(csv).toBe("﻿a\r\nx\r\n");
  });
});

describe("exports", () => {
  let a: Awaited<ReturnType<typeof makeOrg>>;
  let b: Awaited<ReturnType<typeof makeOrg>>;
  let reviewer: { userId: string; orgId: string; role: "reviewer" };

  beforeAll(async () => {
    const fx = await reportFixtures();
    a = await makeOrg("Export A");
    b = await makeOrg("Export B");
    const s1 = await fx.supplier(a.org.id, "S1", "=cmd|' /C calc'!A0");
    const inv = await fx.invoice(a.org.id, { supplierId: s1.id, number: "A-INV-1", status: "exceptions_open", total: "120.0000" });
    const run = await fx.checkRun(a.org.id, inv.id);
    await fx.discrepancy(a.org.id, { invoiceId: inv.id, runId: run.id, amount: "-12.3456", explanation: "@SUM(1+1) injected", status: "correction_requested", confirmed: "10.0000" });
    const old = await fx.checkRun(a.org.id, inv.id, "superseded");
    await fx.discrepancy(a.org.id, { invoiceId: inv.id, runId: old.id, amount: "777.0000" });
    await fx.invoice(a.org.id, { number: "A-CN-1", kind: "credit_note", total: "-5.5000" });
    await fx.invoice(b.org.id, { number: "B-SECRET-1", total: "999.0000" });

    const u = await makeUser("reviewer");
    await withTenant(a.org.id, (tx) => tx.insert(memberships).values({ orgId: a.org.id, userId: u.id, role: "reviewer" }));
    reviewer = { userId: u.id, orgId: a.org.id, role: "reviewer" };
  });

  it("denies viewers", async () => {
    await expect(svc.requestExport({ ...reviewer, role: "viewer" }, { kind: "invoices", filters: {} })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.exportDownloadUrl({ ...reviewer, role: "viewer" }, crypto.randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses to queue an export when storage is not configured", async () => {
    const saved = process.env.S3_BUCKET;
    delete process.env.S3_BUCKET;
    resetEnvCache();
    try {
      await expect(svc.requestExport(reviewer, { kind: "invoices", filters: {} })).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    } finally {
      process.env.S3_BUCKET = saved;
      resetEnvCache();
    }
  });

  it("queues, generates once, and downloads within the tenant", async () => {
    const store = memoryStorage();
    const { id } = await svc.requestExport(reviewer, { kind: "invoices", filters: {} });

    const [job] = await withTenant(a.org.id, (tx) => tx.select().from(jobs).where(eq(jobs.idempotencyKey, `${a.org.id}:export.generate:${id}`)));
    expect(job).toMatchObject({ type: "export.generate", status: "queued", payload: { exportId: id } });

    const res = await svc.generateExport(jobCtx(a.org.id, id), store);
    expect(res).toMatchObject({ exportId: id, rowCount: 2 });
    const key = `org/${a.org.id}/exports/${id}.csv`;
    const csv = store.objects.get(key)!.toString("utf8");
    expect(csv).toContain("A-INV-1");
    expect(csv).toContain("-5.5000");
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(csv).not.toContain(",=cmd");
    expect(csv).not.toContain("B-SECRET-1");

    const [row] = await withTenant(a.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)));
    expect(row).toMatchObject({ status: "ready", storageKey: key, rowCount: 2 });
    const days = (row!.expiresAt!.getTime() - row!.completedAt!.getTime()) / 86_400_000;
    expect(days).toBe(30);

    // Retry of the same job is a no-op: no second object write, no second audit event.
    store.objects.clear();
    expect(await svc.generateExport(jobCtx(a.org.id, id, 2), store)).toMatchObject({ skipped: "ready" });
    expect(store.objects.size).toBe(0);
    const generated = await withTenant(a.org.id, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "export.generated"))));
    expect(generated).toHaveLength(1);

    const url = await svc.exportDownloadUrl(reviewer, id, store);
    expect(url).toContain(key);
    expect(store.signed.at(-1)!.filename).toMatch(/^avixcheck-invoices-\d{4}-\d{2}-\d{2}\.csv$/);
    const actions = (await withTenant(a.org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)))).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["export.requested", "export.generated", "export.downloaded"]));
  });

  it("exports discrepancies and exceptions from current runs only, with decisions and realised savings", async () => {
    const store = memoryStorage();
    const d = await svc.requestExport(reviewer, { kind: "discrepancies", filters: {} });
    await svc.generateExport(jobCtx(a.org.id, d.id), store);
    const dcsv = store.objects.get(`org/${a.org.id}/exports/${d.id}.csv`)!.toString("utf8");
    expect(dcsv).toContain("-12.3456");
    expect(dcsv).toContain("rules@test");
    expect(dcsv).toContain("'@SUM(1+1) injected");
    expect(dcsv).not.toContain("777.0000");

    const e = await svc.requestExport(reviewer, { kind: "exceptions", filters: {} });
    await svc.generateExport(jobCtx(a.org.id, e.id), store);
    const ecsv = store.objects.get(`org/${a.org.id}/exports/${e.id}.csv`)!.toString("utf8");
    const [header, ...lines] = ecsv.replace("﻿", "").trim().split("\r\n");
    expect(header).toContain("confirmed_correction_amount");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("correction_requested");
    expect(lines[0]).toContain("10.0000");
  });

  it("isolates exports between tenants", async () => {
    const store = memoryStorage();
    const { id } = await svc.requestExport(reviewer, { kind: "invoices", filters: {} });
    // Org B's worker context cannot see or generate org A's export.
    await expect(svc.generateExport(jobCtx(b.org.id, id), store)).rejects.toBeInstanceOf(PermanentJobError);
    await svc.generateExport(jobCtx(a.org.id, id), store);
    // Org B's admin cannot download it.
    await expect(svc.exportDownloadUrl(b.actor, id, store)).rejects.toMatchObject({ status: 404 });
    const seenByB = await withTenant(b.org.id, (tx) => tx.select().from(exportsTable));
    expect(seenByB).toHaveLength(0);
  });

  it("refuses downloads that are not ready or have expired", async () => {
    const store = memoryStorage();
    const { id } = await svc.requestExport(reviewer, { kind: "invoices", filters: {} });
    await expect(svc.exportDownloadUrl(reviewer, id, store)).rejects.toMatchObject({ status: 409 });
    await svc.generateExport(jobCtx(a.org.id, id), store);
    const later = new Date(Date.now() + 31 * 86_400_000);
    await expect(svc.exportDownloadUrl(reviewer, id, store, later)).rejects.toMatchObject({ status: 410 });
    const [row] = await withTenant(a.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)));
    expect(row!.status).toBe("expired");
    await expect(svc.exportDownloadUrl(reviewer, id, store)).rejects.toMatchObject({ status: 410 });
  });

  it("retries transient storage failures and marks the export failed only when retries are exhausted", async () => {
    const store = memoryStorage();
    const { id } = await svc.requestExport(reviewer, { kind: "invoices", filters: {} });
    store.failNext(1);
    await expect(svc.generateExport(jobCtx(a.org.id, id, 1, 4), store)).rejects.toThrow(/S3 unavailable/);
    let [row] = await withTenant(a.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)));
    expect(row!.status).toBe("queued");

    store.failNext(1);
    await expect(svc.generateExport(jobCtx(a.org.id, id, 4, 4), store)).rejects.toThrow(/S3 unavailable/);
    [row] = await withTenant(a.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)));
    expect(row).toMatchObject({ status: "failed", error: "S3 unavailable" });

    // Manual recovery (Settings → Retry) re-runs the job and succeeds.
    await svc.generateExport(jobCtx(a.org.id, id, 5, 7), store);
    [row] = await withTenant(a.org.id, (tx) => tx.select().from(exportsTable).where(eq(exportsTable.id, id)));
    expect(row!.status).toBe("ready");
  });

  it("rejects invalid filters and payloads", async () => {
    await expect(svc.requestExport(reviewer, { kind: "invoices", filters: { from: "2026-13-01" } })).rejects.toThrow();
    await expect(svc.requestExport(reviewer, { kind: "secrets" as never, filters: {} })).rejects.toThrow();
    await expect(svc.generateExport({ ...jobCtx(a.org.id, "x"), job: { payload: { exportId: "not-a-uuid" }, attempts: 1, maxAttempts: 4 } as JobContext["job"] })).rejects.toBeInstanceOf(PermanentJobError);
  });
});
