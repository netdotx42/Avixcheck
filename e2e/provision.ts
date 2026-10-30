import { Client } from "pg";
import { runMigrations } from "../src/db/migrate";
import { adminDatabaseUrl, e2eDatabaseUrl, E2E_DB, E2E_ROLE, E2E_ROLE_PASSWORD } from "./env";

/** Recreate the e2e database, owned by a non-superuser role, and apply migrations. */
async function main() {
  const c = new Client({ connectionString: adminDatabaseUrl() });
  await c.connect();
  await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [E2E_DB]);
  await c.query(`drop database if exists ${E2E_DB}`);
  await c.query(
    `do $$ begin if not exists (select 1 from pg_roles where rolname = '${E2E_ROLE}') then create role ${E2E_ROLE} login password '${E2E_ROLE_PASSWORD}' nosuperuser nobypassrls; end if; end $$`,
  );
  await c.query(`create database ${E2E_DB} owner ${E2E_ROLE}`);
  await c.end();
  await runMigrations(e2eDatabaseUrl());
  console.log(`[e2e] provisioned ${E2E_DB}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
