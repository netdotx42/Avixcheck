# AvixCheck

**Every invoice. Checked.**

AvixCheck flags supplier invoice discrepancies against purchase orders and agreed prices before payment. One Next.js application plus a background worker, backed by PostgreSQL, managed authentication (Clerk), private S3-compatible storage, ClamAV malware scanning and AI document extraction.

> Status: all modules are implemented (imports, upload and AI extraction, matching and checks, exceptions review, reports and exports, operations). Live integrations (Clerk, Anthropic, ClamAV, S3, Sentry, Resend) and a real deployment have not yet been verified, so this is **not production-ready**; see the readiness checklist in `docs/RUNBOOK.md`.

## Quick start (local)

```bash
cp .env.example .env.local          # fill in what you have; blanks show a setup state
docker compose up -d                # postgres, minio, clamav
npm ci
npm run db:migrate
npm run dev                         # web on :3000
npm run worker                      # background jobs (separate terminal)
```

For local work without Clerk keys, set `AUTH_PROVIDER=dev` and `SESSION_SECRET` (32+ random chars). The dev provider is refused when `NODE_ENV=production`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js web app |
| `npm run worker` | Background job worker (scan, extract, match, check, export) |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm test` | Unit + integration tests (needs Postgres; see below) |
| `npm run lint` / `typecheck` | Static checks |
| `npm run db:seed-demo` | Seed a labelled demo organisation (refused in production) |
| `npm run ops:backup` | Database backup + manifest + storage listing (see `docs/RUNBOOK.md`) |
| `npm run ops:restore-verify -- <manifest>` | Restore drill into a scratch database with row-count/checksum verification |
| `npm run ops:retention-run` | Enqueue retention sweeps for all organisations now |

Tests create a throwaway database owned by a non-superuser role so row-level security is really enforced. Point `TEST_ADMIN_DATABASE_URL` at a superuser connection (default `postgres://avix:avix@localhost:5432/postgres`).

## Layout

```
src/app/            Next.js routes. (app)/ holds the signed-in pages.
src/db/             Drizzle schema, client, tenant transactions, migrator
src/lib/auth/       Session, org context, permission matrix, page guards
src/lib/jobs/       Durable Postgres job queue, handler registry, runner
src/lib/money/      Decimal arithmetic, rounding, tolerances
src/lib/storage/    Private S3 storage, signed URLs
src/lib/scan/       ClamAV client
src/worker/         Worker entrypoint and handler registration
drizzle/            SQL migrations (0001_security.sql = RLS + audit immutability)
templates/csv/      CSV import templates
docs/               Architecture, runbook
```
