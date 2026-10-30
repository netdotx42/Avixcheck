import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { requireOrg } from "@/lib/auth/context";
import { ForbiddenError, UnauthenticatedError } from "@/lib/auth/permissions";
import { reportError } from "@/lib/logger";
import { DomainError } from "@/lib/orgs";
import { RateLimitedError } from "@/lib/ratelimit";
import { enforceRateLimit } from "@/lib/rate-limit-policies";
import { uploadInvoiceDocument } from "@/modules/documents/service";

export const dynamic = "force-dynamic";

/** Upload one PDF invoice (multipart field `file`). Returns the invoice id, or the existing one for a duplicate file. */
export async function POST(req: Request) {
  try {
    const ctx = await requireOrg("invoice.upload");
    await enforceRateLimit("upload", ctx.user.id);
    const max = env().MAX_UPLOAD_BYTES;
    // Reject oversize bodies before buffering them (multipart overhead allowance: 64 KB).
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > max + 64 * 1024) return NextResponse.json({ error: `The file is larger than the ${Math.floor(max / (1024 * 1024))} MB upload limit.` }, { status: 413 });

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file was provided." }, { status: 400 });
    if (file.size > max) return NextResponse.json({ error: `The file is larger than the ${Math.floor(max / (1024 * 1024))} MB upload limit.` }, { status: 413 });

    const bytes = Buffer.from(await file.arrayBuffer());
    const requestId = (await headers()).get("x-request-id");
    const result = await uploadInvoiceDocument({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role, requestId }, { bytes, name: file.name });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: "Sign in to upload invoices." }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: "Your role cannot upload invoices." }, { status: 403 });
    if (err instanceof RateLimitedError) return NextResponse.json({ error: "Too many uploads. Wait a few minutes and try again." }, { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } });
    if (err instanceof DomainError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === "storage_not_configured" ? 503 : 422 });
    reportError(err, { route: "invoices.upload" });
    return NextResponse.json({ error: "The upload failed unexpectedly. Try again; if it keeps failing, contact an admin." }, { status: 500 });
  }
}
