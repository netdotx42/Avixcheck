import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env, IntegrationNotConfiguredError } from "@/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; tenant- or system-scoped depending on how it was opened. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __avixPool?: Pool; __avixDb?: Db };

export function pool(): Pool {
  if (!globalForDb.__avixPool) {
    const url = env().DATABASE_URL;
    if (!url) throw new IntegrationNotConfiguredError("database", ["DATABASE_URL"]);
    globalForDb.__avixPool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
  }
  return globalForDb.__avixPool;
}

/**
 * Raw database handle. Tenant tables are protected by FORCE RLS, so queries
 * made outside withTenant()/withSystem() see no tenant rows at all.
 */
export function db(): Db {
  if (!globalForDb.__avixDb) globalForDb.__avixDb = drizzle(pool(), { schema });
  return globalForDb.__avixDb;
}

export async function closeDb() {
  await globalForDb.__avixPool?.end();
  globalForDb.__avixPool = undefined;
  globalForDb.__avixDb = undefined;
}

export { schema };
