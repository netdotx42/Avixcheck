import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/context";
import { ForbiddenError, UnauthenticatedError } from "@/lib/auth/permissions";
import { reportError } from "@/lib/logger";
import { RateLimitedError } from "@/lib/ratelimit";
import { enforceRateLimit } from "@/lib/rate-limit-policies";
import { signedGetUrl } from "@/lib/storage";
import { getPreviewableDocument } from "@/modules/documents/queries";
import { isConfigured } from "@/env";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * Redirects to a short-lived signed URL for a document, after checking the
 * caller's membership, `document.view` permission, the document's org (RLS)
 * and that it passed malware scanning. The signed URL itself is never logged.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireOrg("document.view");
    await enforceRateLimit("signedUrl", ctx.user.id);
    if (!isConfigured("storage")) return NextResponse.json({ error: "Document storage is not configured." }, { status: 503, headers: NO_STORE });
    const { id } = await params;
    const found = await getPreviewableDocument(ctx.orgId, id);
    if (!found.ok) {
      if (found.reason === "not_scanned") return NextResponse.json({ error: "This document has not passed malware scanning and cannot be opened." }, { status: 409, headers: NO_STORE });
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    }
    const download = new URL(req.url).searchParams.get("download") === "1";
    const url = await signedGetUrl(ctx.orgId, found.doc.storageKey, { filename: found.doc.originalName, inline: !download });
    return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: NO_STORE });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    if (err instanceof RateLimitedError) return NextResponse.json({ error: "Too many requests. Please wait and try again." }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(err.retryAfterSeconds) } });
    reportError(err, { route: "documents.file" });
    return NextResponse.json({ error: "Could not open the document." }, { status: 500, headers: NO_STORE });
  }
}
