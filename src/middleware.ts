import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { cspFromEnv } from "@/lib/security/csp";

const clerkEnabled =
  (process.env.AUTH_PROVIDER ?? "clerk") === "clerk" && !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const CSP = cspFromEnv();
/** Accept a caller-supplied request id (e.g. from the load balancer) only if it is safe to log. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function next(req: NextRequest) {
  const incoming = req.headers.get("x-request-id");
  const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  res.headers.set("Content-Security-Policy", CSP);
  return res;
}

const clerk = clerkEnabled ? clerkMiddleware((_auth, req) => next(req)) : null;

/**
 * Attaches the managed-auth session when Clerk is configured, a request id
 * (forwarded to handlers and echoed in the response for support), and the CSP.
 * Authorisation is NOT done here: every page, action and route re-checks
 * membership and role server-side (src/lib/auth/context.ts).
 */
export default function middleware(req: NextRequest, ev: NextFetchEvent) {
  if (clerk) return clerk(req, ev);
  return next(req);
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)", "/(api|trpc)(.*)"],
};
