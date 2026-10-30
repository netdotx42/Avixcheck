import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtractionProvider, ProviderResult } from "../../src/modules/extraction/types";

/** TEST-ONLY extraction provider that replays recorded outputs. */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "extraction", `${name}.json`), "utf8"));
}

export class FixtureExtractor implements ExtractionProvider {
  readonly name = "fixture";
  calls = 0;
  constructor(private next: () => Promise<ProviderResult> | ProviderResult) {}
  configured() {
    return true;
  }
  missing() {
    return [];
  }
  setNext(fn: () => Promise<ProviderResult> | ProviderResult) {
    this.next = fn;
  }
  async extract(): Promise<ProviderResult> {
    this.calls++;
    return this.next();
  }
}

export const fixtureResult = (name: string): ProviderResult => ({ kind: "ok", model: "fixture-model", output: loadFixture(name) });
