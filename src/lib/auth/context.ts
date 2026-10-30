import "server-only";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { memberships, organizations } from "@/db/schema";
import { withSystem, withTenant } from "@/db/tenant";
import type { Tx } from "@/db/client";
import { getSessionUser, type SessionUser } from "./session";
import { assertCan, UnauthenticatedError, type Permission, type Role } from "./permissions";

export const ACTIVE_ORG_COOKIE = "avix_org";

export interface OrgContext {
  user: SessionUser;
  orgId: string;
  orgName: string;
  isDemo: boolean;
  role: Role;
}

export interface UserOrg {
  orgId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  role: Role;
}

export async function listUserOrgs(userId: string): Promise<UserOrg[]> {
  return withSystem((tx) =>
    tx
      .select({ orgId: organizations.id, name: organizations.name, slug: organizations.slug, isDemo: organizations.isDemo, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(eq(memberships.userId, userId))
      .orderBy(organizations.name),
  );
}

/** Membership lookup for a specific (user, org). Returns null when not a member. */
export async function resolveMembership(userId: string, orgId: string): Promise<UserOrg | null> {
  const rows = await withSystem((tx) =>
    tx
      .select({ orgId: organizations.id, name: organizations.name, slug: organizations.slug, isDemo: organizations.isDemo, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId))),
  );
  return rows[0] ?? null;
}

/**
 * Resolve the signed-in user's active organisation and role. The org id comes
 * from a cookie but is ALWAYS re-verified against memberships on every request.
 * Returns null when signed in without any membership (onboarding state).
 */
export async function getOrgContext(): Promise<OrgContext | null> {
  const user = await getSessionUser();
  if (!user) throw new UnauthenticatedError();
  const jar = await cookies();
  const wanted = jar.get(ACTIVE_ORG_COOKIE)?.value;
  let m: UserOrg | null = null;
  if (wanted && /^[0-9a-f-]{36}$/i.test(wanted)) m = await resolveMembership(user.id, wanted);
  if (!m) m = (await listUserOrgs(user.id))[0] ?? null;
  if (!m) return null;
  return { user, orgId: m.orgId, orgName: m.name, isDemo: m.isDemo, role: m.role };
}

/** Require an org context with a permission. Throws Unauthenticated/Forbidden. */
export async function requireOrg(permission: Permission): Promise<OrgContext> {
  const ctx = await getOrgContext();
  if (!ctx) throw new UnauthenticatedError();
  assertCan(ctx.role, permission);
  return ctx;
}

/**
 * The standard entry point for server actions and route handlers:
 * authenticate, authorise, then run inside a tenant-scoped transaction.
 */
export async function withOrgPermission<T>(permission: Permission, fn: (tx: Tx, ctx: OrgContext) => Promise<T>): Promise<T> {
  const ctx = await requireOrg(permission);
  return withTenant(ctx.orgId, (tx) => fn(tx, ctx));
}
