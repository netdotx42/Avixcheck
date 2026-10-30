/**
 * Seed a clearly-labelled demo organisation with synthetic reference data.
 * Refuses when APP_ENV=production. Only ever writes to an is_demo organisation.
 *
 *   APP_ENV=demo DEMO_OWNER_EMAIL=you@example.com npm run db:seed-demo
 */
import { closeDb } from "../src/db/client";
import { seedDemo } from "../src/modules/ops/demo-seed";

seedDemo({ appEnv: process.env.APP_ENV ?? "development", ownerEmail: process.env.DEMO_OWNER_EMAIL })
  .then(async (r) => {
    console.log(JSON.stringify({ level: "info", msg: r.created ? "demo organisation seeded" : "demo organisation already exists", orgId: r.orgId }));
    await closeDb();
  })
  .catch(async (e) => {
    console.error(JSON.stringify({ level: "error", msg: "demo seed failed", error: e instanceof Error ? e.message : String(e) }));
    await closeDb();
    process.exit(1);
  });
