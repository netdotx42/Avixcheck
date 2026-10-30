"use server";
import { revalidatePath } from "next/cache";
import { IntegrationNotConfiguredError } from "@/env";
import { requireOrg } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { RateLimitedError } from "@/lib/ratelimit";
import { EXPORT_KINDS, type ExportKind } from "@/modules/exports/definitions";
import { requestExport } from "@/modules/exports/service";
import { parseReportFilters } from "@/modules/reports/filters";

export interface ExportFormState {
  ok?: boolean;
  error?: string;
}

export async function createExportAction(_prev: ExportFormState, formData: FormData): Promise<ExportFormState> {
  const kind = String(formData.get("kind") ?? "");
  if (!(EXPORT_KINDS as readonly string[]).includes(kind)) return { error: "Choose what to export." };
  const { filters, error } = parseReportFilters({
    from: String(formData.get("from") ?? ""),
    to: String(formData.get("to") ?? ""),
    supplier: String(formData.get("supplier") ?? ""),
  });
  if (error) return { error };
  try {
    const ctx = await requireOrg("export.create");
    await requestExport({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, { kind: kind as ExportKind, filters });
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: "Your role can't create exports. Ask an Admin or Reviewer." };
    if (err instanceof IntegrationNotConfiguredError) return { error: `Exports need document storage, which isn't configured (missing ${err.missing.join(", ")}).` };
    if (err instanceof RateLimitedError) return { error: "Too many exports requested. Try again later." };
    logger.error({ err }, "export request failed");
    return { error: "Could not queue the export. Try again." };
  }
  revalidatePath("/reports");
  return { ok: true };
}
