"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db/tenant";
import { audit } from "@/lib/audit";
import { requireOrg } from "@/lib/auth/context";
import { enqueue } from "@/lib/jobs/queue";
import { idempotencyKey, JOB_TYPES } from "@/lib/jobs/registry";
import { currentRequestId } from "@/lib/request-context";
import { setLegalHold } from "@/modules/ops/retention";

/** Place or release a legal hold (documents module can call this from the invoice page). */
export async function setLegalHoldAction(formData: FormData) {
  const ctx = await requireOrg("retention.manage");
  await setLegalHold(
    { userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role },
    z.string().uuid().parse(formData.get("documentId")),
    formData.get("hold") === "on" || formData.get("hold") === "true",
    String(formData.get("reason") ?? ""),
    await currentRequestId(),
  );
  revalidatePath("/invoices");
  revalidatePath("/settings");
}

/** Queue a retention sweep for this organisation now (in addition to the daily one). */
export async function runRetentionSweepAction() {
  const ctx = await requireOrg("retention.manage");
  const requestId = await currentRequestId();
  await withTenant(ctx.orgId, async (tx) => {
    const minute = new Date().toISOString().slice(0, 16);
    const job = await enqueue(tx, {
      orgId: ctx.orgId,
      type: JOB_TYPES.retentionSweep,
      idempotencyKey: idempotencyKey(ctx.orgId, JOB_TYPES.retentionSweep, "manual", minute),
      maxAttempts: 3,
      createdBy: ctx.user.id,
    });
    await audit(tx, { orgId: ctx.orgId, actorUserId: ctx.user.id, action: "retention.sweep_requested", entityType: "job", entityId: job.id, requestId });
  });
  revalidatePath("/settings");
}
