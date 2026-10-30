import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, type Permission, type Role } from "../../src/lib/auth/permissions";

/**
 * The full role x permission matrix, written out. Any change to who can do
 * what must change this table in the same PR, so it gets reviewed.
 */
const A = "admin", R = "reviewer", V = "viewer";
const EXPECTED: Record<Permission, Role[]> = {
  "org.view": [A, R, V],
  "org.manage": [A],
  "members.manage": [A],
  "settings.manage": [A],
  "reference.view": [A, R, V],
  "reference.import": [A],
  "reference.edit": [A],
  "invoice.view": [A, R, V],
  "invoice.upload": [A, R],
  "invoice.edit": [A, R],
  "invoice.recheck": [A, R],
  "document.view": [A, R, V],
  "exception.view": [A, R, V],
  "exception.assign": [A, R],
  "exception.decide": [A, R],
  "exception.accept_variance": [A],
  "report.view": [A, R, V],
  "export.create": [A, R],
  "jobs.view": [A, R],
  "jobs.recover": [A],
  "audit.view": [A],
  "retention.manage": [A],
};

describe("permission matrix", () => {
  it("lists exactly the permissions the app defines", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const role of [A, R, V] as Role[]) {
    it(`${role} has exactly the expected permissions`, () => {
      const actual = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p)).sort();
      const expected = (Object.keys(EXPECTED) as Permission[]).filter((p) => EXPECTED[p].includes(role)).sort();
      expect(actual).toEqual(expected);
    });
  }

  it("only admins hold financial authorisation and recovery powers", () => {
    for (const p of ["exception.accept_variance", "jobs.recover", "reference.import", "members.manage", "retention.manage"] as Permission[]) {
      expect(can("reviewer", p), p).toBe(false);
      expect(can("viewer", p), p).toBe(false);
    }
  });
});
