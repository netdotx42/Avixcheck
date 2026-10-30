import Link from "next/link";

/** Server-rendered pagination preserving the current query string. */
export function Pagination({ page, pageSize, total, basePath, params }: { page: number; pageSize: number; total: number; basePath: string; params: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const q = new URLSearchParams(Object.entries({ ...params, page: String(p) }).filter(([, v]) => v) as [string, string][]);
    return `${basePath}?${q.toString()}`;
  };
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm text-muted">
      <span className="num">
        {total === 0 ? "No results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <div className="flex gap-2">
        {page > 1 ? <Link className="btn btn-secondary" href={href(page - 1)}>Previous</Link> : <span className="btn btn-secondary opacity-50" aria-disabled>Previous</span>}
        {page < pages ? <Link className="btn btn-secondary" href={href(page + 1)}>Next</Link> : <span className="btn btn-secondary opacity-50" aria-disabled>Next</span>}
      </div>
    </nav>
  );
}

export function parsePage(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : 1;
}
