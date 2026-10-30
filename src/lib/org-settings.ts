import { z } from "zod";
import { isDecimalString } from "./money/decimal";

const decStr = z.string().refine(isDecimalString, "must be a decimal string");
const tolerance = z.object({ absolute: decStr, percent: decStr });

/** Organisation-level financial rules. Snapshotted into every check run. */
export const orgSettingsSchema = z.object({
  rounding: z.object({
    mode: z.enum(["half_even", "half_up", "half_down", "up", "down"]).default("half_up"),
    /** Round each line amount before summing (true) or round only the total (false). */
    roundPerLine: z.boolean().default(true),
  }).prefault({}),
  tolerances: z.object({
    unitPrice: tolerance.default({ absolute: "0.01", percent: "0" }),
    lineAmount: tolerance.default({ absolute: "0.02", percent: "0" }),
    invoiceTotal: tolerance.default({ absolute: "0.05", percent: "0" }),
    quantity: tolerance.default({ absolute: "0", percent: "0" }),
  }).prefault({}),
  review: z.object({
    /** Extraction or match confidence below this routes to manual review. */
    minExtractionConfidence: decStr.default("0.90"),
    minMatchConfidence: decStr.default("0.90"),
  }).prefault({}),
  retention: z.object({
    documentDays: z.number().int().min(30).max(36500).default(2555),
    exportDays: z.number().int().min(1).max(3650).default(30),
  }).prefault({}),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
  return orgSettingsSchema.parse(raw ?? {});
}
