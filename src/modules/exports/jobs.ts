import { JOB_TYPES, registerHandler } from "@/lib/jobs/registry";
import { generateExport } from "./service";

registerHandler(JOB_TYPES.generateExport, (ctx) => generateExport(ctx));
