import { sql } from "drizzle-orm";
import { withSystem } from "@/db/tenant";

export class RateLimitedError extends Error {
  readonly status = 429;
  constructor(public readonly retryAfterSeconds: number) {
    super("Too many requests");
    this.name = "RateLimitedError";
  }
}

/**
 * Fixed-window rate limiter stored in Postgres so it holds across app instances.
 * Key examples: `upload:${userId}`, `invite:${orgId}`, `export:${userId}`.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const count = await withSystem(async (tx) => {
    const res = await tx.execute(sql`
      insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
      on conflict (key) do update set
        count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else rate_limits.count + 1 end,
        window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else rate_limits.window_start end
      returning count`);
    return Number((res.rows[0] as { count: number }).count);
  });
  if (count > limit) throw new RateLimitedError(windowSeconds);
}
