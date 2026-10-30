/** Connection details for the e2e database. The app connects as a non-superuser so RLS applies. */
export const E2E_DB = "avixcheck_e2e";
export const E2E_ROLE = "avix_app_e2e";
const E2E_PASSWORD = "avix_app_e2e";

export function adminDatabaseUrl() {
  return process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://avix:avix@localhost:5432/postgres";
}

export function e2eDatabaseUrl() {
  const u = new URL(adminDatabaseUrl());
  u.username = E2E_ROLE;
  u.password = E2E_PASSWORD;
  u.pathname = `/${E2E_DB}`;
  return u.toString();
}

export const E2E_ROLE_PASSWORD = E2E_PASSWORD;
