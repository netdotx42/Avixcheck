import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/context";
import { ForbiddenError, UnauthenticatedError } from "@/lib/auth/permissions";
import { TEMPLATES } from "@/modules/imports/templates";
import { isImportKind } from "@/modules/imports/types";

export const dynamic = "force-dynamic";

/** CSV template download. Contains only example data, but still requires a signed-in member. */
export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  try {
    await requireOrg("reference.view");
  } catch (e) {
    if (e instanceof UnauthenticatedError) return new NextResponse("Not signed in", { status: 401 });
    if (e instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
    throw e;
  }
  const { kind } = await params;
  if (!isImportKind(kind)) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(TEMPLATES[kind], {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="avixcheck-${kind.replace(/_/g, "-")}-template.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
