import { describe, expect, it } from "vitest";
import { assertCan, can, ForbiddenError, PERMISSIONS } from "../src/lib/auth/permissions";
import { signValue, verifyValue } from "../src/lib/auth/signed-cookie";
import { parseClamdResponse } from "../src/lib/scan/clamav";

describe("role permissions", () => {
  it("admins can do everything", () => {
    for (const p of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) expect(can("admin", p)).toBe(true);
  });
  it("viewers are read-only", () => {
    for (const p of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      const readOnly = p.endsWith(".view");
      if (!readOnly) expect(can("viewer", p), p).toBe(false);
    }
    expect(can("viewer", "audit.view")).toBe(false);
    expect(can("viewer", "jobs.view")).toBe(false);
  });
  it("reviewers decide exceptions but cannot authorise variances or manage members", () => {
    expect(can("reviewer", "exception.decide")).toBe(true);
    expect(can("reviewer", "exception.accept_variance")).toBe(false);
    expect(can("reviewer", "members.manage")).toBe(false);
    expect(can("reviewer", "reference.import")).toBe(false);
    expect(() => assertCan("reviewer", "settings.manage")).toThrow(ForbiddenError);
  });
});

describe("signed cookies", () => {
  it("round-trips and rejects tampering or expiry", () => {
    const v = signValue({ email: "a@b.c" }, "s3cret", 60);
    expect(verifyValue<{ email: string }>(v, "s3cret")?.email).toBe("a@b.c");
    expect(verifyValue(v, "other")).toBeNull();
    const [body, sig] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "admin@x.y", exp: 9e9 })).toString("base64url");
    expect(verifyValue(`${forged}.${sig}`, "s3cret")).toBeNull();
    expect(verifyValue(`${body}.`, "s3cret")).toBeNull();
    expect(verifyValue(signValue({ email: "a" }, "s3cret", -10), "s3cret")).toBeNull();
  });
});

describe("clamd parsing", () => {
  it("parses clean, infected and error responses", () => {
    expect(parseClamdResponse("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamdResponse("stream: Eicar-Test-Signature FOUND\0")).toEqual({ status: "infected", signature: "Eicar-Test-Signature" });
    expect(parseClamdResponse("INSTREAM size limit exceeded. ERROR").status).toBe("error");
    expect(parseClamdResponse("").status).toBe("error");
  });
});

describe("org settings defaults", async () => {
  const { parseOrgSettings } = await import("../src/lib/org-settings");
  it("fills nested defaults from an empty object", () => {
    const s = parseOrgSettings({});
    expect(s.rounding.mode).toBe("half_up");
    expect(s.tolerances.unitPrice.absolute).toBe("0.01");
    expect(s.review.minExtractionConfidence).toBe("0.90");
  });
  it("rejects float-ish tolerance values", () => {
    expect(() => parseOrgSettings({ tolerances: { unitPrice: { absolute: "1e-2", percent: "0" } } })).toThrow();
  });
});
