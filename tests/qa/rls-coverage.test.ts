import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { testDbUrl } from "../helpers";

/**
 * Schema-wide isolation sweep. Instead of listing tables by hand, find every
 * table with an `org_id` column and require RLS to be enabled AND forced, with
 * a policy that keys on app_current_org(). New module tables are covered the
 * moment their migration lands.
 */

// Tables that carry org_id but are deliberately not tenant-scoped by RLS.
// Each entry needs a reason; keep this list short.
const NOT_TENANT_SCOPED: Record<string, string> = {};

async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: testDbUrl() });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

describe("row-level security coverage", () => {
  it("connects as a role that cannot bypass RLS", async () => {
    const [r] = await query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("every table with org_id has RLS enabled and forced", async () => {
    const rows = await query<{ table: string; enabled: boolean; forced: boolean }>(`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`);
    expect(rows.length).toBeGreaterThan(10);
    const unprotected = rows.filter((r) => !NOT_TENANT_SCOPED[r.table] && !(r.enabled && r.forced)).map((r) => r.table);
    expect(unprotected, "tables with org_id missing ENABLE/FORCE ROW LEVEL SECURITY").toEqual([]);
  });

  it("every tenant table has a policy that filters reads and writes by app_current_org()", async () => {
    const tables = await query<{ table: string }>(`
      select c.relname as table from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')`);
    const policies = await query<{ tablename: string; cmd: string; qual: string | null; with_check: string | null }>(
      `select tablename, cmd, qual, with_check from pg_policies where schemaname = 'public'`,
    );
    const problems: string[] = [];
    for (const { table } of tables) {
      if (NOT_TENANT_SCOPED[table]) continue;
      const ps = policies.filter((p) => p.tablename === table);
      if (ps.length === 0) {
        problems.push(`${table}: no policy`);
        continue;
      }
      const all = ps.find((p) => p.cmd === "ALL");
      if (!all) problems.push(`${table}: no FOR ALL policy`);
      else {
        if (!all.qual?.includes("app_current_org()")) problems.push(`${table}: USING does not check app_current_org()`);
        if (!all.with_check?.includes("app_current_org()")) problems.push(`${table}: WITH CHECK does not check app_current_org()`);
      }
      // A permissive extra policy would widen access (policies are OR-ed).
      for (const p of ps.filter((x) => x !== all)) {
        if (!p.qual?.includes("app_current_org()") && !p.with_check?.includes("app_current_org()")) problems.push(`${table}: extra policy (${p.cmd}) not scoped to org`);
      }
    }
    expect(problems).toEqual([]);
  });
});
