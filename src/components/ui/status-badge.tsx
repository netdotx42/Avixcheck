import { AlertTriangle, CheckCircle2, CircleDashed, Info, Loader2, XCircle, type LucideIcon } from "lucide-react";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "progress";

const TONE: Record<Tone, { icon: LucideIcon; cls: string }> = {
  ok: { icon: CheckCircle2, cls: "text-ok border-ok/40 bg-ok/10" },
  warn: { icon: AlertTriangle, cls: "text-warn border-warn/40 bg-warn/10" },
  danger: { icon: XCircle, cls: "text-danger border-danger/40 bg-danger/10" },
  info: { icon: Info, cls: "text-info border-info/40 bg-info/10" },
  neutral: { icon: CircleDashed, cls: "text-muted border-border bg-surface-2" },
  progress: { icon: Loader2, cls: "text-info border-info/40 bg-info/10" },
};

/** Status is never colour-only: every badge carries an icon and a text label. */
export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  const { icon: Icon, cls } = TONE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon aria-hidden className={`size-3.5 ${tone === "progress" ? "animate-spin motion-reduce:animate-none" : ""}`} />
      {label}
    </span>
  );
}
