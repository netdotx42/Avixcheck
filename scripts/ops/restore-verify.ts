/**
 * Restore drill: restore a backup into a throwaway database and prove it matches.
 *
 *   RESTORE_ADMIN_DATABASE_URL=postgres://superuser@host/postgres \
 *     npm run ops:restore-verify -- ./backups/<name>.manifest.json [--keep] [--report out.json]
 *
 * Exit 0 only if the dump checksum, every table's row count and checksum, and the
 * storage listing all verify. Record the report in the restore-drill log (RUNBOOK.md).
 */
import { writeFile } from "node:fs/promises";
import { verifyRestore } from "../../src/modules/ops/backup";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const manifestPath = process.argv.slice(2).find((a) => a.endsWith(".manifest.json"));
  if (!manifestPath) throw new Error("Pass the path to a <name>.manifest.json");
  const adminUrl = process.env.RESTORE_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("Set RESTORE_ADMIN_DATABASE_URL (a role that can CREATE DATABASE; never the production database)");
  const report = await verifyRestore({ manifestPath, adminUrl, keep: process.argv.includes("--keep") });
  const out = arg("report");
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ level: report.ok ? "info" : "error", msg: report.ok ? "restore verified" : "restore verification FAILED", ...report }));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ level: "error", msg: "restore drill failed", error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
