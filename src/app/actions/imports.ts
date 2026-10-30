"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrg } from "@/lib/auth/context";
import { rateLimit, RateLimitedError } from "@/lib/ratelimit";
import { reportError } from "@/lib/logger";
import { DomainError } from "@/lib/orgs";
import { ForbiddenError } from "@/lib/auth/permissions";
import { commitImport, discardImport, previewImport } from "@/modules/imports/service";
import { isImportKind } from "@/modules/imports/types";

export type UploadState = { ok: false; error: string } | null;

function userMessage(e: unknown): string {
  if (e instanceof DomainError) return e.message;
  if (e instanceof ForbiddenError) return "Only Admins can import reference data.";
  if (e instanceof RateLimitedError) return "Too many imports in a short time. Wait a few minutes and try again.";
  reportError(e, { area: "imports" });
  return "The import could not be processed. Nothing was changed. Try again, and contact support if it keeps failing.";
}

export async function uploadImportAction(_prev: UploadState, formData: FormData): Promise<UploadState> {
  let batchId: string;
  try {
    const ctx = await requireOrg("reference.import");
    await rateLimit(`import:${ctx.user.id}`, 60, 3600);
    const kind = formData.get("kind");
    if (!isImportKind(kind)) return { ok: false, error: "Choose what you are importing." };
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a CSV file to upload." };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await previewImport({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, { kind, fileName: file.name, bytes });
    batchId = res.batchId;
  } catch (e) {
    return { ok: false, error: userMessage(e) };
  }
  redirect(`/imports/${batchId}`);
}

const id = z.string().uuid();

export type CommitState = { ok: boolean; message: string } | null;

export async function commitImportAction(_prev: CommitState, formData: FormData): Promise<CommitState> {
  try {
    const ctx = await requireOrg("reference.import");
    const batchId = id.parse(formData.get("batchId"));
    const res = await commitImport({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, batchId);
    revalidatePath(`/imports/${batchId}`);
    revalidatePath("/suppliers");
    revalidatePath("/purchase-orders");
    if (res.status === "blocked") return { ok: false, message: `Not committed: ${res.errorCount} row(s) are now invalid because reference data changed since the preview. The errors below are refreshed.` };
    if (res.status === "already_committed") return { ok: true, message: "This import was already committed. Nothing was changed again." };
    return { ok: true, message: "Import committed." };
  } catch (e) {
    return { ok: false, message: userMessage(e) };
  }
}

export async function discardImportAction(formData: FormData) {
  const ctx = await requireOrg("reference.import");
  const batchId = id.parse(formData.get("batchId"));
  await discardImport({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, batchId);
  revalidatePath(`/imports/${batchId}`);
  redirect("/imports");
}
