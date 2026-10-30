import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const clerkEnabled =
  (process.env.AUTH_PROVIDER ?? "clerk") === "clerk" && !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const clerk = clerkEnabled ? clerkMiddleware() : null;

/**
 * Attaches the managed-auth session when Clerk is configured. Authorisation is
 * NOT done here: every page, action and route re-checks membership and role
 * server-side (src/lib/auth/context.ts).
 */
export default function middleware(req: NextRequest, ev: NextFetchEvent) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  if (clerk) return clerk(req, ev);
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)", "/(api|trpc)(.*)"],
};
