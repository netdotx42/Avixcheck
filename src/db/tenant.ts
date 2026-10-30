import { sql } from "drizzle-orm";
import { db, type Tx } from "./client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction scoped to one organisation. Row-level security
 * restricts every tenant table to rows with this org_id, for reads and writes.
 * This is the only way request handlers and job handlers should touch tenant data.
 */
export async function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new Error("withTenant: invalid org id");
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true), set_config('app.bypass_rls', 'off', true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` with RLS bypassed. Only for narrowly-scoped system operations that
 * are inherently cross-tenant: resolving a signed-in user's memberships,
 * accepting invitations, claiming jobs, creating organisations, maintenance.
 * Never pass request-controlled filters through here without an explicit org check.
 */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true), set_config('app.org_id', '', true)`);
    return fn(tx);
  });
}

/**
 * Await several Drizzle queries one after another on the same transaction.
 * A transaction is a single connection, so firing queries in parallel with
 * Promise.all queues them anyway and triggers pg's overlapping-query
 * deprecation. Drizzle builders are lazy, so passing them here runs each in turn.
 */
export async function inSequence<T extends readonly unknown[]>(queries: [...T]): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await q);
  return out as { -readonly [K in keyof T]: Awaited<T[K]> };
}
