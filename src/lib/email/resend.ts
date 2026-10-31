import { env, integrationStatus } from "@/env";
import { logger } from "@/lib/logger";

/**
 * Transactional email through the Resend HTTP API. Email is optional: without
 * RESEND_API_KEY and EMAIL_FROM nothing is sent and callers show the
 * invitation link for the admin to share. A failed send is reported as failed,
 * never as delivered.
 */
export type EmailResult = { status: "sent"; id: string } | { status: "not_configured"; missing: string[] } | { status: "failed"; detail: string };

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Resend de-duplicates sends with the same key for 24h, so a retried request cannot send twice. */
  idempotencyKey?: string;
}

const RESEND_URL = "https://api.resend.com/emails";

export async function sendEmail(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<EmailResult> {
  const status = integrationStatus().find((i) => i.key === "email");
  if (!status?.configured) return { status: "not_configured", missing: status?.missing ?? [] };
  const { RESEND_API_KEY, EMAIL_FROM } = env();
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok || !body.id) {
      const detail = `Resend responded ${res.status}${body.name ? ` ${body.name}` : ""}${body.message ? `: ${body.message}` : ""}`;
      logger.warn({ status: res.status }, "email send failed");
      return { status: "failed", detail };
    }
    return { status: "sent", id: body.id };
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, "email send failed");
    return { status: "failed", detail: e instanceof Error ? e.message : "network error" };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function invitationEmail(input: { orgName: string; role: string; link: string; expiresDays: number }) {
  const subject = `You're invited to ${input.orgName} on AvixCheck`;
  const text = [
    `You've been invited to join ${input.orgName} on AvixCheck as ${input.role}.`,
    "",
    `Accept the invitation: ${input.link}`,
    "",
    `The link works once and expires in ${input.expiresDays} days. Sign in with this email address to accept it.`,
    "If you weren't expecting this, you can ignore this email.",
    "",
    "AvixCheck — Every invoice. Checked.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;color:#111827">
<p>You've been invited to join <strong>${escapeHtml(input.orgName)}</strong> on AvixCheck as <strong>${escapeHtml(input.role)}</strong>.</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#2563EB;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p style="color:#6B7280;font-size:13px">The link works once and expires in ${input.expiresDays} days. Sign in with this email address to accept it. If you weren't expecting this, you can ignore this email.</p>
<p style="color:#6B7280;font-size:13px">AvixCheck — Every invoice. Checked.</p>
</div>`;
  return { subject, text, html };
}
