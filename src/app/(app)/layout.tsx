import type { ReactNode } from "react";
import { LogOut } from "lucide-react";
import { Wordmark } from "@/components/brand";
import { NavLinks } from "@/components/nav";
import { MobileNav } from "@/components/mobile-nav";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { listUserOrgs } from "@/lib/auth/context";
import { integrationStatus } from "@/env";
import { signOut, switchOrg } from "@/app/actions/session";
import Link from "next/link";

export const dynamic = "force-dynamic";

const ROLE_LABEL = { admin: "Admin", reviewer: "Reviewer", viewer: "Viewer" } as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await pageContext();
  const orgs = await listUserOrgs(ctx.user.id);
  const missing = integrationStatus().filter((i) => i.required && !i.configured);

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 btn btn-primary">Skip to content</a>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="px-5 py-5"><Wordmark /></div>
        <div className="metal-rule mx-5" />
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4"><NavLinks /></nav>
        <div className="border-t border-border p-4 text-xs text-muted">
          <div className="truncate text-text">{ctx.user.email}</div>
          <div className="mt-0.5">{ROLE_LABEL[ctx.role]} · {ctx.orgName}</div>
          <form action={signOut} className="mt-3">
            <button className="inline-flex items-center gap-1.5 text-muted hover:text-text"><LogOut aria-hidden className="size-3.5" />Sign out</button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-16 items-center justify-between gap-4 border-b border-border bg-surface/70 px-4 backdrop-blur lg:px-8">
          <div className="flex items-center gap-3">
            <MobileNav />
            <div className="lg:hidden"><Wordmark /></div>
          </div>
          <div className="flex items-center gap-3">
            {ctx.isDemo && <StatusBadge tone="warn" label="Demo data" />}
            {orgs.length > 1 ? (
              <form action={switchOrg} className="flex items-center gap-2">
                <label htmlFor="org-switch" className="sr-only">Organisation</label>
                <select id="org-switch" name="orgId" defaultValue={ctx.orgId} className="input w-auto py-1.5">
                  {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}{o.isDemo ? " (demo)" : ""}</option>)}
                </select>
                <button className="btn btn-secondary py-1.5">Switch</button>
              </form>
            ) : (
              <span className="text-sm text-muted">{ctx.orgName}</span>
            )}
          </div>
        </header>

        {missing.length > 0 && (
          <div role="status" className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn lg:px-8">
            Setup incomplete: {missing.map((m) => m.label).join(", ")} not configured. Dependent features are disabled, not simulated.{" "}
            <Link href="/setup" className="underline">View setup</Link>
          </div>
        )}

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
