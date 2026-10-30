/**
 * Structural checks on an uploaded PDF before it is stored. This is not a
 * substitute for malware scanning (ClamAV runs afterwards); it rejects files
 * that are not PDFs and PDFs carrying features we never want to process.
 *
 * Detection works on the raw bytes. Content inside compressed object streams
 * is not inflated here, so these checks are best-effort; the malware scan and
 * the fact that we never render or execute the PDF server-side cover the rest.
 */

export type PdfRejection =
  | { code: "empty"; message: string }
  | { code: "too_large"; message: string }
  | { code: "not_pdf"; message: string }
  | { code: "truncated"; message: string }
  | { code: "encrypted"; message: string }
  | { code: "active_content"; message: string };

export type PdfCheck = { ok: true } | { ok: false; rejection: PdfRejection };

/** Decode PDF name escapes (`/Java#53cript` is `/JavaScript`). */
function decodeNameEscapes(s: string): string {
  return s.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const ACTIVE_NAMES: { re: RegExp; what: string }[] = [
  { re: /\/JavaScript\b/, what: "embedded JavaScript" },
  { re: /\/JS[\s(<\[/]/, what: "embedded JavaScript" },
  { re: /\/Launch\b/, what: "a launch action" },
  { re: /\/EmbeddedFiles?\b/, what: "embedded files" },
  { re: /\/RichMedia\b/, what: "rich media" },
  { re: /\/XFA\b/, what: "an XFA form" },
];

export function checkPdf(bytes: Buffer, maxBytes: number): PdfCheck {
  const reject = (code: PdfRejection["code"], message: string): PdfCheck => ({ ok: false, rejection: { code, message } as PdfRejection });
  if (bytes.length === 0) return reject("empty", "The file is empty.");
  if (bytes.length > maxBytes) return reject("too_large", `The file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB upload limit.`);
  // Magic bytes. The spec allows up to 1024 bytes of leading junk, but we require a clean header.
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return reject("not_pdf", "The file is not a PDF (missing %PDF- header).");
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) return reject("truncated", "The PDF looks incomplete (no end-of-file marker).");

  const text = decodeNameEscapes(bytes.toString("latin1"));
  if (/\/Encrypt\b/.test(text)) return reject("encrypted", "Encrypted or password-protected PDFs are not accepted. Upload an unprotected copy.");
  for (const { re, what } of ACTIVE_NAMES) {
    if (re.test(text)) return reject("active_content", `The PDF contains ${what}, which is not accepted for security reasons.`);
  }
  return { ok: true };
}

/** Sanitise a client-supplied file name for storage and display. */
export function safeFileName(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || "invoice.pdf";
}
