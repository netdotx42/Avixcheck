import { JOB_TYPES, registerHandler } from "@/lib/jobs/registry";
import { withFailureState } from "../matching/jobs";
import { runCheck } from "./service";

registerHandler(JOB_TYPES.checkInvoice, (ctx) => withFailureState(ctx, "checking", (p) => runCheck(ctx.orgId, p.invoiceId, p.revision)));
