"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrg } from "@/lib/auth/context";
import { confirmMatch, requestRecheck, type ConfirmMatchInput } from "./service";

/** Form action: re-run matching and checks for an invoice (fields: invoiceId, revision). */
export async function recheckInvoiceAction(formData: FormData) {
  const ctx = await requireOrg("invoice.recheck");
  const invoiceId = z.string().uuid().parse(formData.get("invoiceId"));
  const revision = z.coerce.number().int().positive().parse(formData.get("revision"));
  await requestRecheck({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, invoiceId, revision);
  revalidatePath(`/invoices/${invoiceId}`);
}

/** Reviewer confirms or corrects supplier / PO / line matches. Input is re-validated server-side. */
export async function confirmMatchAction(input: ConfirmMatchInput) {
  const ctx = await requireOrg("invoice.edit");
  const res = await confirmMatch({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, input);
  revalidatePath(`/invoices/${input.invoiceId}`);
  return res;
}
