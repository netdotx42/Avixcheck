"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ACTIVE_ORG_COOKIE, requireOrg } from "@/lib/auth/context";
import { getSessionUser } from "@/lib/auth/session";
import { INVITE_TTL_DAYS, acceptInvitation, changeMemberRole, createInvitation, createOrganization, removeMember, revokeInvitation } from "@/lib/orgs";
import { rateLimit } from "@/lib/ratelimit";
import { enforceRateLimit } from "@/lib/rate-limit-policies";
import { env } from "@/env";
import { invitationEmail, sendEmail } from "@/lib/email/resend";
import { logger } from "@/lib/logger";

const role = z.enum(["admin", "reviewer", "viewer"]);
const cookieOpts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 };

export async function createOrgAction(formData: FormData) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  await rateLimit(`org-create:${user.id}`, 5, 3600);
  const org = await createOrganization(user.id, {
    name: String(formData.get("name") ?? ""),
    baseCurrency: String(formData.get("baseCurrency") ?? "GBP"),
    // Demo orgs are only creatable outside production deployments.
    isDemo: formData.get("isDemo") === "on" && env().APP_ENV !== "production",
  });
  (await cookies()).set(ACTIVE_ORG_COOKIE, org.id, cookieOpts);
  redirect("/overview");
}

export type InviteDelivery = "sent" | "not_configured" | "failed";
export type InviteState = { ok: true; link: string; email: string; delivery: InviteDelivery; deliveryError?: string } | { ok: false; error: string } | null;

export async function inviteMemberAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  try {
    const ctx = await requireOrg("members.manage");
    await enforceRateLimit("invite", ctx.orgId);
    const { token, invitation } = await createInvitation(
      { userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role },
      { email: String(formData.get("email") ?? ""), role: role.parse(formData.get("role")) },
    );
    revalidatePath("/settings");
    const base = env().APP_URL ?? "";
    const link = `${base}/invite/${token}`;
    const sent = await sendEmail({
      to: invitation.email,
      ...invitationEmail({ orgName: ctx.orgName, role: invitation.role, link, expiresDays: INVITE_TTL_DAYS }),
      idempotencyKey: `invitation-${invitation.id}`,
    });
    if (sent.status === "sent") logger.info({ orgId: ctx.orgId, invitationId: invitation.id, emailId: sent.id }, "invitation email sent");
    return {
      ok: true,
      link,
      email: invitation.email,
      delivery: sent.status,
      ...(sent.status === "failed" ? { deliveryError: sent.detail } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not create invitation" };
  }
}

export async function acceptInvitationAction(formData: FormData) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  await enforceRateLimit("inviteAccept", user.id);
  const { orgId } = await acceptInvitation(user, String(formData.get("token") ?? ""));
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, cookieOpts);
  redirect("/overview");
}

export async function changeRoleAction(formData: FormData) {
  const ctx = await requireOrg("members.manage");
  await changeMemberRole({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, z.string().uuid().parse(formData.get("userId")), role.parse(formData.get("role")));
  revalidatePath("/settings");
}

export async function removeMemberAction(formData: FormData) {
  const ctx = await requireOrg("members.manage");
  await removeMember({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, z.string().uuid().parse(formData.get("userId")));
  revalidatePath("/settings");
}

export async function revokeInvitationAction(formData: FormData) {
  const ctx = await requireOrg("members.manage");
  await revokeInvitation({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, z.string().uuid().parse(formData.get("invitationId")));
  revalidatePath("/settings");
}
