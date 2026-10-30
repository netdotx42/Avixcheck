import { NextResponse } from "next/server";
import { rateLimit, RateLimitedError } from "./ratelimit";

/**
 * Named rate-limit policies for abuse-prone routes and actions. Limits are per
 * subject (user or org) per window and are enforced in Postgres, so they hold
 * across app instances. Override with RATE_LIMIT_<NAME>=<limit>/<windowSeconds>.
 */
export const RATE_LIMITS = {
  /** Invoice uploads per user. */
  upload: { limit: 60, windowSeconds: 600 },
  /** CSV reference-data imports per user. */
  import: { limit: 20, windowSeconds: 600 },
  /** Export generation requests per user. */
  export: { limit: 20, windowSeconds: 3600 },
  /** Signed document/export URL requests per user. */
  signedUrl: { limit: 300, windowSeconds: 600 },
  /** Invitations per organisation. */
  invite: { limit: 50, windowSeconds: 3600 },
  /** Invitation accept attempts per user (token guessing). */
  inviteAccept: { limit: 20, windowSeconds: 3600 },
} as const;

export type RateLimitPolicy = keyof typeof RATE_LIMITS;

export function policyLimits(name: RateLimitPolicy): { limit: number; windowSeconds: number } {
  const override = process.env[`RATE_LIMIT_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
  const m = override?.match(/^(\d+)\/(\d+)$/);
  if (m) return { limit: Number(m[1]), windowSeconds: Number(m[2]) };
  return RATE_LIMITS[name];
}

/** Throws RateLimitedError when `subject` exceeds the policy. */
export async function enforceRateLimit(name: RateLimitPolicy, subject: string): Promise<void> {
  const { limit, windowSeconds } = policyLimits(name);
  await rateLimit(`${name}:${subject}`, limit, windowSeconds);
}

/** For route handlers: turn a RateLimitedError into a 429 with Retry-After; rethrow anything else. */
export function rateLimitResponse(err: unknown): NextResponse {
  if (err instanceof RateLimitedError) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } },
    );
  }
  throw err;
}
