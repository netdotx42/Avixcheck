import type { JobRow } from "./queue";

export interface JobContext {
  job: JobRow;
  /** Tenant the job belongs to. Handlers must open their own withTenant(orgId, ...) transactions. */
  orgId: string;
  workerId: string;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/**
 * Job types. Each module registers its handler in src/worker/handlers.ts.
 * Keep idempotency keys tenant-prefixed: `${orgId}:${type}:${entityId}[:revision]`.
 */
export const JOB_TYPES = {
  scanDocument: "document.scan",
  extractInvoice: "invoice.extract",
  matchInvoice: "invoice.match",
  checkInvoice: "invoice.check",
  generateExport: "export.generate",
  retentionSweep: "ops.retention_sweep",
} as const;

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler) {
  if (handlers.has(type)) throw new Error(`Handler already registered for ${type}`);
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export function registeredTypes(): string[] {
  return [...handlers.keys()];
}

export function idempotencyKey(orgId: string, type: string, ...parts: (string | number)[]) {
  return [orgId, type, ...parts].join(":");
}
