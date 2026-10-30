import pino from "pino";

/**
 * Structured JSON logs. Secrets and document contents are redacted; never log
 * raw extraction text, tokens or signed URLs.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "avixcheck", env: process.env.APP_ENV ?? "development" },
  redact: {
    paths: [
      "*.password",
      "*.token",
      "*.secret",
      "*.authorization",
      "*.cookie",
      "*.signedUrl",
      "*.apiKey",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

/**
 * Error monitoring hook. Reports to Sentry when SENTRY_DSN is configured (wired
 * by the ops module); always logs.
 */
export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  logger.error({ ...context, err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, "error");
  const hook = (globalThis as { __avixErrorHook?: (e: unknown, c: Record<string, unknown>) => void }).__avixErrorHook;
  hook?.(err, context);
}
