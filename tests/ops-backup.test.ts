import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestEnv, makeOrg, testDbUrl } from "./helpers";

setupTestEnv();
const { withTenant } = await import("../src/db/tenant");
const { suppliers, documents } = await import("../src/db/schema");
const { backup, verifyRestore } = await import("../src/modules/ops/backup");

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://avix:avix@localhost:5432/postgres";

async function seed() {
  const { org } = await makeOrg("Backup");
  await withTenant(org.id, async (tx) => {
    await tx.insert(suppliers).values([
      { orgId: org.id, code: "S1", name: "Supplier One", aliases: ["One"] },
      { orgId: org.id, code: "S2", name: "Supplier “Two” Ltd", taxId: "GB1" },
    ]);
    await tx.insert(documents).values({
      orgId: org.id,
      storageKey: `org/${org.id}/documents/aaaa.pdf`,
      sha256: "x".repeat(64),
      sizeBytes: 123,
      mimeType: "application/pdf",
      originalName: "a.pdf",
    });
  });
  return org;
}

describe("backup and verified restore", () => {
  it("backs up as the non-superuser app owner (RLS forced) and restores with matching fingerprints", async () => {
    const org = await seed();
    const dir = await mkdtemp(path.join(tmpdir(), "avix-backup-"));
    const key = `org/${org.id}/documents/aaaa.pdf`;
    const { manifestPath, manifest } = await backup({
      databaseUrl: testDbUrl(),
      outDir: dir,
      name: "t1",
      listStorage: async () => ({ bucket: "test", objects: [{ key, size: 123, etag: "e1" }] }),
    });
    // RLS is forced on every tenant table; the backup must still see all rows.
    expect(manifest.tables.suppliers!.rows).toBeGreaterThanOrEqual(2);
    expect(manifest.tables.audit_events!.rows).toBeGreaterThan(0);
    expect(manifest.latestMigration).not.toBeNull();

    const report = await verifyRestore({ manifestPath, adminUrl, scratchDbName: "avix_restore_test_ok" });
    expect(report.errors).toEqual([]);
    expect(report.mismatches).toEqual([]);
    expect(report.dumpChecksumOk).toBe(true);
    expect(report.storage.checked).toBe(true);
    // Other tests' documents may exist; ours must be found.
    expect(report.storage.missingKeys).not.toContain(key);
    expect(report.tablesChecked).toBe(Object.keys(manifest.tables).length);
  });

  it("fails verification when a table does not match the manifest", async () => {
    await seed();
    const dir = await mkdtemp(path.join(tmpdir(), "avix-backup-"));
    const { manifestPath } = await backup({ databaseUrl: testDbUrl(), outDir: dir, name: "t2" });
    const m = JSON.parse(await readFile(manifestPath, "utf8"));
    m.tables.suppliers.rows += 1;
    await writeFile(manifestPath, JSON.stringify(m));
    const report = await verifyRestore({ manifestPath, adminUrl, scratchDbName: "avix_restore_test_bad" });
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((x) => x.table)).toContain("suppliers");
  });

  it("fails verification when the dump is corrupted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "avix-backup-"));
    const { manifestPath, manifest } = await backup({ databaseUrl: testDbUrl(), outDir: dir, name: "t3" });
    const dump = path.join(dir, manifest.dumpFile);
    const bytes = await readFile(dump);
    bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 0xff;
    await writeFile(dump, bytes);
    const report = await verifyRestore({ manifestPath, adminUrl, scratchDbName: "avix_restore_test_corrupt" });
    expect(report.ok).toBe(false);
    expect(report.dumpChecksumOk).toBe(false);
  });

  it("reports live documents whose objects are missing from the storage listing", async () => {
    const org = await seed();
    const dir = await mkdtemp(path.join(tmpdir(), "avix-backup-"));
    const { manifestPath } = await backup({ databaseUrl: testDbUrl(), outDir: dir, name: "t4", listStorage: async () => ({ bucket: "test", objects: [] }) });
    const report = await verifyRestore({ manifestPath, adminUrl, scratchDbName: "avix_restore_test_missing" });
    expect(report.ok).toBe(false);
    expect(report.storage.missingKeys).toContain(`org/${org.id}/documents/aaaa.pdf`);
  });
});
