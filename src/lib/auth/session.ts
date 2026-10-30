import "server-only";
import { cookies } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { env, isConfigured } from "@/env";
import { users } from "@/db/schema";
import { withSystem } from "@/db/tenant";
import { verifyValue } from "./signed-cookie";

export const DEV_SESSION_COOKIE = "avix_dev_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  authSubject: string;
}

interface Identity {
  subject: string;
  email: string;
  name: string | null;
}

async function resolveIdentity(): Promise<Identity | null> {
  const e = env();
  if (!isConfigured("auth")) return null;
  if (e.AUTH_PROVIDER === "dev") {
    if (e.NODE_ENV === "production") return null;
    const jar = await cookies();
    const v = verifyValue<{ email: string; name?: string }>(jar.get(DEV_SESSION_COOKIE)?.value, e.SESSION_SECRET!);
    if (!v) return null;
    return { subject: `dev:${v.email.toLowerCase()}`, email: v.email.toLowerCase(), name: v.name ?? null };
  }
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return null;
  const u = await currentUser();
  const email = u?.primaryEmailAddress?.emailAddress ?? u?.emailAddresses?.[0]?.emailAddress;
  if (!email) return null;
  const name = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || null;
  return { subject: userId, email: email.toLowerCase(), name };
}

/** Returns the signed-in user (upserted into `users`), or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const id = await resolveIdentity();
  if (!id) return null;
  return upsertUser(id);
}

export async function upsertUser(id: Identity): Promise<SessionUser> {
  return withSystem(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({ authSubject: id.subject, email: id.email, name: id.name, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: users.authSubject, set: { email: id.email, name: sql`coalesce(${id.name}, ${users.name})`, lastSeenAt: new Date() } })
      .returning();
    if (!row) {
      const [existing] = await tx.select().from(users).where(eq(users.authSubject, id.subject));
      if (!existing) throw new Error("user upsert failed");
      return { id: existing.id, email: existing.email, name: existing.name, authSubject: existing.authSubject };
    }
    return { id: row.id, email: row.email, name: row.name, authSubject: row.authSubject };
  });
}
