import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/env";
import type { ExtractionProvider, ProviderResult } from "./types";

/**
 * TEST-ONLY extraction provider for end-to-end runs (EXTRACTION_PROVIDER=fixture,
 * which env() refuses unless APP_ENV=test outside production). It never reads
 * the invoice: the PDF must carry a `AVIX-FIXTURE:<name>` marker naming a
 * recorded output in tests/fixtures/extraction/. Without a marker the result is
 * "incomplete", which routes the invoice to manual review like a real refusal.
 */
const MARKER = /AVIX-FIXTURE:([a-z0-9-]{1,64})/;

export const fixtureExtractionProvider: ExtractionProvider = {
  name: "test-fixture",
  configured: () => env().EXTRACTION_PROVIDER === "fixture" && env().APP_ENV === "test" && env().NODE_ENV !== "production",
  missing: () => (env().EXTRACTION_PROVIDER === "fixture" ? [] : ["EXTRACTION_PROVIDER=fixture"]),
  async extract(pdf: Buffer): Promise<ProviderResult> {
    if (!fixtureExtractionProvider.configured()) throw new Error("Fixture extraction provider is test-only");
    const name = MARKER.exec(pdf.toString("latin1"))?.[1];
    if (!name) return { kind: "incomplete", model: "test-fixture", reason: "No AVIX-FIXTURE marker in document" };
    const file = path.join(process.cwd(), "tests", "fixtures", "extraction", `${name}.json`);
    return { kind: "ok", model: "test-fixture", output: JSON.parse(readFileSync(file, "utf8")) };
  },
};
