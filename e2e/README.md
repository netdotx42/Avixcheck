# End-to-end and cross-module tests

Two layers, both run against a real Postgres as a **non-superuser** role so row-level security applies.

| Layer | Where | Command |
| --- | --- | --- |
| Cross-module (Vitest) | `tests/qa/` | `npm test` |
| Browser (Playwright) | `e2e/` | `npm run test:e2e` |

Both need `TEST_ADMIN_DATABASE_URL`, a superuser URL used only to create the test databases and roles
(local: `pg_ctlcluster 16 main start`, then create a superuser `avix`/`avix`).

## What runs

- `tests/qa/rls-coverage.test.ts` finds every table with `org_id` and requires ENABLE + FORCE RLS and an org-scoped policy. New module tables are covered automatically.
- `tests/qa/guard-coverage.test.ts` statically checks that every server action, route handler and app page calls a guard, that module code only uses `withSystem()` with a `qa-allow-withSystem: <reason>` comment, and that module code never `parseFloat`s.
- `tests/qa/permission-matrix.test.ts` pins the full role × permission table. Changing a permission means changing this table in the same PR.
- `tests/qa/cross-tenant.test.ts` covers jobs, storage keys, documents, exports, memberships and metrics across two tenants.
- `e2e/*.spec.ts` drive the real app with the dev sign-in provider: sign-in, onboarding, every page per role, invitations, forged cookies, active-org cookie tampering.
- `e2e/workflow.spec.ts` is the upload → export flow. It skips, naming the reason, until the documents/imports/engine modules and storage + ClamAV are available.

## Harness notes

- `e2e/provision.ts` recreates `avixcheck_e2e` on each run. The web server is `next dev` because the dev auth provider is refused when `NODE_ENV=production`.
- Locally an already-running server on `E2E_PORT` (default 3100) is reused.
- Traces and screenshots go to the OS temp dir (`E2E_OUTPUT_DIR` overrides): writing them inside the project makes `next dev` hot-reload mid-test.
- Optional integrations are passed through from `E2E_S3_*`, `E2E_CLAMAV_HOST`, `E2E_CLAMAV_PORT`, `E2E_ANTHROPIC_API_KEY`, `E2E_EXTRACTION_PROVIDER`.

## Known gap the tests document

`cross-tenant.test.ts` › "refuses a row that references another tenant's record" is marked `it.fails`: plain foreign keys are checked without RLS, so org B can insert an invoice pointing at org A's document, supplier or PO if it learns the ids. The fix is composite `(org_id, id)` foreign keys or a same-org trigger in a new migration. Once fixed the test starts passing, Vitest reports that as a failure, and `.fails` must be removed.
