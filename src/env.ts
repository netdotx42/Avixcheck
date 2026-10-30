import { z } from "zod";

/**
 * Environment configuration. Every external integration is optional at parse
 * time so the app can boot and show a clear setup state instead of crashing or
 * pretending to work. Code that needs an integration must call
 * `requireIntegration()` and handle the `IntegrationNotConfiguredError`.
 */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: optionalString,
  APP_ENV: z.enum(["production", "staging", "development", "demo", "test"]).default("development"),

  DATABASE_URL: optionalString,

  AUTH_PROVIDER: z.enum(["clerk", "dev"]).default("clerk"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optionalString,
  CLERK_SECRET_KEY: optionalString,
  SESSION_SECRET: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: optionalString,
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  CLAMAV_HOST: optionalString,
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  ANTHROPIC_API_KEY: optionalString,
  EXTRACTION_MODEL: z.string().default("claude-sonnet-5-5"),
  /** "fixture" replays recorded outputs for end-to-end tests. Only allowed when APP_ENV=test. */
  EXTRACTION_PROVIDER: z.enum(["anthropic", "fixture"]).default("anthropic"),

  SENTRY_DSN: optionalString,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  EMAIL_FROM: optionalString,
  RESEND_API_KEY: optionalString,

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  DEFAULT_RETENTION_DAYS: z.coerce.number().int().positive().default(2555),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    cached = schema.parse(process.env);
    if (cached.NODE_ENV === "production" && cached.AUTH_PROVIDER === "dev") {
      throw new Error("AUTH_PROVIDER=dev is forbidden when NODE_ENV=production");
    }
    if (cached.EXTRACTION_PROVIDER === "fixture" && (cached.NODE_ENV === "production" || cached.APP_ENV !== "test")) {
      throw new Error("EXTRACTION_PROVIDER=fixture is only allowed when APP_ENV=test outside production");
    }
  }
  return cached;
}

/** Test helper: re-read process.env on next access. */
export function resetEnvCache() {
  cached = undefined;
}

export type IntegrationKey = "database" | "auth" | "storage" | "malwareScan" | "aiExtraction" | "errorMonitoring" | "email";

export interface IntegrationStatus {
  key: IntegrationKey;
  label: string;
  configured: boolean;
  required: boolean;
  missing: string[];
  note: string;
}

export function integrationStatus(e: Env = env()): IntegrationStatus[] {
  const check = (vars: [string, string | undefined][]) => vars.filter(([, v]) => !v).map(([k]) => k);

  const authMissing =
    e.AUTH_PROVIDER === "dev"
      ? check([["SESSION_SECRET", e.SESSION_SECRET]])
      : check([
          ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", e.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY],
          ["CLERK_SECRET_KEY", e.CLERK_SECRET_KEY],
        ]);

  const list: Omit<IntegrationStatus, "configured">[] = [
    {
      key: "database",
      label: "PostgreSQL",
      required: true,
      missing: check([["DATABASE_URL", e.DATABASE_URL]]),
      note: "Stores all tenant data, audit events and the job queue.",
    },
    {
      key: "auth",
      label: e.AUTH_PROVIDER === "dev" ? "Authentication (local dev provider)" : "Authentication (Clerk)",
      required: true,
      missing: authMissing,
      note:
        e.AUTH_PROVIDER === "dev"
          ? "Local development sign-in only. Refused in production."
          : "Managed sign-in, MFA and session security.",
    },
    {
      key: "storage",
      label: "Private document storage (S3-compatible)",
      required: true,
      missing: check([
        ["S3_BUCKET", e.S3_BUCKET],
        ["S3_REGION", e.S3_REGION],
        ["S3_ACCESS_KEY_ID", e.S3_ACCESS_KEY_ID],
        ["S3_SECRET_ACCESS_KEY", e.S3_SECRET_ACCESS_KEY],
      ]),
      note: "Invoice PDFs and exports. Accessed only through short-lived signed URLs.",
    },
    {
      key: "malwareScan",
      label: "Malware scanning (ClamAV)",
      required: true,
      missing: check([["CLAMAV_HOST", e.CLAMAV_HOST]]),
      note: "Uploads stay quarantined and are never processed until a scan reports clean.",
    },
    {
      key: "aiExtraction",
      label: e.EXTRACTION_PROVIDER === "fixture" ? "Document extraction (TEST FIXTURE provider)" : "AI document extraction (Anthropic)",
      required: true,
      missing: e.EXTRACTION_PROVIDER === "fixture" ? [] : check([["ANTHROPIC_API_KEY", e.ANTHROPIC_API_KEY]]),
      note:
        e.EXTRACTION_PROVIDER === "fixture"
          ? "End-to-end tests only: replays recorded outputs instead of reading the document. Refused outside APP_ENV=test."
          : "Reads invoice headers and lines. Financial checks never use AI.",
    },
    {
      key: "errorMonitoring",
      label: "Error monitoring (Sentry)",
      required: false,
      missing: check([["SENTRY_DSN", e.SENTRY_DSN]]),
      note: "Without it, errors are only in structured logs.",
    },
    {
      key: "email",
      label: "Invitation email (Resend)",
      required: false,
      missing: check([
        ["RESEND_API_KEY", e.RESEND_API_KEY],
        ["EMAIL_FROM", e.EMAIL_FROM],
      ]),
      note: "Without it, admins copy invitation links manually.",
    },
  ];
  return list.map((i) => ({ ...i, configured: i.missing.length === 0 }));
}

export class IntegrationNotConfiguredError extends Error {
  constructor(public readonly integration: IntegrationKey, public readonly missing: string[]) {
    super(`${integration} is not configured (missing: ${missing.join(", ")})`);
    this.name = "IntegrationNotConfiguredError";
  }
}

export function requireIntegration(key: IntegrationKey): void {
  const s = integrationStatus().find((i) => i.key === key);
  if (!s || !s.configured) throw new IntegrationNotConfiguredError(key, s?.missing ?? []);
}

export function isConfigured(key: IntegrationKey): boolean {
  return integrationStatus().find((i) => i.key === key)?.configured ?? false;
}
