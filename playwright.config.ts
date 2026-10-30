import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { e2eDatabaseUrl } from "./e2e/env";

/**
 * End-to-end tests run the real app (next dev, dev auth provider) against a
 * dedicated Postgres database that e2e/provision.ts recreates on every run.
 * Storage, ClamAV and AI extraction come from E2E_* variables when available;
 * without them the app must show its setup state, and the specs that need
 * those integrations skip with a reason instead of pretending to pass.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;

const passthrough = (names: string[]) => Object.fromEntries(names.filter((n) => process.env[`E2E_${n}`]).map((n) => [n, process.env[`E2E_${n}`]!]));

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  // Keep traces/screenshots outside the project: next dev watches the tree and
  // a write inside it triggers a Fast Refresh that swallows in-flight clicks.
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), "avixcheck-e2e", "results"),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: process.env.E2E_REPORT_DIR ?? path.join(os.tmpdir(), "avixcheck-e2e", "report") }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx tsx e2e/provision.ts && npx next dev -p ${PORT}`,
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      APP_ENV: "test",
      APP_URL: baseURL,
      AUTH_PROVIDER: "dev",
      SESSION_SECRET: "e2e-session-secret-e2e-session-secret",
      DATABASE_URL: e2eDatabaseUrl(),
      LOG_LEVEL: "warn",
      ...passthrough([
        "S3_ENDPOINT",
        "S3_REGION",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_FORCE_PATH_STYLE",
        "CLAMAV_HOST",
        "CLAMAV_PORT",
        "ANTHROPIC_API_KEY",
        "EXTRACTION_PROVIDER",
      ]),
    },
  },
});
