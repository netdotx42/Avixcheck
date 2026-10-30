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
- `tests/qa/workflow.test.ts` runs the whole pipeline through the real services and job handlers (in-memory storage, clean-scan stub and fixture extractor, test process only): imports, upload, scan, extraction, matching, checks, role-limited decisions, export, idempotent re-checks, duplicate uploads and uncertain extraction.
- `e2e/workflow.spec.ts` runs the same flow in the browser with the real app **and worker**, MinIO and a real ClamAV daemon: CSV imports, PDF upload, background processing, side-by-side review, decision, export download, and a cross-tenant download attempt. Extraction uses the test-only fixture provider (`EXTRACTION_PROVIDER=fixture`, refused by `env()` unless `APP_ENV=test` outside production); the PDF carries an `AVIX-FIXTURE:<name>` marker naming a file in `tests/fixtures/extraction/`. Without storage/ClamAV it skips and names what is missing; CI sets `E2E_REQUIRE_WORKFLOW=1` so it fails instead.

## Harness notes

- `e2e/provision.ts` recreates `avixcheck_e2e` on each run. The web server is `next dev` because the dev auth provider is refused when `NODE_ENV=production`.
- Locally an already-running server on `E2E_PORT` (default 3100) is reused.
- Traces and screenshots go to the OS temp dir (`E2E_OUTPUT_DIR` overrides): writing them inside the project makes `next dev` hot-reload mid-test.
- Optional integrations are passed through from `E2E_S3_*`, `E2E_CLAMAV_HOST`, `E2E_CLAMAV_PORT`, `E2E_ANTHROPIC_API_KEY`, `E2E_EXTRACTION_PROVIDER`. Locally: `docker compose up -d minio minio-init clamav`, then export the same `E2E_*` values the CI `e2e` job uses.

## Known gap the tests document

`cross-tenant.test.ts` › "refuses a row that references another tenant's record" is marked `it.fails`: plain foreign keys are checked without RLS, so org B can insert an invoice pointing at org A's document, supplier or PO if it learns the ids. The fix is composite `(org_id, id)` foreign keys or a same-org trigger in a new migration. Once fixed the test starts passing, Vitest reports that as a failure, and `.fails` must be removed.
