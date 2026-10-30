"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, FileText, Gauge, Settings, ShieldAlert, ShoppingCart, type LucideIcon } from "lucide-react";

export const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/overview", label: "Overview", icon: Gauge },
  { href: "/invoices", label: "Invoices", icon: FileText },
  { href: "/exceptions", label: "Exceptions", icon: ShieldAlert },
  { href: "/suppliers", label: "Suppliers & Agreements", icon: Building2 },
  { href: "/purchase-orders", label: "Purchase Orders", icon: ShoppingCart },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <ul className="space-y-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active ? "bg-primary/15 text-text ring-1 ring-primary/40" : "text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <Icon aria-hidden className={`size-4 ${active ? "text-focus" : ""}`} />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
