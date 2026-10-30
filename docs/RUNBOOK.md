# AvixCheck operations runbook

Audience: whoever deploys and operates AvixCheck. Read `docs/ARCHITECTURE.md` for how the system is built; this document covers how to run it.

> **Status:** the software includes the controls below, but no environment is production-ready until every item in [§10 Production readiness checklist](#10-production-readiness-checklist) is ticked with evidence. Do not claim otherwise.

## 1. What runs where

| Component | Command | Notes |
| --- | --- | --- |
| Web (Next.js) | `npm run start` | Stateless; scale horizontally. Health: `GET /api/health`. |
| Worker | `npm run worker` | Runs all background jobs and the daily scheduler. Scale to 2+ instances; jobs are claimed with `FOR UPDATE SKIP LOCKED`. Set `WORKER_SCHEDULER=off` on extra instances if you want one scheduler (safe either way: enqueues are idempotent). |
| Release | `npm run db:migrate` | Once per deploy, before new web/worker code starts. |
| Backup | `npm run ops:backup` | Daily, scheduled (cron). |
| Restore drill | `npm run ops:restore-verify -- <manifest>` | Monthly and after any backup change. |
| PostgreSQL 16 | managed | System of record **and** job queue. |
| S3-compatible bucket | managed | Private documents and exports. |
| ClamAV (`clamd`) | container | Malware scanning, TCP 3310, private network only. |
| Clerk | SaaS | Identity, MFA, sessions. |
| Anthropic API | SaaS | Invoice extraction only. |
| Sentry | SaaS (optional) | Error monitoring. |

All processes use the same Docker image (`Dockerfile`). Deployment descriptors: `render.yaml` (Render Blueprint, primary) and `fly.toml` (Fly.io alternative).

## 2. First-time setup

1. **Database.** Create a PostgreSQL 16 instance. Create the app role without superuser or BYPASSRLS:
   ```sql
   CREATE ROLE avix_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOBYPASSRLS;
   CREATE DATABASE avixcheck OWNER avix_app;
   ```
   Verify: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user;` must return `f, f` when connected with `DATABASE_URL`. Superusers bypass row-level security and break tenant isolation.
   Require TLS (`?sslmode=require` or `verify-full`). Enable the provider's point-in-time recovery (PITR) as well as the logical backups below.
2. **Storage.** Create a private bucket (block all public access, default encryption on, versioning on). Create credentials scoped to that bucket only (`GetObject`, `PutObject`, `DeleteObject`, `ListBucket`). Allow CORS only if the documents module needs it for previews, and only from `APP_URL`.
3. **Backup bucket.** Create a second bucket, ideally in another account or region, with object lock / retention (e.g. 35 days compliance mode) and its own write-only credentials. Set `BACKUP_S3_*`.
4. **ClamAV.** Run `clamav/clamav:1.4` on the private network (Render private service or Fly internal app). Never expose 3310 publicly. Allow ~2 GB RAM; signatures update automatically (freshclam).
5. **Clerk.** Create a production instance, enable MFA for all users, set allowed origins to `APP_URL`, session lifetime per your policy. Copy the publishable and secret keys.
6. **Anthropic.** Create an API key in a dedicated workspace with a spend limit. `EXTRACTION_MODEL` defaults to `claude-sonnet-5-5`.
7. **Sentry** (optional, recommended). Create a Node project; set `SENTRY_DSN`. The SDK is configured to send no cookies, headers, bodies, query strings, AI inputs/outputs or DB parameters.
8. **Environment variables.** Copy `.env.example`; every variable is documented there. Set them in the platform's secret manager (Render: environment groups / `sync: false`; Fly: `fly secrets set`). Never commit real values. `APP_ENV=production` blocks demo organisations and the demo seeder.
9. **Deploy** (§3), then open `/setup`: it lists every integration as configured or missing, and features depending on a missing integration show a disabled state rather than simulating results.

## 3. Deploying

### Render (primary)
1. Dashboard → Blueprints → New → this repo. `render.yaml` creates `avixcheck-web`, `avixcheck-worker`, `avixcheck-clamav` and the `avixcheck-backup` cron.
2. Fill every `sync: false` variable on each service.
3. Deploys are manual (`autoDeploy: false`). Each web deploy runs `npm run db:migrate` as the pre-deploy command; if it fails the deploy stops and the old version keeps serving.
4. After the web service is live, deploy the worker with the same commit.

### Fly.io (alternative)
```bash
fly launch --no-deploy --copy-config      # uses fly.toml
fly secrets set DATABASE_URL=... CLERK_SECRET_KEY=... (all secrets)
fly deploy                                # release_command runs migrations first
fly scale count web=2 worker=2
# Daily backup machine (02:15 UTC):
fly machine run . --schedule daily --region lhr --env NODE_ENV=production \
  --command "npm run ops:backup -- --out /app/backups"
```

### Every deploy
- CI green on the commit (lint, typecheck, migration drift check, tests incl. backup/restore, build, `npm audit`).
- Migrations are additive. A migration that rewrites or drops data needs a backup taken immediately before (`npm run ops:backup`) and a written rollback plan.
- After deploy: `GET /api/health` returns `200` with `"status":"ready"`; a test upload as a demo org reaches `scanning`/`extracting` in a staging environment.
- **Rollback:** redeploy the previous image. Migrations are not reversed automatically; because they are additive, older code keeps working. If a migration must be undone, restore (§6) or write a forward fix.

## 4. Monitoring and logs

- **Logs** are JSON (pino) on stdout: `service`, `env`, `level`, `time`, plus `requestId`, `orgId`, `jobId`, `jobType` where relevant. Secrets, cookies, tokens and signed URLs are redacted; document contents are never logged. Ship stdout to your log store and keep ≥ 30 days.
- **Request ids:** every response carries `x-request-id` (taken from the load balancer if it is a safe value, otherwise generated). Ask users for it; search logs and Sentry (`requestId` tag) by it. Use `currentRequestId()` / `requestLogger()` (`src/lib/request-context.ts`) and pass `requestId` to `audit()`.
- **Errors:** `reportError()` logs and, with `SENTRY_DSN`, sends to Sentry (web via `src/instrumentation.ts`, worker via `initMonitoring("worker")`). Without a DSN, `/setup` shows monitoring as not configured.
- **Alerts to set up** (in Sentry / your log platform / uptime monitor):
  - `/api/health` non-200 for 2 minutes → page.
  - Any `level>=50` with `msg:"worker crashed"` or zero `"job succeeded"` for 30 minutes while jobs are queued → page.
  - `job.failed` audit events or Sentry errors with `jobType` → ticket.
  - Backup cron failure or no `"backup written"` log in 26 hours → page.
  - `retention.swept` missing for 2 days → ticket.
- **Queue health query:**
  ```sql
  select type, status, count(*), min(run_after) from jobs
  where status in ('queued','running','failed') group by 1,2 order by 1,2;
  ```

## 5. Backups

`npm run ops:backup` (`scripts/ops/backup.ts`, `src/modules/ops/backup.ts`):
1. Opens a `REPEATABLE READ` transaction and exports its snapshot.
2. Runs `pg_dump --format=custom --snapshot=…` against that snapshot, so the dump and the fingerprints are of identical data even while the app is writing.
3. Writes a manifest: per-table row counts and order-independent checksums, latest migration, dump sha256, server version.
4. Lists the document bucket (`org/` prefix) to `<name>.storage.txt` with a sha256, so restores can prove every live document's file exists.
5. Uploads dump + manifest + listing to `BACKUP_S3_BUCKET` (warns loudly if unset).

The backup role must see every row: use the database owner (the script sets `app.bypass_rls=on` and `--enable-row-security`) or a dedicated `BYPASSRLS` read-only role. `pg_dump` must be the server's major version (the image ships PostgreSQL 16 client tools).

**Document files** are not copied by this script. Protect them with bucket versioning (recovers deletes/overwrites) and cross-region replication at the provider. The storage listing in each manifest is what lets you verify them after a restore.

Schedule: daily at 02:15 UTC (`render.yaml` cron / Fly scheduled machine). Retention of backups: lifecycle rule on the backup bucket (suggested 35 daily + 12 monthly). Provider PITR covers the gap between daily dumps.

## 6. Restore

### Restore drill (verified restoration) — monthly, and before go-live
```bash
# Fetch a backup (dump + manifest + storage listing) into ./restore, then:
RESTORE_ADMIN_DATABASE_URL=postgres://<role-with-CREATEDB>@<NON-production server>/postgres \
  npm run ops:restore-verify -- ./restore/<name>.manifest.json --report ./restore/report.json
```
The drill checks the dump's sha256, restores into a fresh scratch database, recomputes every table's row count and checksum and compares them with the manifest, checks every live document's storage key is in the listing, then drops the scratch database (`--keep` to inspect it). Exit code 0 means verified. Record each drill in the log at the end of this file (date, backup name, `durationMs`, `ok`, who).

This flow is exercised in CI by `tests/ops-backup.test.ts` (backup as a non-superuser owner with RLS forced, restore, matching fingerprints; plus failures for tampered manifests, corrupted dumps and missing storage objects).

### Real restore (disaster)
1. Declare an incident (§9). Stop writers: scale web and worker to 0.
2. Choose the recovery point: provider PITR for "just before X" (preferred for recent data loss), or the latest verified dump.
3. For a dump: create a new database, then
   ```bash
   PGOPTIONS="-c app.bypass_rls=on" pg_restore --no-owner --no-acl --exit-on-error \
     --enable-row-security --dbname="$NEW_DATABASE_URL" <name>.dump
   ```
   then `ALTER DATABASE … OWNER TO avix_app` and reassign table ownership to the app role (or run as the app role).
4. Run `npm run ops:restore-verify` against the same dump on a scratch database if time allows, and compare `select count(*)` of key tables against the manifest.
5. Point `DATABASE_URL` at the restored database, run `npm run db:migrate` (no-op if current), scale web up, check `/api/health`, then worker.
6. Documents: if files were deleted, restore object versions from bucket versioning for keys in `<name>.storage.txt`.
7. Jobs that were `running` are reclaimed automatically after the lease (5 min). Review `failed` jobs in Settings.
8. Tell affected organisations what window of data, if any, was lost.

## 7. Background job recovery

- Jobs retry with exponential backoff up to `max_attempts`, then become `failed` with the error visible in **Settings → Failed background jobs**. Admins can **Retry** (fresh retry budget, audited) or **Dismiss** (cancel, audited). Handlers are idempotent, so retrying is safe.
- Missing integrations fail jobs permanently with a message naming the missing variables. Fix the configuration, then Retry.
- A crashed worker's `running` jobs are reclaimed after 5 minutes; on their final attempt they are marked failed by `sweepAbandoned`.
- Bulk retry for one type after an outage (system operator, audited by hand in the incident log):
  ```sql
  update jobs set status = 'queued', run_after = now(), max_attempts = attempts + 3, finished_at = null, updated_at = now()
  where status = 'failed' and type = 'invoice.extract' and updated_at > now() - interval '6 hours';
  ```
- Never delete job rows; cancel them.

## 8. Security operations

- **Tenant isolation:** RLS is forced on every tenant table; the app role must not be superuser/BYPASSRLS (§2). Storage keys are org-prefixed and checked before signing.
- **Sessions:** Clerk-managed; `AUTH_PROVIDER=dev` is refused when `NODE_ENV=production`.
- **Headers:** CSP (`src/lib/security/csp.ts`, set in middleware: no framing, no plugins, scripts only from self + Clerk, storage origin only for document previews), HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer, permissions policy.
- **Rate limits** (`src/lib/rate-limit-policies.ts`, Postgres-backed so they hold across instances): upload 60/10 min per user, import 20/10 min, export 20/h, signed URLs 300/10 min, invitations 50/h per org, invitation accepts 20/h per user. Override with `RATE_LIMIT_<NAME>=<limit>/<seconds>`. Route handlers use `enforceRateLimit()` + `rateLimitResponse()` (429 + `Retry-After`).
- **Uploads:** size limit `MAX_UPLOAD_BYTES`; PDF magic-byte check; ClamAV scan before any processing; infected files are quarantined. If ClamAV is unreachable, documents stay in `scanning` and are never treated as clean.
- **Secrets:** only in the platform secret manager. Rotate on staff departure or suspected exposure: Clerk keys, S3 keys, Anthropic key, DB passwords, Sentry DSN, backup credentials. Rotation = add new, deploy, revoke old.
- **Retention:** daily `ops.retention_sweep` per organisation deletes invoice PDFs after `retention.documentDays` (default 2555 ≈ 7 years) or the document's `retain_until`, and export files after `retention.exportDays` (default 30). Records, check results and the audit trail are kept; the document row is marked `deleted_at`. Documents on **legal hold** are never deleted (`setLegalHold`, Admin only, reason required, audited). Every deletion writes `retention.document_deleted` / `retention.export_expired` and each run `retention.swept`. Admins see the policy, items due, holds and the last run in **Settings → Data retention** and can run a sweep now. `npm run ops:retention-run` enqueues sweeps for all orgs.
- **Audit:** `audit_events` is append-only (trigger). Never grant `TRUNCATE` or disable the trigger.
- **Dependencies:** CI fails on high-severity advisories (`npm audit --omit=dev --audit-level=high`). Patch monthly.
- **Demo data:** `npm run db:seed-demo` creates a labelled `is_demo` organisation with synthetic reference data only (no invoices or results), and refuses when `APP_ENV=production`. Use a separate demo deployment and database.

## 9. Incident response

1. **Triage (first 15 min).** Severity: SEV1 = data exposure across tenants, data loss, or app down; SEV2 = processing stalled / major feature broken; SEV3 = degraded. Name an incident lead; open an incident log (time-stamped notes).
2. **Stabilise.**
   - App down: check `/api/health` (`database: unreachable` → DB provider status/connection limits). Roll back the last deploy if it correlates.
   - Jobs stalled: queue health query (§4); worker logs; check integration outages (Anthropic, ClamAV, S3). Jobs retry by themselves; recover failed ones afterwards (§7).
   - Suspected cross-tenant exposure or credential leak: SEV1. Rotate the affected secrets immediately, preserve logs, take a backup for evidence, scale web to 0 if exposure is ongoing.
   - Malware detected: the file is quarantined automatically; confirm no downstream job ran on it (`audit_events` for that document).
3. **Communicate.** Status update every 30 min (SEV1) / 2 h (SEV2): impact, what we know, next update time. Notify affected organisations' admins for any data incident within your contractual / regulatory window (e.g. UK GDPR: assess for ICO notification within 72 hours).
4. **Recover** and verify (health, test upload in a demo org, queue drained).
5. **Postmortem** within 5 working days: timeline, root cause, what went well/badly, action items with owners. Blameless.

## 10. Production readiness checklist

Tick each item with evidence (link, screenshot or log line) before calling an environment production-ready.

- [ ] CI green on the release commit: lint, typecheck, migration drift, all tests (financial calculations, permissions, tenant isolation, duplicates, partial billing, credit notes, uncertain extraction, concurrency, retries, backup/restore), build, dependency audit.
- [ ] End-to-end upload → scan → extraction → matching → review → export verified in staging with real integrations (not fixtures).
- [ ] `/setup` shows every required integration configured; `/api/health` returns `ready`.
- [ ] App DB role verified `rolsuper = f, rolbypassrls = f`; TLS required.
- [ ] Bucket public access blocked, encryption + versioning on; app credentials scoped to the bucket.
- [ ] ClamAV reachable only on the private network; an EICAR test file is quarantined.
- [ ] Clerk production instance with MFA; dev auth provider not in use.
- [ ] Sentry receiving a test error from web and from worker (`requestId`/`jobType` tags present, no PII in the event).
- [ ] Alerts in §4 configured and test-fired.
- [ ] Daily backup ran and uploaded to the separate backup bucket; backup bucket has object lock / lifecycle.
- [ ] Restore drill passed on a recent production backup (log entry below).
- [ ] PITR enabled at the database provider.
- [ ] Retention policy confirmed with the customer; a sweep has run (`retention.swept` event) and legal hold tested.
- [ ] Secrets only in the secret manager; rotation owners named.
- [ ] Demo data absent from the production database (`select count(*) from organizations where is_demo` = 0).
- [ ] Penetration test or security review of auth, tenant isolation and upload paths completed; findings fixed.
- [ ] Incident contacts and on-call rota documented.

## Restore drill log

| Date | Backup | Environment | Result | Duration | By |
| --- | --- | --- | --- | --- | --- |
| _none yet_ | | | | | |
