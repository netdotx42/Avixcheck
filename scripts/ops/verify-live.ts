/**
 * Go-live verification against the REAL services configured in the environment.
 *
 *   npm run ops:verify-live -- [--only database,storage,...] [--app-url https://...] \
 *     [--email-to you@example.com] [--report golive-evidence/staging.json] [--allow-skip]
 *
 * Checks: database, auth (Clerk), storage (S3), malwareScan (ClamAV + EICAR),
 * aiExtraction (Anthropic, one real call on a sample invoice), errorMonitoring
 * (Sentry test event), email (Resend test email, only with --email-to) and app
 * (deployed /api/health, headers, sign-in, auth redirect).
 *
 * Exit 0 only when every selected required check ran and passed. A skipped
 * required check (integration not configured) fails the run unless
 * --allow-skip is given; it is never reported as passed. Keep the JSON report
 * as go-live evidence.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ALL_CHECKS, runLiveChecks, verdict, type LiveCheckName } from "../../src/modules/ops/live-checks";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const ICON = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" } as const;

async function main() {
  const onlyArg = arg("only");
  const only = onlyArg ? (onlyArg.split(",").map((s) => s.trim()) as LiveCheckName[]) : ALL_CHECKS;
  const unknown = only.filter((c) => !ALL_CHECKS.includes(c));
  if (unknown.length) throw new Error(`Unknown check(s): ${unknown.join(", ")}. Valid: ${ALL_CHECKS.join(", ")}`);

  const startedAt = new Date().toISOString();
  const results = await runLiveChecks(only, { appUrl: arg("app-url"), emailTo: arg("email-to") });
  const v = verdict(results);
  const allowSkip = process.argv.includes("--allow-skip");
  const ok = allowSkip ? results.every((r) => r.status !== "fail") : v.ok;

  for (const r of results) {
    console.log(`${ICON[r.status]}  ${r.check}${r.required ? "" : " (optional)"}  ${r.durationMs}ms`);
    for (const s of r.steps) console.log(`      ${ICON[s.status]}  ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  console.log(ok ? "\nGo-live verification PASSED for the selected checks." : `\nGo-live verification NOT PASSED:\n  - ${v.blocking.join("\n  - ")}`);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    appEnv: process.env.APP_ENV ?? "development",
    release: process.env.APP_RELEASE ?? null,
    checks: only,
    allowSkip,
    ok,
    blocking: v.blocking,
    results,
  };
  const out = arg("report") ?? path.join("golive-evidence", `verify-${report.appEnv}-${startedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`Report written to ${out}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`verify-live failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
