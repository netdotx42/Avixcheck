import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

/**
 * Database backups with verified restoration.
 *
 * backup():
 *   1. Opens a REPEATABLE READ transaction and exports its snapshot.
 *   2. Runs `pg_dump --format=custom --snapshot=<it>`, so the dump and the
 *      fingerprints below describe exactly the same data even under writes.
 *   3. Records per-table row counts and order-independent checksums, the
 *      latest applied migration, and (optionally) an object-storage listing.
 *   4. Writes `<name>.dump`, `<name>.manifest.json` (+ sha256 of the dump).
 *
 * verifyRestore():
 *   1. Checks the dump's sha256 against the manifest.
 *   2. Restores into a brand-new scratch database.
 *   3. Recomputes fingerprints there and compares every table.
 *   4. Checks every live document's storage key appears in the storage listing.
 *   5. Drops the scratch database (unless keep=true) and returns a report.
 *
 * Tables use FORCE ROW LEVEL SECURITY, so sessions set `app.bypass_rls=on`
 * (the same switch withSystem() uses) and pg_dump runs with
 * --enable-row-security. That lets a non-superuser owner role take backups.
 */

export interface TableFingerprint {
  rows: number;
  checksum: string;
}

export interface StorageListing {
  bucket: string;
  objectCount: number;
  totalBytes: number;
  /** sha256 over the sorted "key size etag" lines. */
  listingSha256: string;
  listingFile: string;
}

export interface BackupManifest {
  format: "avixcheck-backup/1";
  name: string;
  createdAt: string;
  dumpFile: string;
  dumpBytes: number;
  dumpSha256: string;
  serverVersion: string;
  latestMigration: { hash: string; createdAt: string } | null;
  tables: Record<string, TableFingerprint>;
  storage: StorageListing | null;
}

export interface StorageObject {
  key: string;
  size: number;
  etag: string;
}

const SESSION_SETUP = `set timezone = 'UTC'; set datestyle = 'ISO, YMD'; set intervalstyle = 'iso_8601'; set extra_float_digits = 3; select set_config('app.bypass_rls', 'on', false);`;

function quoteIdent(s: string) {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Row count + order-independent checksum for every table in `public`. */
export async function fingerprintTables(client: Client): Promise<Record<string, TableFingerprint>> {
  const t = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  const out: Record<string, TableFingerprint> = {};
  for (const { table_name } of t.rows) {
    const q = quoteIdent(table_name);
    const r = await client.query<{ rows: string; checksum: string | null }>(
      `select count(*)::text as rows, md5(coalesce(string_agg(h, '' order by h), '')) as checksum
       from (select md5(x::text) as h from public.${q} x) s`,
    );
    out[table_name] = { rows: Number(r.rows[0]!.rows), checksum: r.rows[0]!.checksum ?? "" };
  }
  return out;
}

async function latestMigration(client: Client): Promise<BackupManifest["latestMigration"]> {
  try {
    const r = await client.query<{ hash: string; created_at: string }>(
      `select hash, created_at::text from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    return r.rows[0] ? { hash: r.rows[0].hash, createdAt: r.rows[0].created_at } : null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("error", (e) => reject(new Error(`${cmd} could not start: ${e.message}. Install the PostgreSQL client tools (same major version as the server).`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().slice(-2000)}`))));
  });
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (d) => h.update(d)).on("end", resolve).on("error", reject);
  });
  return h.digest("hex");
}

/** libpq connection env from a URL (keeps the password out of argv / ps). */
function pgEnv(url: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    ...(u.searchParams.get("sslmode") ? { PGSSLMODE: u.searchParams.get("sslmode")! } : {}),
    PGOPTIONS: "-c app.bypass_rls=on",
    ...extra,
  };
}

export function listingDigest(objects: StorageObject[]) {
  const lines = objects.map((o) => `${o.key} ${o.size} ${o.etag}`).sort();
  return { lines, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

export interface BackupOptions {
  databaseUrl: string;
  outDir: string;
  name?: string;
  /** Lists object storage for the manifest. Omit when storage is not configured. */
  listStorage?: () => Promise<{ bucket: string; objects: StorageObject[] }>;
}

export async function backup(opts: BackupOptions): Promise<{ manifestPath: string; manifest: BackupManifest }> {
  const name = opts.name ?? `avixcheck-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await mkdir(opts.outDir, { recursive: true });
  const dumpFile = `${name}.dump`;
  const dumpPath = path.join(opts.outDir, dumpFile);

  const client = new Client({ connectionString: opts.databaseUrl });
  await client.connect();
  let tables: Record<string, TableFingerprint>;
  let serverVersion: string;
  let migration: BackupManifest["latestMigration"];
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query(SESSION_SETUP);
    const snap = (await client.query<{ s: string }>("select pg_export_snapshot() as s")).rows[0]!.s;
    serverVersion = (await client.query<{ v: string }>("show server_version")).rows[0]!.v;
    // Dump and fingerprint concurrently from the same snapshot; the exporting
    // transaction must stay open until pg_dump has imported it.
    const dump = run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--enable-row-security", `--snapshot=${snap}`, `--file=${dumpPath}`], pgEnv(opts.databaseUrl));
    tables = await fingerprintTables(client);
    migration = await latestMigration(client);
    await dump;
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }

  let storage: StorageListing | null = null;
  if (opts.listStorage) {
    const { bucket, objects } = await opts.listStorage();
    const { lines, sha256 } = listingDigest(objects);
    const listingFile = `${name}.storage.txt`;
    await writeFile(path.join(opts.outDir, listingFile), lines.join("\n") + (lines.length ? "\n" : ""));
    storage = { bucket, objectCount: objects.length, totalBytes: objects.reduce((a, o) => a + o.size, 0), listingSha256: sha256, listingFile };
  }

  const manifest: BackupManifest = {
    format: "avixcheck-backup/1",
    name,
    createdAt: new Date().toISOString(),
    dumpFile,
    dumpBytes: (await stat(dumpPath)).size,
    dumpSha256: await sha256File(dumpPath),
    serverVersion,
    latestMigration: migration,
    tables,
    storage,
  };
  const manifestPath = path.join(opts.outDir, `${name}.manifest.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, manifest };
}

export interface VerifyOptions {
  manifestPath: string;
  /** Superuser (or CREATEDB) connection used to create and drop the scratch database. */
  adminUrl: string;
  scratchDbName?: string;
  keep?: boolean;
}

export interface VerifyReport {
  ok: boolean;
  backup: string;
  scratchDatabase: string;
  dumpChecksumOk: boolean;
  tablesChecked: number;
  rowsChecked: number;
  mismatches: { table: string; expected: TableFingerprint | null; actual: TableFingerprint | null }[];
  storage: { checked: boolean; liveDocuments: number; missingKeys: string[]; listingChecksumOk: boolean | null };
  durationMs: number;
  errors: string[];
}

export async function verifyRestore(opts: VerifyOptions): Promise<VerifyReport> {
  const started = Date.now();
  const manifest = JSON.parse(await readFile(opts.manifestPath, "utf8")) as BackupManifest;
  if (manifest.format !== "avixcheck-backup/1") throw new Error(`Unknown manifest format ${manifest.format}`);
  const dir = path.dirname(opts.manifestPath);
  const dumpPath = path.join(dir, manifest.dumpFile);
  const scratch = opts.scratchDbName ?? `avix_restore_${Date.now()}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(scratch)) throw new Error("invalid scratch database name");

  const report: VerifyReport = {
    ok: false,
    backup: manifest.name,
    scratchDatabase: scratch,
    dumpChecksumOk: false,
    tablesChecked: 0,
    rowsChecked: 0,
    mismatches: [],
    storage: { checked: false, liveDocuments: 0, missingKeys: [], listingChecksumOk: null },
    durationMs: 0,
    errors: [],
  };

  report.dumpChecksumOk = (await sha256File(dumpPath)) === manifest.dumpSha256;
  if (!report.dumpChecksumOk) {
    report.errors.push("Dump file sha256 does not match the manifest (corrupt or tampered)");
    report.durationMs = Date.now() - started;
    return report;
  }

  const admin = new Client({ connectionString: opts.adminUrl });
  await admin.connect();
  const scratchUrl = new URL(opts.adminUrl);
  scratchUrl.pathname = `/${scratch}`;
  try {
    await admin.query(`create database ${quoteIdent(scratch)}`);
    await run("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "--enable-row-security", `--dbname=${scratch}`, dumpPath], pgEnv(scratchUrl.toString(), { PGDATABASE: scratch }));

    const c = new Client({ connectionString: scratchUrl.toString() });
    await c.connect();
    try {
      await c.query(SESSION_SETUP);
      const actual = await fingerprintTables(c);
      const names = new Set([...Object.keys(manifest.tables), ...Object.keys(actual)]);
      for (const t of [...names].sort()) {
        const exp = manifest.tables[t] ?? null;
        const act = actual[t] ?? null;
        report.tablesChecked++;
        report.rowsChecked += act?.rows ?? 0;
        if (!exp || !act || exp.rows !== act.rows || exp.checksum !== act.checksum) report.mismatches.push({ table: t, expected: exp, actual: act });
      }

      if (manifest.storage) {
        const listing = await readFile(path.join(dir, manifest.storage.listingFile), "utf8");
        const lines = listing.split("\n").filter(Boolean);
        report.storage.listingChecksumOk = createHash("sha256").update(lines.join("\n")).digest("hex") === manifest.storage.listingSha256;
        const keys = new Set(lines.map((l) => l.slice(0, l.indexOf(" "))));
        const docs = await c.query<{ storage_key: string }>(`select storage_key from documents where deleted_at is null`);
        report.storage.checked = true;
        report.storage.liveDocuments = docs.rows.length;
        report.storage.missingKeys = docs.rows.map((r) => r.storage_key).filter((k) => !keys.has(k));
      }
    } finally {
      await c.end();
    }
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (!opts.keep) {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [scratch]).catch(() => {});
      await admin.query(`drop database if exists ${quoteIdent(scratch)}`).catch((e) => report.errors.push(`drop scratch db: ${String(e)}`));
    }
    await admin.end();
  }

  report.ok =
    report.errors.length === 0 &&
    report.dumpChecksumOk &&
    report.mismatches.length === 0 &&
    (!report.storage.checked || (report.storage.missingKeys.length === 0 && report.storage.listingChecksumOk === true));
  report.durationMs = Date.now() - started;
  return report;
}
