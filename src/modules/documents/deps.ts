import { env, isConfigured } from "@/env";
import { deleteObject, getObjectBytes, putObject } from "@/lib/storage";
import { scanBuffer, type ScanResult } from "@/lib/scan/clamav";
import type { ExtractionProvider } from "@/modules/extraction/types";
import { anthropicExtractionProvider } from "@/modules/extraction/anthropic";
import { fixtureExtractionProvider } from "@/modules/extraction/fixture";

/**
 * External services used by the documents pipeline. Production code always
 * uses the real implementations below; tests swap them through
 * `setDocumentDepsForTests` so no integration is ever faked at runtime.
 */
export interface DocumentDeps {
  storage: {
    configured(): boolean;
    put(key: string, bytes: Buffer, contentType: string): Promise<void>;
    get(key: string): Promise<Buffer>;
    delete(key: string): Promise<void>;
  };
  scanner: {
    configured(): boolean;
    scan(bytes: Buffer): Promise<ScanResult>;
  };
  extractor: ExtractionProvider;
}

const realDeps: DocumentDeps = {
  storage: {
    configured: () => isConfigured("storage"),
    put: (key, bytes, contentType) => putObject(key, bytes, contentType),
    get: (key) => getObjectBytes(key),
    delete: (key) => deleteObject(key),
  },
  scanner: {
    configured: () => isConfigured("malwareScan"),
    scan: (bytes) => scanBuffer(bytes),
  },
  extractor: env().EXTRACTION_PROVIDER === "fixture" ? fixtureExtractionProvider : anthropicExtractionProvider,
};

let current: DocumentDeps = realDeps;

export function deps(): DocumentDeps {
  return current;
}

/** Test-only override. Refuses to run outside NODE_ENV=test. */
export function setDocumentDepsForTests(overrides: Partial<DocumentDeps> | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setDocumentDepsForTests is test-only");
  current = overrides ? { ...realDeps, ...overrides } : realDeps;
}
