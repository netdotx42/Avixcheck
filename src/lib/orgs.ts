import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { invitations, memberships, organizations, users } from "@/db/schema";
import { withSystem, withTenant } from "@/db/tenant";
import { audit } from "./audit";
import { assertCan, ForbiddenError, type Role } from "./auth/permissions";
import { parseOrgSettings } from "./org-settings";

export class DomainError extends Error {
  readonly status = 422;
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "DomainError";
  }
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Create an organisation; the creator becomes its first Admin. */
export async function createOrganization(userId: string, input: { name: string; baseCurrency?: string; isDemo?: boolean }) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new DomainError("Organisation name must be 2–120 characters", "invalid_name");
  const currency = (input.baseCurrency ?? "GBP").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError("Base currency must be an ISO 4217 code", "invalid_currency");
  return withSystem(async (tx) => {
    const slug = `${slugify(name)}-${randomBytes(3).toString("hex")}`;
    const [org] = await tx
      .insert(organizations)
      .values({ name, slug, baseCurrency: currency, isDemo: input.isDemo ?? false, settings: parseOrgSettings({}) })
      .returning();
    await tx.insert(memberships).values({ orgId: org!.id, userId, role: "admin" });
    await audit(tx, { orgId: org!.id, actorUserId: userId, action: "org.created", entityType: "organization", entityId: org!.id, data: { name, isDemo: org!.isDemo } });
    return org!;
  });
}

const INVITE_TTL_DAYS = 7;

/** Create an invitation. Returns the raw token exactly once; only its hash is stored. */
export async function createInvitation(actor: { userId: string; orgId: string; role: Role }, input: { email: string; role: Role }) {
  assertCan(actor.role, "members.manage");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("Enter a valid email address", "invalid_email");
  const token = randomBytes(32).toString("base64url");
  return withTenant(actor.orgId, async (tx) => {
    const [inv] = await tx
      .insert(invitations)
      .values({
        orgId: actor.orgId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: actor.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86400_000),
      })
      .returning();
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "member.invited", entityType: "invitation", entityId: inv!.id, data: { email, role: input.role } });
    return { invitation: inv!, token };
  });
}

/**
 * Accept an invitation. The signed-in user's email must match the invited email.
 * Idempotent: accepting twice by the same user returns the existing membership.
 */
export async function acceptInvitation(user: { id: string; email: string }, token: string) {
  return withSystem(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token))).for("update");
    if (!inv || inv.revokedAt) throw new DomainError("This invitation is not valid", "invalid_invitation");
    if (inv.acceptedAt) {
      if (inv.acceptedBy === user.id) return { orgId: inv.orgId, role: inv.role };
      throw new DomainError("This invitation has already been used", "invitation_used");
    }
    if (inv.expiresAt < new Date()) throw new DomainError("This invitation has expired", "invitation_expired");
    if (inv.email !== user.email.toLowerCase()) throw new ForbiddenError();
    await tx.insert(memberships).values({ orgId: inv.orgId, userId: user.id, role: inv.role }).onConflictDoNothing();
    await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: user.id }).where(eq(invitations.id, inv.id));
    await audit(tx, { orgId: inv.orgId, actorUserId: user.id, action: "member.joined", entityType: "membership", entityId: user.id, data: { role: inv.role, invitationId: inv.id } });
    return { orgId: inv.orgId, role: inv.role };
  });
}

export async function revokeInvitation(actor: { userId: string; orgId: string; role: Role }, invitationId: string) {
  assertCan(actor.role, "members.manage");
  return withTenant(actor.orgId, async (tx) => {
    const res = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .returning({ id: invitations.id });
    if (res.length === 0) throw new DomainError("Invitation not found or already closed", "not_found");
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "member.invitation_revoked", entityType: "invitation", entityId: invitationId });
  });
}

async function adminCount(tx: Parameters<Parameters<typeof withTenant>[1]>[0], orgId: string, excludingUserId: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin"), ne(memberships.userId, excludingUserId)));
  return r?.n ?? 0;
}

/** Change a member's role. An organisation must always keep at least one Admin. */
export async function changeMemberRole(actor: { userId: string; orgId: string; role: Role }, memberUserId: string, role: Role) {
  assertCan(actor.role, "members.manage");
  return withTenant(actor.orgId, async (tx) => {
    const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, actor.orgId), eq(memberships.userId, memberUserId))).for("update");
    if (!m) throw new DomainError("Member not found", "not_found");
    if (m.role === "admin" && role !== "admin" && (await adminCount(tx, actor.orgId, memberUserId)) === 0) {
      throw new DomainError("An organisation needs at least one Admin", "last_admin");
    }
    await tx.update(memberships).set({ role }).where(eq(memberships.id, m.id));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "member.role_changed", entityType: "membership", entityId: memberUserId, data: { from: m.role, to: role } });
  });
}

export async function removeMember(actor: { userId: string; orgId: string; role: Role }, memberUserId: string) {
  assertCan(actor.role, "members.manage");
  return withTenant(actor.orgId, async (tx) => {
    const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, actor.orgId), eq(memberships.userId, memberUserId))).for("update");
    if (!m) throw new DomainError("Member not found", "not_found");
    if (m.role === "admin" && (await adminCount(tx, actor.orgId, memberUserId)) === 0) {
      throw new DomainError("An organisation needs at least one Admin", "last_admin");
    }
    await tx.delete(memberships).where(eq(memberships.id, m.id));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.userId, action: "member.removed", entityType: "membership", entityId: memberUserId, data: { role: m.role } });
  });
}

export async function listMembers(orgId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role, joinedAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(users.email),
  );
}
