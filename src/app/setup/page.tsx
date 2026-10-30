import { CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { Wordmark } from "@/components/brand";
import { integrationStatus } from "@/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup" };

/** Shows which integrations are configured. Lists variable NAMES only, never values. */
export default function SetupPage() {
  const status = integrationStatus();
  const ready = status.filter((s) => s.required).every((s) => s.configured);
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <Wordmark />
      <h1 className="mt-8 text-2xl font-semibold">Setup status</h1>
      <p className="mt-1 text-sm text-muted">
        {ready
          ? "All required integrations are configured."
          : "Some required integrations are missing. Features that depend on them are disabled and show this state instead of simulated results."}
      </p>
      <ul className="mt-6 space-y-3">
        {status.map((s) => {
          const Icon = s.configured ? CheckCircle2 : s.required ? XCircle : MinusCircle;
          const tone = s.configured ? "text-ok" : s.required ? "text-danger" : "text-muted";
          return (
            <li key={s.key} className="card flex gap-4 p-4">
              <Icon aria-hidden className={`mt-0.5 size-5 shrink-0 ${tone}`} />
              <div className="min-w-0">
                <div className="font-medium">
                  {s.label} <span className={`ml-2 text-xs ${tone}`}>{s.configured ? "Configured" : s.required ? "Required — missing" : "Optional — not configured"}</span>
                </div>
                <p className="mt-0.5 text-sm text-muted">{s.note}</p>
                {!s.configured && (
                  <p className="mt-2 text-xs text-muted">
                    Set: {s.missing.map((m) => <code key={m} className="mr-2 rounded bg-bg px-1.5 py-0.5 text-text">{m}</code>)}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 text-xs text-muted">See <code>.env.example</code> and <code>docs/RUNBOOK.md</code> for configuration details.</p>
    </main>
  );
}
