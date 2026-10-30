import Link from "next/link";
import { Download, Upload } from "lucide-react";
import { KIND_LABEL } from "@/modules/imports/labels";
import type { ImportKind } from "@/modules/imports/types";

/** Import button (Admins) and template download links for a reference page. */
export function ImportLinks({ kinds, canImport }: { kinds: ImportKind[]; canImport: boolean }) {
  return (
    <>
      {kinds.map((k) => (
        <a key={k} className="btn btn-secondary" href={`/api/import-templates/${k}`} download>
          <Download aria-hidden className="size-4" />
          {KIND_LABEL[k]} template
        </a>
      ))}
      {canImport && (
        <Link className="btn btn-primary" href={`/imports?kind=${kinds[0]}`}>
          <Upload aria-hidden className="size-4" />
          Import CSV
        </Link>
      )}
    </>
  );
}

export function Tabs({ tabs, active }: { tabs: { key: string; label: string; href: string }[]; active: string }) {
  return (
    <nav aria-label="Sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${t.key === active ? "border-primary text-text" : "border-transparent text-muted hover:text-text"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
