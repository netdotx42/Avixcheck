import "server-only";
import { redirect } from "next/navigation";
import { isConfigured } from "@/env";
import { getOrgContext, type OrgContext } from "./context";
import { can, type Permission } from "./permissions";
import { UnauthenticatedError } from "./permissions";

/**
 * For server components: resolve org context or redirect to setup / sign-in /
 * onboarding. Optionally require a permission (renders 403 via notFound-like redirect).
 */
export async function pageContext(permission?: Permission): Promise<OrgContext> {
  if (!isConfigured("database") || !isConfigured("auth")) redirect("/setup");
  let ctx: OrgContext | null;
  try {
    ctx = await getOrgContext();
  } catch (e) {
    if (e instanceof UnauthenticatedError) redirect("/sign-in");
    throw e;
  }
  if (!ctx) redirect("/onboarding");
  if (permission && !can(ctx.role, permission)) redirect("/forbidden");
  return ctx;
}
