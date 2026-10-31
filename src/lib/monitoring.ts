import { logger } from "./logger";

type ErrorHook = (err: unknown, context: Record<string, unknown>) => void;
const g = globalThis as { __avixErrorHook?: ErrorHook; __avixMonitoring?: "sentry" | "logs-only" };

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|signed[-_]?url|session/i;

/** Drop values whose key looks sensitive, recursively. Document contents never belong in error context. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
  return out;
}

/**
 * Initialise error monitoring for a process ("web" or "worker"). With SENTRY_DSN
 * set, errors passed to reportError() are sent to Sentry; without it they are
 * only in structured logs, and /setup shows monitoring as not configured.
 * Safe to call more than once.
 */
export async function initMonitoring(service: "web" | "worker"): Promise<"sentry" | "logs-only"> {
  if (g.__avixMonitoring) return g.__avixMonitoring;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    g.__avixMonitoring = "logs-only";
    logger.warn({ process: service }, "SENTRY_DSN not set; errors are reported to logs only");
    return g.__avixMonitoring;
  }
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? "development",
    release: process.env.APP_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
    serverName: service,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0") || 0,
    // Invoice contents, extraction prompts/outputs, query parameters and request
    // bodies are tenant data: never send them to a third party.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) event.request.headers = scrub(event.request.headers) as Record<string, string>;
      }
      if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
      return event;
    },
  });
  Sentry.setTag("service", service);
  g.__avixErrorHook = (err, context) => {
    Sentry.withScope((scope) => {
      const ctx = scrub(context) as Record<string, unknown>;
      for (const key of ["orgId", "jobType", "requestId"] as const) if (typeof ctx[key] === "string") scope.setTag(key, ctx[key] as string);
      scope.setExtras(ctx);
      Sentry.captureException(err);
    });
  };
  g.__avixMonitoring = "sentry";
  logger.info({ process: service }, "error monitoring enabled (Sentry)");
  return g.__avixMonitoring;
}

/** Flush pending Sentry events before the process exits. */
export async function flushMonitoring(timeoutMs = 2000) {
  if (g.__avixMonitoring !== "sentry") return;
  const Sentry = await import("@sentry/node");
  await Sentry.flush(timeoutMs);
}

/** Test helper. */
export function resetMonitoringForTests() {
  g.__avixErrorHook = undefined;
  g.__avixMonitoring = undefined;
}
