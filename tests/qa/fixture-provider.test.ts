import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache, env, integrationStatus } from "../../src/env";

/** The e2e fixture extractor must never be selectable outside APP_ENV=test. */
describe("test-only fixture extraction provider", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  const set = (vars: Record<string, string>) => {
    Object.assign(process.env, vars);
    resetEnvCache();
  };

  it("is refused outside APP_ENV=test", () => {
    set({ EXTRACTION_PROVIDER: "fixture", APP_ENV: "staging" });
    expect(() => env()).toThrow(/only allowed when APP_ENV=test/);
  });

  it("is refused in production even with APP_ENV=test", () => {
    set({ EXTRACTION_PROVIDER: "fixture", APP_ENV: "test", NODE_ENV: "production", AUTH_PROVIDER: "clerk" });
    expect(() => env()).toThrow(/only allowed/);
  });

  it("is labelled as a test fixture wherever setup state is shown", () => {
    set({ EXTRACTION_PROVIDER: "fixture", APP_ENV: "test" });
    const ai = integrationStatus().find((i) => i.key === "aiExtraction")!;
    expect(ai.label).toMatch(/TEST FIXTURE/);
    expect(ai.configured).toBe(true);
  });
});
