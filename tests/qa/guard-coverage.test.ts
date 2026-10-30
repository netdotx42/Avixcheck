import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Static sweep: every server action, route handler and app page must call a
 * server-side guard. UI hiding is cosmetic; this catches entry points that
 * forgot the check. It is a tripwire, not a proof: the runtime tests in
 * tests/qa/*-isolation.test.ts and e2e/ exercise the guards for real.
 */

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const files = walk(SRC);

/** Calls that establish who the caller is and what they may do. */
const GUARDS = /\b(requireOrg|withOrgPermission|pageContext|getSessionUser|assertCan)\s*\(/;

/** Entry points that are intentionally unauthenticated, with the reason. */
const PUBLIC_ACTIONS: Record<string, string> = {
  "src/app/actions/session.ts#devSignIn": "sign-in itself; refuses unless AUTH_PROVIDER=dev outside production",
  "src/app/actions/session.ts#signOut": "only clears the caller's own cookies",
};
const PUBLIC_ROUTES: Record<string, string> = {
  "src/app/api/health/route.ts": "liveness/readiness; reports configuration only, no tenant data",
};
const PUBLIC_PAGES = new Set(["src/app/page.tsx", "src/app/setup/page.tsx", "src/app/forbidden/page.tsx"]);

/** Split a module into its exported functions' source text. */
function exportedFunctions(src: string): { name: string; body: string }[] {
  const re = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  const hits: { name: string; start: number }[] = [];
  for (let m; (m = re.exec(src)); ) hits.push({ name: (m[1] ?? m[2])!, start: m.index });
  return hits.map((h, i) => ({ name: h.name, body: src.slice(h.start, hits[i + 1]?.start ?? src.length) }));
}

/** Helpers defined in the same file that themselves call a guard. */
function guardedLocalHelpers(src: string): RegExp | null {
  const names: string[] = [];
  const re = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  for (let m; (m = re.exec(src)); ) {
    const body = src.slice(m.index, src.indexOf("\n}", m.index) + 2);
    if (GUARDS.test(body)) names.push(m[1]!);
  }
  return names.length ? new RegExp(`\\b(${names.join("|")})\\s*\\(`) : null;
}

describe("server-side guard coverage", () => {
  it("every exported server action calls a guard", () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!/^\s*["']use server["']/m.test(src.split("\n").slice(0, 3).join("\n"))) continue;
      const local = guardedLocalHelpers(src);
      for (const fn of exportedFunctions(src)) {
        const id = `${rel(f)}#${fn.name}`;
        if (PUBLIC_ACTIONS[id]) continue;
        if (!GUARDS.test(fn.body) && !(local && local.test(fn.body))) missing.push(id);
      }
    }
    expect(missing, "server actions without requireOrg/withOrgPermission/getSessionUser").toEqual([]);
  });

  it("every route handler calls a guard", () => {
    const missing: string[] = [];
    for (const f of files.filter((x) => /[/\\]route\.ts$/.test(x))) {
      const r = rel(f);
      if (PUBLIC_ROUTES[r]) continue;
      const src = readFileSync(f, "utf8");
      const local = guardedLocalHelpers(src);
      for (const fn of exportedFunctions(src).filter((x) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(x.name))) {
        if (!GUARDS.test(fn.body) && !(local && local.test(fn.body))) missing.push(`${r}#${fn.name}`);
      }
    }
    expect(missing, "route handlers without an auth/permission guard").toEqual([]);
  });

  it("every page inside the app shell resolves an org context", () => {
    const missing = files
      .filter((f) => rel(f).startsWith("src/app/(app)/") && /[/\\]page\.tsx$/.test(f))
      .filter((f) => !/\bpageContext\s*\(/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it("public pages outside the shell are the known set", () => {
    const outside = files
      .filter((f) => rel(f).startsWith("src/app/") && /[/\\]page\.tsx$/.test(f) && !rel(f).startsWith("src/app/(app)/"))
      .map(rel)
      .filter((r) => !PUBLIC_PAGES.has(r))
      .filter((r) => !GUARDS.test(readFileSync(path.join(ROOT, r), "utf8")))
      // sign-in and invite pages are reachable signed-out by design
      .filter((r) => !/^src\/app\/(sign-in|invite)\//.test(r));
    expect(outside).toEqual([]);
  });

  it("module code only bypasses RLS where explicitly justified", () => {
    // withSystem() turns RLS off. In module code each use must carry a
    // `qa-allow-withSystem: <reason>` comment on the line(s) just above it.
    const offenders: string[] = [];
    for (const f of files.filter((x) => rel(x).startsWith("src/modules/"))) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\bwithSystem\s*\(/.test(line) || /^\s*(import|\/\/|\*)/.test(line)) return;
        const above = lines.slice(Math.max(0, i - 3), i).join("\n");
        if (!/qa-allow-withSystem:\s*\S/.test(above)) offenders.push(`${rel(f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("financial code never parses money with floats", () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => rel(x).startsWith("src/modules/"))) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\b(parseFloat|Number\.parseFloat)\s*\(/.test(line)) offenders.push(`${rel(f)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
