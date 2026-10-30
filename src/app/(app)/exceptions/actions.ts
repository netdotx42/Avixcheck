"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrg } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/permissions";
import { DomainError } from "@/lib/orgs";
import { assignException, bulkAssign, ConflictError, decideException, recordConfirmedCorrection, startReview } from "@/modules/exceptions/service";

export type ActionState = { ok: true; message: string } | { ok: false; error: string; conflict?: boolean } | null;

const uuid = z.string().uuid();
const revision = z.coerce.number().int().positive();

function actorOf(ctx: Awaited<ReturnType<typeof requireOrg>>) {
  return { userId: ctx.user.id, orgId: ctx.orgId, role: ctx.role };
}

/** Turn expected failures into a message for the form; anything else is rethrown to the error boundary. */
function toState(e: unknown): ActionState {
  if (e instanceof ConflictError) return { ok: false, error: e.message, conflict: true };
  if (e instanceof DomainError) return { ok: false, error: e.message };
  if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
  if (e instanceof z.ZodError) return { ok: false, error: "The form was incomplete. Reload and try again." };
  throw e;
}

function refresh(id?: string) {
  revalidatePath("/exceptions");
  if (id) revalidatePath(`/exceptions/${id}`);
}

export async function assignAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireOrg("exception.assign");
    const exceptionId = uuid.parse(fd.get("exceptionId"));
    const raw = String(fd.get("assigneeUserId") ?? "");
    const assigneeUserId = raw === "me" ? ctx.user.id : raw ? uuid.parse(raw) : null;
    await assignException(actorOf(ctx), { exceptionId, revision: revision.parse(fd.get("revision")), assigneeUserId });
    refresh(exceptionId);
    return { ok: true, message: assigneeUserId ? "Assigned." : "Unassigned." };
  } catch (e) {
    return toState(e);
  }
}

export async function startReviewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireOrg("exception.decide");
    const exceptionId = uuid.parse(fd.get("exceptionId"));
    await startReview(actorOf(ctx), { exceptionId, revision: revision.parse(fd.get("revision")) });
    refresh(exceptionId);
    return { ok: true, message: "Review started." };
  } catch (e) {
    return toState(e);
  }
}

export async function decideAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireOrg("exception.decide");
    const exceptionId = uuid.parse(fd.get("exceptionId"));
    const decision = z.enum(["accept_variance", "request_correction", "reject_invoice", "dismiss"]).parse(fd.get("decision"));
    const { invoiceStatus } = await decideException(actorOf(ctx), {
      exceptionId,
      revision: revision.parse(fd.get("revision")),
      decision,
      reason: String(fd.get("reason") ?? ""),
      confirmAboveTolerance: fd.get("confirmAboveTolerance") === "on",
    });
    refresh(exceptionId);
    revalidatePath("/invoices");
    return { ok: true, message: `Decision recorded. Invoice is now ${invoiceStatus.replace(/_/g, " ")}.` };
  } catch (e) {
    return toState(e);
  }
}

export async function confirmCorrectionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireOrg("exception.decide");
    const exceptionId = uuid.parse(fd.get("exceptionId"));
    await recordConfirmedCorrection(actorOf(ctx), {
      exceptionId,
      revision: revision.parse(fd.get("revision")),
      amount: String(fd.get("amount") ?? ""),
      reference: String(fd.get("reference") ?? ""),
    });
    refresh(exceptionId);
    revalidatePath("/invoices");
    return { ok: true, message: "Confirmed correction recorded." };
  } catch (e) {
    return toState(e);
  }
}

/** Bulk assign: each checkbox value is `<id>:<revision>` so stale rows are skipped, not overwritten. */
export async function bulkAssignAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireOrg("exception.assign");
    const items = fd.getAll("selected").map((v) => {
      const [id, rev] = String(v).split(":");
      return { id: uuid.parse(id), revision: revision.parse(rev) };
    });
    const raw = String(fd.get("assigneeUserId") ?? "");
    const assigneeUserId = raw === "me" ? ctx.user.id : raw ? uuid.parse(raw) : null;
    const { assigned, skipped } = await bulkAssign(actorOf(ctx), { items, assigneeUserId });
    refresh();
    const note = skipped.length ? ` ${skipped.length} skipped because they changed or were already decided; reload to see them.` : "";
    return { ok: true, message: `${assigned.length} ${assigned.length === 1 ? "exception" : "exceptions"} ${assigneeUserId ? "assigned" : "unassigned"}.${note}` };
  } catch (e) {
    return toState(e);
  }
}
