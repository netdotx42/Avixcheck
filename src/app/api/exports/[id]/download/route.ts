import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/context";
import { ForbiddenError, UnauthenticatedError } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { rateLimit, RateLimitedError } from "@/lib/ratelimit";
import { ExportError, exportDownloadUrl } from "@/modules/exports/service";

export const dynamic = "force-dynamic";

/**
 * Redirects to a short-lived signed URL for an export in the caller's active
 * organisation. Org and permission are re-checked on every request; the
 * signed URL itself is never logged.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireOrg("export.create");
    await rateLimit(`export-download:${ctx.user.id}`, 60, 300);
    const url = await exportDownloadUrl({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, id);
    return NextResponse.redirect(url, { status: 303, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    const status =
      err instanceof UnauthenticatedError ? 401 : err instanceof ForbiddenError ? 403 : err instanceof RateLimitedError ? 429 : err instanceof ExportError ? err.status : 500;
    if (status === 500) logger.error({ err, exportId: id }, "export download failed");
    const message = status === 500 ? "Could not prepare the download. Try again." : (err as Error).message;
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
