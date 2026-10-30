"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrg } from "@/lib/auth/context";
import { cancelJob, retryJob } from "@/lib/jobs/queue";

export async function retryJobAction(formData: FormData) {
  const ctx = await requireOrg("jobs.recover");
  await retryJob({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, z.string().uuid().parse(formData.get("jobId")));
  revalidatePath("/settings");
}

export async function cancelJobAction(formData: FormData) {
  const ctx = await requireOrg("jobs.recover");
  await cancelJob({ userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role }, z.string().uuid().parse(formData.get("jobId")));
  revalidatePath("/settings");
}
