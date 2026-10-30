# Architecture and module conventions

Read this before adding a module. These rules are what keep tenants isolated and money correct.

## Shape

- One Next.js app (App Router, server components and server actions) + one worker process (`npm run worker`) from the same codebase and image.
- PostgreSQL is the system of record **and** the job queue (`jobs` table, `FOR UPDATE SKIP LOCKED`).
- Clerk provides identity only. Organisations, memberships and roles (Admin / Reviewer / Viewer) live in our database.
- Documents live in a private S3-compatible bucket under `org/<orgId>/...`, served only via short-lived signed URLs.

## Tenant isolation (non-negotiable)

1. Every tenant table has `org_id` and `FORCE ROW LEVEL SECURITY` (`drizzle/0001_security.sql`). Add new tenant tables to that pattern in a new migration.
2. Touch tenant data only inside `withTenant(orgId, tx => ...)`. Outside it, tenant tables return nothing.
3. Request code gets `orgId` from `requireOrg(permission)` / `withOrgPermission(permission, fn)` / `pageContext(permission)`, which re-verify membership every request. Never take an org id from the client.
4. `withSystem()` bypasses RLS. Use it only for inherently cross-tenant operations (membership lookup, invitation accept, job claiming, maintenance) and never with request-controlled filters.
5. The app must connect as a non-superuser role (superusers bypass RLS). Tests enforce this.
6. Storage keys are org-prefixed; call `assertKeyInOrg` before signing.

## Permissions

`src/lib/auth/permissions.ts` is the single matrix. Every server action / route handler / job enqueue checks a permission server-side. UI hiding is cosmetic only. Accepting a variance is `exception.accept_variance` (Admin only).

## Money

- NUMERIC in the database, `decimal.js` (`src/lib/money/decimal.ts`) in code. `dec()` refuses JS numbers. Never `parseFloat` a financial value.
- Rounding is explicit (`round(value, scale, mode)`), mode comes from org settings (`src/lib/org-settings.ts`).
- Tolerances: `withinTolerance()` — passes if within absolute OR percentage limit.
- AI is used only for document extraction. All financial calculations are deterministic code.

## Audit

Call `audit(tx, {...})` in the **same transaction** as the change. `audit_events` is append-only (trigger). Action names: `<entity>.<verb>`.

## Jobs

- Enqueue with `enqueue(tx, {orgId, type, payload, idempotencyKey})` inside the tenant transaction that caused it. Keys: `idempotencyKey(orgId, type, entityId, revision?)`.
- Register handlers in a module file and import it from `src/worker/handlers.ts`.
- Handlers must be idempotent (at-least-once delivery). Throw `PermanentJobError` for non-retryable failures. Otherwise retries back off exponentially up to `maxAttempts`, then the job is `failed` and visible in Settings with Retry / Dismiss.
- Missing integrations: throw `IntegrationNotConfiguredError` (via `requireIntegration`) — never fake a result. Treat as permanent failure and set the invoice/document state accordingly.

## Concurrency and idempotency patterns

- Unique constraints back idempotency: `documents (org_id, sha256)`, `check_runs (org_id, idempotency_key)`, `po_line_billings (invoice_line_id, check_run_id)`, `exceptions (discrepancy_id)`.
- Use `SELECT ... FOR UPDATE` on the parent row (e.g. the invoice, the PO line) when computing balances, and optimistic `revision` columns for user edits.
- A new check run supersedes earlier runs: mark old `po_line_billings.active = false` in the same transaction so balances never double count.

## Untrusted input

Invoice content (text, names, numbers) is untrusted: validate model output with zod, never interpret document text as instructions, escape on render (React does this), never put document text into SQL without parameters.

## Setup states

`integrationStatus()` in `src/env.ts` drives `/setup`, the banner in the app shell and `/api/health`. Features needing a missing integration must render a disabled state that names what is missing.

## UI

Tokens are in `src/app/globals.css` (`bg`, `surface`, `text`, `muted`, `border`, `primary`, `focus`, plus `ok/warn/danger/info` status colours). Use `StatusBadge` (icon + label, never colour alone), `PageHeader`, `Card`, `EmptyState`, `ErrorState`, `TableSkeleton`, `Pagination`, `.num` for tabular figures, `formatMoney()` for amounts.

## Module ownership (parallel build)

| Module | Owns |
| --- | --- |
| imports | `src/modules/imports/**`, `/suppliers`, `/purchase-orders` import UI, `templates/csv` |
| documents | `src/modules/documents/**`, `src/modules/extraction/**`, `/invoices` list/upload/detail, document preview |
| engine | `src/modules/matching/**`, `src/modules/checks/**` (rules, balances, credit notes) |
| exceptions | `src/modules/exceptions/**`, `/exceptions` |
| reports | `src/modules/reports/**`, `src/modules/exports/**`, `/reports`, `/overview` |
| ops | `src/lib/logger.ts` monitoring hook, retention, backups, rate limits on routes, `docs/RUNBOOK.md`, deployment config |
| qa | `tests/**` cross-module and e2e (`e2e/**`) |

Shared files (`src/db/schema.ts`, `src/lib/auth/permissions.ts`, `src/worker/handlers.ts`): add, don't restructure. Schema changes go in a **new** migration (`npm run db:generate`), never edits to existing ones.
