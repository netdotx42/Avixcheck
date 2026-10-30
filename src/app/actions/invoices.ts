"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrg } from "@/lib/auth/context";
import { DomainError } from "@/lib/orgs";
import { correctInvoice } from "@/modules/documents/correction";
import { retryInvoiceProcessing } from "@/modules/documents/service";

export type CorrectionState = { ok: true; revision: number; changed: boolean } | { ok: false; error: string; conflict?: boolean } | null;

const correctionForm = z.object({ invoiceId: z.string().uuid(), revision: z.coerce.number().int().positive(), payload: z.string().max(2_000_000) });

export async function correctInvoiceAction(_prev: CorrectionState, formData: FormData): Promise<CorrectionState> {
  try {
    const ctx = await requireOrg("invoice.edit");
    const f = correctionForm.parse({ invoiceId: formData.get("invoiceId"), revision: formData.get("revision"), payload: formData.get("payload") });
    const input = JSON.parse(f.payload) as unknown;
    const requestId = (await headers()).get("x-request-id");
    const res = await correctInvoice({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role, requestId }, f.invoiceId, f.revision, input as never);
    revalidatePath(`/invoices/${f.invoiceId}`);
    revalidatePath("/invoices");
    return { ok: true, ...res };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message, conflict: e.code === "revision_conflict" };
    if (e instanceof Error && e.name === "ForbiddenError") return { ok: false, error: "Your role cannot edit invoices." };
    return { ok: false, error: "The correction could not be saved. Try again." };
  }
}

export async function retryInvoiceProcessingAction(formData: FormData) {
  const ctx = await requireOrg("jobs.recover");
  const invoiceId = z.string().uuid().parse(formData.get("invoiceId"));
  const requestId = (await headers()).get("x-request-id");
  await retryInvoiceProcessing({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role, requestId }, invoiceId);
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/settings");
}
