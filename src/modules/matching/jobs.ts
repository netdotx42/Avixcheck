import { z } from "zod";
import { PermanentJobError } from "@/lib/jobs/queue";
import { JOB_TYPES, registerHandler, type JobContext } from "@/lib/jobs/registry";
import { recordProcessingFailure } from "../checks/service";
import { runMatching } from "./service";

export const invoiceJobPayload = z.object({ invoiceId: z.string().uuid(), revision: z.number().int().positive() });

/**
 * Runs `fn`; on a terminal failure (permanent error or last attempt) the invoice
 * is marked failed with a visible processing_failure exception before the job
 * itself is marked failed by the runner.
 */
export async function withFailureState<T>(ctx: JobContext, stage: "matching" | "checking", fn: (p: z.infer<typeof invoiceJobPayload>) => Promise<T>): Promise<T> {
  const parsed = invoiceJobPayload.safeParse(ctx.job.payload);
  if (!parsed.success) throw new PermanentJobError(`Invalid ${ctx.job.type} payload`);
  try {
    return await fn(parsed.data);
  } catch (err) {
    const terminal = err instanceof PermanentJobError || ctx.job.attempts >= ctx.job.maxAttempts;
    if (terminal) await recordProcessingFailure(ctx.orgId, parsed.data.invoiceId, stage, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

registerHandler(JOB_TYPES.matchInvoice, (ctx) => withFailureState(ctx, "matching", (p) => runMatching(ctx.orgId, p.invoiceId, p.revision)));
