/**
 * Take a verified-ready backup: pg_dump (custom format) + manifest with per-table
 * row counts/checksums + object-storage listing; optionally upload to BACKUP_S3_BUCKET.
 *
 *   BACKUP_DATABASE_URL=... npm run ops:backup -- [--out ./backups] [--name NAME]
 *
 * Exits non-zero on any failure. Logs one JSON line per step (no secrets).
 */
import { backup } from "../../src/modules/ops/backup";
import { documentStorageConfigured, listDocumentStorage, uploadBackupFiles } from "../../src/modules/ops/backup-storage";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const log = (level: string, msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...data }));

async function main() {
  const url = process.env.BACKUP_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set BACKUP_DATABASE_URL (or DATABASE_URL)");
  const outDir = arg("out") ?? process.env.BACKUP_DIR ?? "./backups";
  const withStorage = documentStorageConfigured();
  if (!withStorage) log("warn", "document storage not configured; manifest will not include an object listing");
  const { manifestPath, manifest } = await backup({ databaseUrl: url, outDir, name: arg("name"), listStorage: withStorage ? listDocumentStorage : undefined });
  const rows = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
  log("info", "backup written", { manifestPath, dumpBytes: manifest.dumpBytes, dumpSha256: manifest.dumpSha256, tables: Object.keys(manifest.tables).length, rows, storageObjects: manifest.storage?.objectCount ?? null });
  const files = [manifest.dumpFile, `${manifest.name}.manifest.json`, ...(manifest.storage ? [manifest.storage.listingFile] : [])];
  const uploaded = await uploadBackupFiles(outDir, files);
  if (uploaded.length) log("info", "backup uploaded", { bucket: process.env.BACKUP_S3_BUCKET, keys: uploaded });
  else log("warn", "BACKUP_S3_BUCKET not set; backup is only on local disk. Copy it off this machine.");
}

main().catch((e) => {
  log("error", "backup failed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
