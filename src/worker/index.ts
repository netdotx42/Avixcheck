import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { closeDb } from "@/db/client";
import { logger, reportError } from "@/lib/logger";
import { runWorkerLoop } from "@/lib/jobs/runner";
import { registeredTypes } from "@/lib/jobs/registry";
import { env, integrationStatus } from "@/env";
import { flushMonitoring, initMonitoring } from "@/lib/monitoring";
import { startScheduler } from "@/modules/ops/scheduler";
import "./handlers";

async function main() {
  env();
  await initMonitoring("worker");
  const missing = integrationStatus().filter((i) => i.required && !i.configured);
  if (missing.find((m) => m.key === "database")) {
    logger.fatal("DATABASE_URL is not set; worker cannot start");
    process.exit(1);
  }
  for (const m of missing) logger.warn({ integration: m.key, missing: m.missing }, "integration not configured; dependent jobs will fail visibly");
  const workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const ac = new AbortController();
  const stop = (sig: string) => {
    logger.info({ sig }, "worker stopping after current job");
    ac.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  logger.info({ workerId, types: registeredTypes() }, "worker started");
  if (process.env.WORKER_SCHEDULER !== "off") startScheduler(ac.signal);
  await runWorkerLoop(workerId, ac.signal);
  await flushMonitoring();
  await closeDb();
  logger.info("worker stopped");
}

main().catch(async (err) => {
  logger.fatal({ err: String(err) }, "worker crashed");
  reportError(err, { component: "worker" });
  await flushMonitoring();
  process.exit(1);
});
