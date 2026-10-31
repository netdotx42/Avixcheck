import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { integrationStatus } from "@/env";

export const dynamic = "force-dynamic";

/** Liveness + readiness. Reports configuration state without exposing values. */
export async function GET() {
  const integrations = integrationStatus().map(({ key, configured, required }) => ({ key, configured, required }));
  let database: "ok" | "unreachable" | "not_configured" = "not_configured";
  if (integrations.find((i) => i.key === "database")?.configured) {
    try {
      await db().execute(sql`select 1`);
      database = "ok";
    } catch {
      database = "unreachable";
    }
  }
  const ready = database === "ok" && integrations.every((i) => !i.required || i.configured);
  // The deployed commit, so a deploy pipeline can confirm the new release is serving.
  const release = process.env.APP_RELEASE || process.env.RENDER_GIT_COMMIT || null;
  return NextResponse.json({ status: ready ? "ready" : "degraded", release, database, integrations }, { status: database === "ok" ? 200 : 503 });
}
