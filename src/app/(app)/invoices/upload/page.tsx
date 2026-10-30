import Link from "next/link";
import { Card, ErrorState, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status-badge";
import { pageContext } from "@/lib/auth/page-guard";
import { env, integrationStatus } from "@/env";
import { Uploader } from "./uploader";

export const metadata = { title: "Upload invoices" };

export default async function UploadPage() {
  await pageContext("invoice.upload");
  const status = integrationStatus();
  const storage = status.find((s) => s.key === "storage")!;
  const scan = status.find((s) => s.key === "malwareScan")!;
  const ai = status.find((s) => s.key === "aiExtraction")!;
  const maxMb = Math.floor(env().MAX_UPLOAD_BYTES / (1024 * 1024));

  return (
    <>
      <PageHeader title="Upload invoices" description={`PDF only, up to ${maxMb} MB each. Every file is malware-scanned before it is read.`} actions={<Link href="/invoices" className="btn btn-secondary">Back to invoices</Link>} />
      {!storage.configured ? (
        <ErrorState title="Uploads are disabled" body={`Private document storage is not configured (missing ${storage.missing.join(", ")}). An admin needs to set it up before invoices can be uploaded.`} action={<Link href="/setup" className="btn btn-secondary">View setup</Link>} />
      ) : (
        <div className="space-y-6">
          {(!scan.configured || !ai.configured) && (
            <div role="status" className="card border-warn/40 p-4 text-sm">
              <p className="font-medium text-warn">Uploads will be stored but not processed yet</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                {!scan.configured && <li>Malware scanning is not configured ({scan.missing.join(", ")}). Files stay held as unscanned and are never extracted or shown.</li>}
                {!ai.configured && <li>AI extraction is not configured ({ai.missing.join(", ")}). Scanned files wait until it is set up.</li>}
              </ul>
            </div>
          )}
          <Card>
            <Uploader maxBytes={env().MAX_UPLOAD_BYTES} />
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">What happens next</h2>
            <ol className="space-y-2 text-sm text-muted">
              <li className="flex items-center gap-2"><StatusBadge tone="progress" label="Scanning" /> ClamAV checks the file. Infected files are quarantined.</li>
              <li className="flex items-center gap-2"><StatusBadge tone="progress" label="Extracting" /> AI reads the header and line items. Nothing is calculated by AI.</li>
              <li className="flex items-center gap-2"><StatusBadge tone="warn" label="Needs review" /> Uncertain or incomplete extractions wait for a person to correct them.</li>
              <li className="flex items-center gap-2"><StatusBadge tone="progress" label="Matching" /> Confident extractions move on to matching and financial checks.</li>
            </ol>
          </Card>
        </div>
      )}
    </>
  );
}
