/**
 * Enqueue today's retention sweep for every organisation now (the worker also
 * does this hourly). The worker runs the jobs; check Settings → background jobs.
 *
 *   npm run ops:retention-run
 */
import { closeDb } from "../../src/db/client";
import { scheduleDailyJobs } from "../../src/modules/ops/scheduler";

scheduleDailyJobs()
  .then(async (created) => {
    console.log(JSON.stringify({ level: "info", msg: "retention sweeps enqueued", created }));
    await closeDb();
  })
  .catch(async (e) => {
    console.error(JSON.stringify({ level: "error", msg: "could not enqueue retention sweeps", error: e instanceof Error ? e.message : String(e) }));
    await closeDb();
    process.exit(1);
  });
