"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/env";
import { ACTIVE_ORG_COOKIE, resolveMembership } from "@/lib/auth/context";
import { DEV_SESSION_COOKIE, getSessionUser } from "@/lib/auth/session";
import { signValue } from "@/lib/auth/signed-cookie";
import { rateLimit } from "@/lib/ratelimit";

const cookieOpts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };

/** Switch active organisation. Membership is verified before the cookie is set. */
export async function switchOrg(formData: FormData) {
  const orgId = z.string().uuid().parse(formData.get("orgId"));
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const m = await resolveMembership(user.id, orgId);
  if (!m) throw new Error("Not a member of that organisation");
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, { ...cookieOpts, maxAge: 60 * 60 * 24 * 365 });
  redirect("/overview");
}

/** Local development sign-in. Disabled unless AUTH_PROVIDER=dev outside production. */
export async function devSignIn(formData: FormData) {
  const e = env();
  if (e.AUTH_PROVIDER !== "dev" || e.NODE_ENV === "production" || !e.SESSION_SECRET) throw new Error("Development sign-in is disabled");
  const email = z.string().email().parse(String(formData.get("email") ?? "").trim().toLowerCase());
  const name = String(formData.get("name") ?? "").trim().slice(0, 80) || undefined;
  await rateLimit(`dev-signin:${email}`, 20, 60);
  (await cookies()).set(DEV_SESSION_COOKIE, signValue({ email, name }, e.SESSION_SECRET, 60 * 60 * 8), { ...cookieOpts, maxAge: 60 * 60 * 8 });
  redirect("/overview");
}

export async function signOut() {
  const jar = await cookies();
  jar.delete(DEV_SESSION_COOKIE);
  jar.delete(ACTIVE_ORG_COOKIE);
  redirect("/sign-in");
}
