import { randomUUID } from "node:crypto";
import { resetEnvCache } from "../src/env";

export function testDbUrl() {
  const admin = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://avix:avix@localhost:5432/postgres";
  const u = new URL(admin);
  u.username = "avix_app_test";
  u.password = "avix_app_test";
  u.pathname = "/avixcheck_test";
  return u.toString();
}

export function setupTestEnv() {
  process.env.DATABASE_URL = testDbUrl();
  process.env.AUTH_PROVIDER = "dev";
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  resetEnvCache();
}

export async function makeUser(label = "u") {
  const { upsertUser } = await import("../src/lib/auth/session");
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  return upsertUser({ subject: `dev:${email}`, email, name: label });
}

export async function makeOrg(name = "Org") {
  const { createOrganization } = await import("../src/lib/orgs");
  const admin = await makeUser("admin");
  const org = await createOrganization(admin.id, { name });
  return { org, admin, actor: { userId: admin.id, orgId: org.id, role: "admin" as const } };
}

/** Assert a promise rejects with a Postgres error whose message (or cause) matches. */
export async function expectDbError(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const msg = `${err.message} ${err.cause?.message ?? ""}`;
    if (!re.test(msg)) throw new Error(`Expected error matching ${re}, got: ${msg}`);
    return;
  }
  throw new Error(`Expected rejection matching ${re}`);
}
