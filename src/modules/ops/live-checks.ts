import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { DeleteObjectCommand, GetBucketVersioningCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, integrationStatus, type IntegrationKey } from "@/env";

/**
 * Go-live verification against the REAL configured services. Every check talks
 * to the live provider with the credentials in the environment; nothing here is
 * mocked. A check whose integration is not configured is reported as "skip",
 * which never counts as passing. Secrets are never included in results.
 */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckStep {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface CheckResult {
  check: LiveCheckName;
  required: boolean;
  status: CheckStatus;
  steps: CheckStep[];
  durationMs: number;
}

export type LiveCheckName = "database" | "auth" | "storage" | "malwareScan" | "aiExtraction" | "errorMonitoring" | "email" | "app";

export const ALL_CHECKS: LiveCheckName[] = ["database", "auth", "storage", "malwareScan", "aiExtraction", "errorMonitoring", "email", "app"];

export interface LiveCheckOptions {
  /** Deployed base URL for the app check, e.g. https://avixcheck.example.com */
  appUrl?: string;
  /** Recipient for a real test email. Without it the email check is skipped. */
  emailTo?: string;
  fetchImpl?: typeof fetch;
}

/** The EICAR anti-malware test string. Harmless; every scanner reports it as infected. */
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

class Steps {
  readonly list: CheckStep[] = [];
  add(name: string, status: CheckStatus, detail?: string) {
    this.list.push({ name, status, ...(detail ? { detail } : {}) });
  }
  async run(name: string, fn: () => Promise<string | void | { status: CheckStatus; detail?: string }>) {
    try {
      const r = await fn();
      if (r && typeof r === "object") this.add(name, r.status, r.detail);
      else this.add(name, "pass", r || undefined);
    } catch (e) {
      this.add(name, "fail", errorText(e));
    }
  }
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Defensive: never echo anything that looks like a credential.
  return msg.replace(/(sk_(live|test)_|re_|sk-ant-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}

/** Worst status wins. A check with only skipped steps is "skip". */
export function rollUp(steps: CheckStep[]): CheckStatus {
  if (steps.some((s) => s.status === "fail")) return "fail";
  if (steps.length === 0 || steps.every((s) => s.status === "skip")) return "skip";
  if (steps.some((s) => s.status === "warn" || s.status === "skip")) return "warn";
  return "pass";
}

function notConfigured(key: IntegrationKey): CheckStep | null {
  const s = integrationStatus().find((i) => i.key === key);
  if (s?.configured) return null;
  return { name: "configuration", status: "skip", detail: `Not configured (missing: ${s?.missing.join(", ") || "unknown"})` };
}

// ─── Database ────────────────────────────────────────────────────────────────

export async function checkDatabase(): Promise<CheckStep[]> {
  const nc = notConfigured("database");
  if (nc) return [nc];
  const s = new Steps();
  const client = new Client({ connectionString: env().DATABASE_URL, connectionTimeoutMillis: 10_000 });
  try {
    await s.run("connect", async () => {
      await client.connect();
      const r = await client.query<{ server_version: string }>("show server_version");
      return `PostgreSQL ${r.rows[0]!.server_version}`;
    });
    if (s.list[0]!.status === "fail") return s.list;
    await s.run("app role cannot bypass row-level security", async () => {
      const r = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      );
      const role = r.rows[0]!;
      if (role.rolsuper || role.rolbypassrls) throw new Error(`role ${role.rolname} is ${role.rolsuper ? "a superuser" : "BYPASSRLS"}; tenant isolation would not be enforced`);
      return `role ${role.rolname}: rolsuper=f, rolbypassrls=f`;
    });
    await s.run("connection uses TLS", async () => {
      const r = await client.query<{ ssl: boolean | null }>("select ssl from pg_stat_ssl where pid = pg_backend_pid()");
      if (r.rows[0]?.ssl) return "TLS on";
      return { status: env().APP_ENV === "production" ? "fail" : "warn", detail: "connection is not encrypted; add sslmode=require to DATABASE_URL" };
    });
    await s.run("all migrations applied", async () => {
      const journal = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] };
      const r = await client.query<{ n: string }>("select count(*)::text as n from drizzle.__drizzle_migrations");
      const applied = Number(r.rows[0]!.n);
      if (applied < journal.entries.length) throw new Error(`${applied} of ${journal.entries.length} migrations applied; run npm run db:migrate`);
      return `${applied} migrations applied`;
    });
    await s.run("row-level security forced on tenant tables", async () => {
      const r = await client.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)`,
      );
      if (r.rows.length) throw new Error(`RLS not forced on: ${r.rows.map((x) => x.relname).join(", ")}`);
      return "every table with org_id has FORCE row-level security";
    });
  } finally {
    await client.end().catch(() => {});
  }
  return s.list;
}

// ─── Authentication (Clerk) ──────────────────────────────────────────────────

/** Clerk publishable keys are `pk_<env>_<base64("<frontend-api-host>$")>`. */
export function clerkFrontendApi(publishableKey: string): string | null {
  const m = publishableKey.match(/^pk_(live|test)_(.+)$/);
  if (!m) return null;
  try {
    const host = Buffer.from(m[2]!, "base64").toString("utf8").replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

export async function checkAuth(fetchImpl: typeof fetch = fetch): Promise<CheckStep[]> {
  const e = env();
  if (e.AUTH_PROVIDER === "dev") {
    return [{ name: "provider", status: e.APP_ENV === "production" || e.NODE_ENV === "production" ? "fail" : "skip", detail: "AUTH_PROVIDER=dev is local-only; deployed environments must use Clerk" }];
  }
  const nc = notConfigured("auth");
  if (nc) return [nc];
  const s = new Steps();
  const pk = e.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!;
  const sk = e.CLERK_SECRET_KEY!;
  await s.run("production keys in production", async () => {
    const live = pk.startsWith("pk_live_") && sk.startsWith("sk_live_");
    if (live) return "pk_live_ / sk_live_";
    if (e.APP_ENV === "production") throw new Error("APP_ENV=production but Clerk keys are development (pk_test_/sk_test_) keys");
    return { status: "warn", detail: "development keys (fine for staging, not for production)" };
  });
  await s.run("secret key accepted by Clerk Backend API", async () => {
    const res = await fetchImpl("https://api.clerk.com/v1/users?limit=1", { headers: { Authorization: `Bearer ${sk}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) throw new Error(`Clerk rejected CLERK_SECRET_KEY (${res.status})`);
    if (!res.ok) throw new Error(`Clerk Backend API responded ${res.status}`);
    return "GET /v1/users → 200";
  });
  await s.run("publishable key resolves to a live Frontend API", async () => {
    const host = clerkFrontendApi(pk);
    if (!host) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not a valid Clerk publishable key");
    const res = await fetchImpl(`https://${host}/v1/environment`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Frontend API ${host} responded ${res.status}`);
    return host;
  });
  s.add("MFA and sign-in policy", "skip", "Not checkable by API: sign in on the deployed app with an MFA-enrolled account (GO-LIVE checklist)");
  return s.list;
}

// ─── Storage (S3-compatible) ─────────────────────────────────────────────────

export async function checkStorage(fetchImpl: typeof fetch = fetch): Promise<CheckStep[]> {
  const nc = notConfigured("storage");
  if (nc) return [nc];
  const e = env();
  const s = new Steps();
  const client = new S3Client({
    region: e.S3_REGION,
    endpoint: e.S3_ENDPOINT,
    forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
    // Only send checksums when an operation requires them: the SDK's newer defaults add
    // x-amz-checksum-mode to presigned URLs, which several S3-compatible services reject.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY! },
  });
  const key = `golive-smoke/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
  const body = `avixcheck go-live smoke ${randomUUID()}`;
  let written = false;
  try {
    await s.run("write object", async () => {
      await client.send(new PutObjectCommand({ Bucket: e.S3_BUCKET, Key: key, Body: body, ContentType: "text/plain", ServerSideEncryption: e.S3_ENDPOINT ? undefined : "AES256" }));
      written = true;
      return `${e.S3_BUCKET}/${key}`;
    });
    if (!written) return s.list;
    await s.run("read object back", async () => {
      const res = await client.send(new GetObjectCommand({ Bucket: e.S3_BUCKET, Key: key }));
      const got = await res.Body!.transformToString();
      if (got !== body) throw new Error("content read back does not match what was written");
    });
    const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket: e.S3_BUCKET, Key: key }), { expiresIn: 60 });
    await s.run("signed URL serves the object", async () => {
      const res = await fetchImpl(signed, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`signed URL responded ${res.status}`);
      if ((await res.text()) !== body) throw new Error("signed URL returned different content");
    });
    await s.run("unsigned URL is refused (bucket is private)", async () => {
      const u = new URL(signed);
      u.search = "";
      const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(15_000) });
      if (res.ok) throw new Error(`anonymous GET returned ${res.status}: the bucket or object is PUBLIC`);
      return `anonymous GET → ${res.status}`;
    });
    await s.run("bucket versioning", async () => {
      const v = await client.send(new GetBucketVersioningCommand({ Bucket: e.S3_BUCKET }));
      if (v.Status === "Enabled") return "Enabled";
      return { status: "warn", detail: `versioning is ${v.Status ?? "off"}; enable it so deleted or overwritten documents can be recovered` };
    }).then(() => {
      // Least-privilege credentials may not be allowed to read bucket config; that is not a failure.
      const last = s.list[s.list.length - 1]!;
      if (last.status === "fail" && /AccessDenied|not authorized|403/i.test(last.detail ?? "")) {
        last.status = "warn";
        last.detail = "app credentials cannot read bucket versioning (expected with least privilege); confirm it in the provider console";
      }
    });
  } finally {
    if (written) {
      await s.run("delete smoke object", async () => {
        await client.send(new DeleteObjectCommand({ Bucket: e.S3_BUCKET, Key: key }));
      });
    }
  }
  return s.list;
}

// ─── Malware scanning (ClamAV) ───────────────────────────────────────────────

export async function checkMalwareScan(): Promise<CheckStep[]> {
  const nc = notConfigured("malwareScan");
  if (nc) return [nc];
  const { scanBuffer } = await import("@/lib/scan/clamav");
  const s = new Steps();
  await s.run("clean file scans clean", async () => {
    const r = await scanBuffer(Buffer.from(`%PDF-1.7\n% avixcheck clean smoke ${randomUUID()}\n%%EOF\n`), 30_000);
    if (r.status !== "clean") throw new Error(r.status === "error" ? r.detail : `unexpectedly infected: ${r.signature}`);
  });
  await s.run("EICAR test file is detected", async () => {
    const r = await scanBuffer(Buffer.from(EICAR), 30_000);
    if (r.status !== "infected") throw new Error(r.status === "error" ? r.detail : "EICAR was NOT detected: uploads would not be protected");
    return r.signature;
  });
  return s.list;
}

// ─── AI extraction (Anthropic) ───────────────────────────────────────────────

/** Smallest valid PDF with real text, so the extraction model has something to read. */
export function textPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = ["BT", "/F1 11 Tf", "14 TL", "56 780 Td", ...lines.map((l) => `(${esc(l)}) '`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const SMOKE_INVOICE = {
  invoiceNumber: "SMOKE-20410",
  poNumber: "PO-77812",
  total: "1446.00",
  lines: [
    "Northwind Industrial Supplies Ltd",
    "VAT No GB123456789",
    "",
    "INVOICE",
    "Invoice number: SMOKE-20410",
    "Invoice date: 2026-10-15",
    "Due date: 2026-11-14",
    "PO number: PO-77812",
    "Currency: GBP",
    "",
    "Line  SKU      Description             Qty  Unit  Unit price   Amount",
    "1     BRK-220  Steel bracket 220mm     100  EA    9.50         950.00",
    "2     BLT-M8   M8 bolt pack            25   PK    10.20        255.00",
    "",
    "Subtotal: 1205.00",
    "VAT 20%: 241.00",
    "Total: 1446.00",
  ],
};

export async function checkAiExtraction(): Promise<CheckStep[]> {
  const nc = notConfigured("aiExtraction");
  if (nc) return [nc];
  if (env().EXTRACTION_PROVIDER !== "anthropic") return [{ name: "provider", status: "fail", detail: `EXTRACTION_PROVIDER=${env().EXTRACTION_PROVIDER}; deployed environments must use anthropic` }];
  const { anthropicExtractionProvider } = await import("@/modules/extraction/anthropic");
  const { normalizeExtraction } = await import("@/modules/extraction/schema");
  const s = new Steps();
  let output: unknown;
  await s.run(`extract a sample invoice with ${env().EXTRACTION_MODEL}`, async () => {
    const r = await anthropicExtractionProvider.extract(textPdf(SMOKE_INVOICE.lines));
    if (r.kind !== "ok") throw new Error(`extraction incomplete: ${r.reason}`);
    output = r.output;
    return `served by ${r.model}`;
  });
  if (output === undefined) return s.list;
  await s.run("output passes schema validation and matches the printed values", async () => {
    const n = normalizeExtraction(output, "0.8");
    if (!n.ok) throw new Error(n.issues.join("; "));
    const h = n.result.header;
    const wrong = [
      h.invoiceNumber !== SMOKE_INVOICE.invoiceNumber && `invoice number ${h.invoiceNumber}`,
      h.poNumberRaw !== SMOKE_INVOICE.poNumber && `PO ${h.poNumberRaw}`,
      h.total !== SMOKE_INVOICE.total && `total ${h.total}`,
      h.currency !== "GBP" && `currency ${h.currency}`,
      n.result.lines.length !== 2 && `${n.result.lines.length} lines`,
    ].filter(Boolean);
    if (wrong.length) throw new Error(`extracted values differ from the sample: ${wrong.join(", ")}`);
    return `${h.invoiceNumber}, ${n.result.lines.length} lines, total ${h.total} ${h.currency}`;
  });
  return s.list;
}

// ─── Error monitoring (Sentry) ───────────────────────────────────────────────

export async function checkErrorMonitoring(): Promise<CheckStep[]> {
  const nc = notConfigured("errorMonitoring");
  if (nc) return [nc];
  const Sentry = await import("@sentry/node");
  const s = new Steps();
  await s.run("send a test event", async () => {
    Sentry.init({ dsn: env().SENTRY_DSN, environment: env().APP_ENV, release: process.env.APP_RELEASE || undefined, serverName: "golive-verify", tracesSampleRate: 0 });
    const id = Sentry.captureMessage(`AvixCheck go-live verification ${new Date().toISOString()}`, "info");
    const flushed = await Sentry.flush(10_000);
    if (!flushed) throw new Error("Sentry did not accept the event within 10s (check the DSN and outbound network)");
    return `event ${id} delivered; confirm it appears in Sentry under environment "${env().APP_ENV}"`;
  });
  return s.list;
}

// ─── Email (Resend) ──────────────────────────────────────────────────────────

export async function checkEmail(emailTo: string | undefined, fetchImpl: typeof fetch = fetch): Promise<CheckStep[]> {
  const nc = notConfigured("email");
  if (nc) return [nc];
  if (!emailTo) return [{ name: "send a test email", status: "skip", detail: "Pass --email-to you@yourdomain to send a real test email" }];
  const { sendEmail } = await import("@/lib/email/resend");
  const s = new Steps();
  await s.run("send a test email", async () => {
    const r = await sendEmail(
      {
        to: emailTo,
        subject: "AvixCheck go-live email test",
        text: "This is a test email from the AvixCheck go-live verification script. No action is needed.",
        html: "<p>This is a test email from the AvixCheck go-live verification script. No action is needed.</p>",
      },
      fetchImpl,
    );
    if (r.status !== "sent") throw new Error(r.status === "failed" ? r.detail : "not configured");
    return `Resend accepted email ${r.id}; confirm it arrived at ${emailTo} (not in spam)`;
  });
  return s.list;
}

// ─── Deployed app ────────────────────────────────────────────────────────────

const REQUIRED_HEADERS = ["strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy"];

export async function checkApp(appUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<CheckStep[]> {
  const base = (appUrl ?? env().APP_URL)?.replace(/\/$/, "");
  if (!base) return [{ name: "configuration", status: "skip", detail: "Pass --app-url or set APP_URL" }];
  const s = new Steps();
  const get = (p: string) => fetchImpl(`${base}${p}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  await s.run("served over HTTPS", async () => {
    if (!base.startsWith("https://")) return { status: env().APP_ENV === "production" ? "fail" : "warn", detail: `${base} is not https` };
  });
  await s.run("/api/health reports ready", async () => {
    const res = await get("/api/health");
    const body = (await res.json().catch(() => null)) as { status?: string; database?: string; integrations?: { key: string; configured: boolean; required: boolean }[] } | null;
    if (!body) throw new Error(`health responded ${res.status} without JSON`);
    const missing = body.integrations?.filter((i) => i.required && !i.configured).map((i) => i.key) ?? [];
    if (body.status !== "ready") throw new Error(`status=${body.status}, database=${body.database}${missing.length ? `, not configured: ${missing.join(", ")}` : ""}`);
    const optional = body.integrations?.filter((i) => !i.required && !i.configured).map((i) => i.key) ?? [];
    return optional.length ? { status: "warn", detail: `ready; optional not configured: ${optional.join(", ")}` } : "ready";
  });
  await s.run("security headers present", async () => {
    const res = await get("/sign-in");
    const missing = REQUIRED_HEADERS.filter((h) => !res.headers.get(h));
    if (res.headers.get("x-powered-by")) missing.push("(x-powered-by should be absent)");
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
    return REQUIRED_HEADERS.join(", ");
  });
  await s.run("sign-in page renders", async () => {
    const res = await get("/sign-in");
    if (res.status !== 200) throw new Error(`/sign-in responded ${res.status}`);
  });
  await s.run("protected pages require sign-in", async () => {
    const res = await get("/invoices");
    if (res.status === 200) {
      const html = await res.text();
      if (!/sign[- ]?in/i.test(html)) throw new Error("/invoices returned 200 to an anonymous request");
    }
    return `anonymous /invoices → ${res.status}`;
  });
  return s.list;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const REQUIRED: Record<LiveCheckName, boolean> = {
  database: true,
  auth: true,
  storage: true,
  malwareScan: true,
  aiExtraction: true,
  errorMonitoring: false,
  email: false,
  app: true,
};

export async function runLiveChecks(only: LiveCheckName[] = ALL_CHECKS, opts: LiveCheckOptions = {}): Promise<CheckResult[]> {
  const f = opts.fetchImpl ?? fetch;
  const impl: Record<LiveCheckName, () => Promise<CheckStep[]>> = {
    database: checkDatabase,
    auth: () => checkAuth(f),
    storage: () => checkStorage(f),
    malwareScan: checkMalwareScan,
    aiExtraction: checkAiExtraction,
    errorMonitoring: checkErrorMonitoring,
    email: () => checkEmail(opts.emailTo, f),
    app: () => checkApp(opts.appUrl, f),
  };
  const results: CheckResult[] = [];
  for (const name of only) {
    const t0 = Date.now();
    let steps: CheckStep[];
    try {
      steps = await impl[name]();
    } catch (e) {
      steps = [{ name: "unexpected error", status: "fail", detail: errorText(e) }];
    }
    results.push({ check: name, required: REQUIRED[name], status: rollUp(steps), steps, durationMs: Date.now() - t0 });
  }
  return results;
}

/**
 * Go-live passes only when every required check selected actually ran and
 * passed (warnings allowed). A skipped required check is a failure: an
 * unconfigured service has not been verified.
 */
export function verdict(results: CheckResult[]): { ok: boolean; blocking: string[] } {
  const blocking = results
    .filter((r) => r.status === "fail" || (r.required && r.status === "skip"))
    .map((r) => `${r.check}: ${r.status === "skip" ? "not verified (skipped)" : "failed"}`);
  return { ok: blocking.length === 0, blocking };
}
