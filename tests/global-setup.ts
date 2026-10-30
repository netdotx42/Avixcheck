import { Client } from "pg";
import { runMigrations } from "../src/db/migrate";

/**
 * Creates a fresh test database owned by a NON-superuser role, so row-level
 * security is actually enforced in tests (superusers bypass RLS).
 *
 * TEST_ADMIN_DATABASE_URL: a superuser connection (default postgres://avix:avix@localhost:5432/postgres)
 */
export default async function setup() {
  const admin = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://avix:avix@localhost:5432/postgres";
  const u = new URL(admin);
  const dbName = "avixcheck_test";
  const role = "avix_app_test";
  const pw = "avix_app_test";
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  await c.query(`drop database if exists ${dbName}`);
  await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} login password '${pw}' nosuperuser nobypassrls; end if; end $$`);
  await c.query(`create database ${dbName} owner ${role}`);
  await c.end();
  u.username = role;
  u.password = pw;
  u.pathname = `/${dbName}`;
  process.env.DATABASE_URL = u.toString();
  await runMigrations(u.toString());
  return () => {};
}
