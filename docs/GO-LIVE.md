# AvixCheck go-live guide

This guide takes AvixCheck from "merged and tested" to "live". It covers the accounts and credentials to create, the staging rehearsal and the production cut-over, with a check for every step. `docs/RUNBOOK.md` covers day-to-day operations.

> **Status of this release.** The code, tests, image build and deploy pipeline are in the repository. **No live service has been verified and nothing has been deployed.** Every step below marked 🔑 needs your accounts, credentials or a decision. Nothing in this repository can do those steps for you, and nothing in it reports them as done when they are not.

## 1. What is automated and what needs you

| Step | Automated by | Needs you |
| --- | --- | --- |
| Lint, typecheck, migrations, 260+ tests, build, dependency audit | CI `check` job | — |
| Browser e2e: upload → scan → extract (fixture) → match → review → export | CI `e2e` job | — |
| Go-live verifier against real Postgres, S3-compatible storage and ClamAV | CI `e2e` job (local services) | — |
| Docker image builds, migrates, boots and reports its setup state | CI `image` job | — |
| Deploy one commit to staging or production, wait for it, check the app | `Deploy` workflow | 🔑 One-time setup (§3) and pressing **Run workflow** |
| Verify each real provider (Clerk, S3, ClamAV, Anthropic, Sentry, Resend) | `npm run ops:verify-live` | 🔑 Run it where the secrets are (§5) |
| Create accounts and keys; MFA; billing limits; DNS | — | 🔑 All of it (§2) |
| Full workflow with real extraction on a real invoice | — | 🔑 Manual staging rehearsal (§6) |
| Alerts, restore drill, retention agreement, security review | Scripts and runbook | 🔑 Sign-off (§8) |

## 2. Accounts and credentials 🔑

Create everything twice, once for **staging** and once for **production**. Never share keys between the two. Put every value in the hosting platform's secret manager (Render: service environment, `sync: false`; Fly: `fly secrets set`). Never put them in GitHub, Slack or this repository. `.env.example` documents every variable.

### 2.1 PostgreSQL 16

Use any managed provider with point-in-time recovery, such as Render Postgres, Neon, Supabase, RDS or Crunchy.

1. Create the database and an **app role that is not a superuser and cannot bypass row-level security**:
   ```sql
   CREATE ROLE avix_app LOGIN PASSWORD '<generated>' NOSUPERUSER NOBYPASSRLS;
   CREATE DATABASE avixcheck OWNER avix_app;
   ```
2. Turn on PITR and require TLS.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://avix_app:<pw>@<host>:5432/avixcheck?sslmode=require` |
| `MIGRATION_DATABASE_URL` | Optional. Same as above, or an owner role if your provider separates them. |
| `BACKUP_DATABASE_URL` | The database owner role, or a read-only `BYPASSRLS` role, used by `ops:backup` only. |
| `RESTORE_ADMIN_DATABASE_URL` | A role with `CREATEDB` on a **non-production** server, for restore drills. |

Verified by `ops:verify-live --only database`, which checks that the role is not a superuser or `BYPASSRLS`, that TLS is on, that every migration is applied and that RLS is forced on every tenant table.

### 2.2 Clerk (authentication)

1. In the Clerk dashboard, create an application, then a **Production instance**. Production instances need your own domain and DNS records, which Clerk lists for you.
2. Turn on **multi-factor authentication** (User & Authentication → Multi-factor). Require it for every user if your policy allows that.
3. Turn on email address as an identifier, so invitations can be matched to the signed-in email.
4. Set the allowed origins and redirect URLs to your `APP_URL`.
5. Set the session lifetime to fit your policy.

| Variable | Value |
| --- | --- |
| `AUTH_PROVIDER` | `clerk` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_…` (production) or `pk_test_…` (staging) |
| `CLERK_SECRET_KEY` | `sk_live_…` / `sk_test_…` |

Verified by `ops:verify-live --only auth`. With `APP_ENV=production` it refuses development keys. It checks that the secret key is accepted by the Clerk Backend API and that the publishable key resolves to a live Frontend API. MFA cannot be checked through the API, so test it by hand in §6.

### 2.3 S3-compatible document storage

AWS S3, Cloudflare R2, Backblaze B2, Wasabi and MinIO all work.

1. Create a bucket named, for example, `avixcheck-prod-documents`. **Block all public access**, turn on default encryption and turn on **versioning**.
2. Create credentials limited to that bucket: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on that bucket only.
3. Create a **separate backup bucket**, ideally in another account or region, with object lock or a retention period and its own write-only credentials.

| Variable | Value |
| --- | --- |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Document bucket and its scoped key |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | Blank for AWS. Set both for R2, B2, MinIO and similar (path style `true` for MinIO). |
| `BACKUP_S3_*` | Backup bucket and its credentials |

Verified by `ops:verify-live --only storage`. It writes an object, reads it back, fetches it through a signed URL, confirms that an **unsigned** request is refused (so the bucket is private), reports whether versioning is on, and deletes the test object.

### 2.4 ClamAV (malware scanning)

There is no account to create. `render.yaml` already defines a private ClamAV service and wires `CLAMAV_HOST` to it. On Fly, deploy `deploy/fly/clamav.toml` as its own private app and set `CLAMAV_HOST=avixcheck-clamav.internal`. Never expose port 3310 publicly. ClamAV needs 2–3 GB of RAM.

Verified by `ops:verify-live --only malwareScan`. It checks that a clean file scans clean and that the **EICAR test file is detected**.

### 2.5 Anthropic (AI extraction)

1. In the Claude Console, create a **dedicated workspace** for AvixCheck production and set a **monthly spend limit** on it.
2. Create an API key in that workspace.

| Variable | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | `sk-ant-…` |
| `EXTRACTION_MODEL` | `claude-sonnet-5-5` (default) |
| `EXTRACTION_PROVIDER` | `anthropic` (the default). `fixture` is refused outside tests. |

Verified by `ops:verify-live --only aiExtraction`. It makes **one real API call**, costing a few cents, on a generated sample invoice. It checks that the output passes the same schema validation the app uses and that the invoice number, PO number, total, currency and line count match what was printed.

### 2.6 Sentry (error monitoring, recommended)

Create a Node.js project and copy its DSN into `SENTRY_DSN`. The app already strips cookies, headers, bodies, query strings, AI inputs and outputs, and database parameters.

Verified by `ops:verify-live --only errorMonitoring`, which sends a test event and prints its id. Find that event in Sentry under the right environment.

### 2.7 Resend (invitation email, optional)

1. Add and **verify your sending domain** in Resend (SPF and DKIM DNS records).
2. Create an API key with **sending access** only.

| Variable | Value |
| --- | --- |
| `RESEND_API_KEY` | `re_…` |
| `EMAIL_FROM` | `AvixCheck <no-reply@yourdomain.com>` (must use the verified domain) |

Without Resend, admins copy the one-time invitation link from Settings. With it, the invite is emailed, and the admin is told if sending failed.

Verified by `ops:verify-live --only email --email-to you@yourdomain.com`, which sends a real email. Confirm that it arrives and is not in spam.

### 2.8 Everything else

| Variable | Value |
| --- | --- |
| `APP_ENV` | `staging` or `production`. Production blocks demo organisations and the demo seeder. |
| `APP_URL` | `https://app.yourdomain.com`, the public HTTPS origin |
| `LOG_LEVEL` | `info` |
| `DEFAULT_RETENTION_DAYS` | Agree this with customers. The default is 2555 days (about 7 years). |

## 3. One-time pipeline setup 🔑

1. **Choose a host.** The default is Render (`render.yaml`). Fly.io is the alternative (`fly.toml` and `deploy/fly/clamav.toml`).
2. **Render:** Dashboard → Blueprints → New → this repository. Create one Blueprint for staging and one for production, each with its own secrets. On each web and worker service, copy the **Deploy Hook** URL (Settings → Deploy Hook).
   **Fly:** `fly launch --no-deploy --copy-config`, then `fly secrets set …`, and create a deploy token with `fly tokens create deploy`.
3. **GitHub repository settings:**
   - Variables → `DEPLOY_TARGET` = `render` or `fly`.
   - Environments → create `staging` and `production`. On **production**, add **Required reviewers** and limit deployment branches to `main`.
   - On each environment, set the variable `APP_URL`, plus either the secrets `RENDER_DEPLOY_HOOK_WEB` and `RENDER_DEPLOY_HOOK_WORKER`, or the secret `FLY_API_TOKEN` and the variable `FLY_APP`.
4. Branch protection on `main`: require the `check`, `e2e` and `image` CI jobs.

The **Deploy** workflow (Actions → Deploy → Run workflow) builds the image, deploys it, waits until `/api/health` reports the new commit as `release`, then runs the app checks against the live URL. It saves the result as a `golive-evidence` artifact.

## 4. Release flow

```
PR → CI (check, e2e, image) green → merge to main
   → Deploy: staging → verify-live on staging (§5) → rehearsal (§6)
   → Deploy: production (reviewer approves) → verify-live on production → smoke test (§7)
```

Migrations run automatically before new code takes traffic: Render's `preDeployCommand` or Fly's `release_command`. To roll back, redeploy the previous commit. Migrations are additive, so older code keeps working (RUNBOOK §3).

## 5. Verify every live service 🔑

Run this **where the secrets are**, so they never leave the platform:

```bash
# Render: Dashboard → avixcheck-web → Shell.  Fly: fly ssh console --app avixcheck
npm run ops:verify-live -- --app-url "$APP_URL" --email-to you@yourdomain.com
```

Example output, from a run against a local Postgres 16 and ClamAV 1.4:

```
WARN  database
      PASS  connect — PostgreSQL 16.15
      PASS  app role cannot bypass row-level security — role avix_app: rolsuper=f, rolbypassrls=f
      WARN  connection uses TLS — connection is not encrypted; add sslmode=require to DATABASE_URL
      PASS  all migrations applied — 7 migrations applied
      PASS  row-level security forced on tenant tables
PASS  malwareScan
      PASS  clean file scans clean
      PASS  EICAR test file is detected — Eicar-Test-Signature
```

Rules:
- The run exits 0 only when every **required** check (database, auth, storage, malwareScan, aiExtraction, app) ran and passed. **A skipped check is not a pass.** An unconfigured service shows as `SKIP` and fails the run.
- `WARN` lines are allowed but must be read. In production, a database without TLS and an app not served over HTTPS are failures, not warnings.
- A JSON report is written to `golive-evidence/`. Keep it as evidence for §8.
- Run one provider at a time with `--only storage` or `--only aiExtraction,auth`.

## 6. Staging rehearsal 🔑

Do this on staging with real integrations: real Clerk, real Anthropic, real S3 and ClamAV.

1. `ops:verify-live` passes on staging (§5).
2. Sign up as the first user and **enrol MFA**. Sign out, then sign in again with MFA.
3. Create an organisation. Invite a second address as a Reviewer and a third as a Viewer. Confirm both emails arrive, or copy the links if Resend is not set up. Accept both invitations.
4. Settings → download each CSV template. Import suppliers, purchase orders, price agreements and approved charges, using the preview, then fix one deliberately bad row.
5. Upload **three real supplier invoices** that you have permission to use:
   - one that should pass cleanly
   - one with a known price or quantity difference
   - one credit note
6. Upload an **EICAR test file** renamed to `.pdf`. It must end up quarantined and never be processed.
7. For each invoice, check the extracted header and lines against the PDF shown alongside them. Correct one field by hand.
8. Check the discrepancies on the Exceptions page. Assign one, accept a variance with a reason, and reject another.
9. Reports → export CSV. Open the download, then confirm the signed link stops working after `SIGNED_URL_TTL_SECONDS`.
10. As the Viewer, confirm you cannot edit, decide or import. In a second organisation, confirm you cannot see the first organisation's data.
11. In Sentry, the staging test event is visible. Then trigger a real error, for example by stopping ClamAV briefly and uploading a file. Confirm the document stays in `scanning` and the job shows a visible failure that **Retry** recovers.
12. Write down the invoices used, the screenshots and the outcome. This is the evidence for production blocker 3 in `final-report.md`.

## 7. Production cut-over 🔑

1. Production secrets are set and `/setup` shows every integration as configured.
2. Run **Deploy → production**. A reviewer approves it, and the workflow reports the release as live with the app checks passing.
3. `ops:verify-live` passes in the production shell (§5). Keep the report.
4. Confirm that no demo data exists: `select count(*) from organizations where is_demo` must return 0.
5. Run `npm run ops:backup` once by hand and confirm the files are in the backup bucket.
6. Smoke test with a real account: sign in with MFA, upload one invoice, and see it reach review.

## 8. Pre-launch checklist

Tick each item **with evidence**: a link, a report file, a screenshot or a log line. This list combines RUNBOOK §10 with the blockers in the build report.

**Code and pipeline**
- [ ] CI `check`, `e2e` and `image` green on the release commit
- [ ] Deploy workflow succeeded for staging and for production (attach the run links)

**Live services** (report from `ops:verify-live`)
- [ ] Database: non-superuser, non-BYPASSRLS role; TLS; migrations; RLS forced
- [ ] Clerk: live keys accepted; Frontend API reachable; MFA enrolled and used by hand
- [ ] S3: write, read and signed URL work; unsigned access refused; versioning on
- [ ] ClamAV: clean file passes; EICAR detected; port 3310 not public
- [ ] Anthropic: sample extraction matches; workspace spend limit set
- [ ] Sentry: test event received from web and from worker
- [ ] Resend: domain verified; test email received (or decided not to use it)

**Workflow**
- [ ] Staging rehearsal (§6) done with real invoices, with evidence filed
- [ ] Tenant isolation checked with two organisations in staging

**Operations** (RUNBOOK §4–§10)
- [ ] Alerts configured and test-fired: health, worker, backup, retention
- [ ] First production backup uploaded; backup bucket has object lock and lifecycle rules
- [ ] Restore drill passed on a real backup and recorded in the RUNBOOK log
- [ ] PITR enabled at the database provider
- [ ] Retention period agreed with customers; legal hold tested
- [ ] Secret rotation owners named; secrets only in the platform secret manager
- [ ] Security review or penetration test of auth, tenant isolation and uploads done, with findings fixed
- [ ] On-call rota and incident contacts written down

Only call AvixCheck production-ready when every box above is ticked.
