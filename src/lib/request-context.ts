import "server-only";
import { headers } from "next/headers";
import { logger } from "./logger";

/** The request id set by src/middleware.ts. Pass it to audit({ requestId }) and log lines. */
export async function currentRequestId(): Promise<string | null> {
  try {
    return (await headers()).get("x-request-id");
  } catch {
    return null; // outside a request (worker, scripts)
  }
}

/** A child logger tagged with the request id (and anything else you pass). */
export async function requestLogger(bindings: Record<string, unknown> = {}) {
  return logger.child({ requestId: await currentRequestId(), ...bindings });
}
