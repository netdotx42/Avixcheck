export type Role = "admin" | "reviewer" | "viewer";

/**
 * Server-side permission matrix. UI hides actions a role can't take, but every
 * server action, route handler and job enqueue re-checks with `can()`.
 */
export const PERMISSIONS = {
  "org.view": ["admin", "reviewer", "viewer"],
  "org.manage": ["admin"],
  "members.manage": ["admin"],
  "settings.manage": ["admin"],
  "reference.view": ["admin", "reviewer", "viewer"],
  "reference.import": ["admin"],
  "reference.edit": ["admin"],
  "invoice.view": ["admin", "reviewer", "viewer"],
  "invoice.upload": ["admin", "reviewer"],
  "invoice.edit": ["admin", "reviewer"],
  "invoice.recheck": ["admin", "reviewer"],
  "document.view": ["admin", "reviewer", "viewer"],
  "exception.view": ["admin", "reviewer", "viewer"],
  "exception.assign": ["admin", "reviewer"],
  "exception.decide": ["admin", "reviewer"],
  /** Accepting a variance above tolerance is a financial authorisation. */
  "exception.accept_variance": ["admin"],
  "report.view": ["admin", "reviewer", "viewer"],
  "export.create": ["admin", "reviewer"],
  "jobs.view": ["admin", "reviewer"],
  "jobs.recover": ["admin"],
  "audit.view": ["admin"],
  "retention.manage": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(public readonly permission?: Permission) {
    super(permission ? `Missing permission: ${permission}` : "Forbidden");
    this.name = "ForbiddenError";
  }
}

export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor() {
    super("Not signed in");
    this.name = "UnauthenticatedError";
  }
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}
