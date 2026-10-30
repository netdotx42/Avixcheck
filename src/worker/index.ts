import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { closeDb } from "@/db/client";
import { logger } from "@/lib/logger";
import { runWorkerLoop } from "@/lib/jobs/runner";
import { registeredTypes } from "@/lib/jobs/registry";
import { env, integrationStatus } from "@/env";
import "./handlers";

async function main() {
  env();
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
  await runWorkerLoop(workerId, ac.signal);
  await closeDb();
  logger.info("worker stopped");
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, "worker crashed");
  process.exit(1);
});
