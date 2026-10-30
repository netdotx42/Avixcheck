"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";

type Item = {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: "queued" | "uploading" | "done" | "duplicate" | "error";
  invoiceId?: string;
  error?: string;
};

const CONCURRENCY = 3;

function upload(file: File, onProgress: (p: number) => void): Promise<{ status: number; body: { invoiceId?: string; duplicate?: boolean; error?: string } }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/invoices/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = { error: "Unexpected response from the server." };
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: { error: "Network error. Check your connection and retry." } });
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

export function Uploader({ maxBytes }: { maxBytes: number }) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const files = useRef(new Map<string, File>());
  const input = useRef<HTMLInputElement>(null);

  const patch = (key: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  async function run(keys: string[]) {
    const queue = [...keys];
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const file = files.current.get(key)!;
        patch(key, { state: "uploading", progress: 0, error: undefined });
        const res = await upload(file, (progress) => patch(key, { progress }));
        if (res.status === 201 || res.status === 200) {
          patch(key, { state: res.body.duplicate ? "duplicate" : "done", progress: 100, invoiceId: res.body.invoiceId });
        } else {
          patch(key, { state: "error", error: res.body.error ?? `Upload failed (${res.status}).` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }

  function add(list: FileList | null) {
    if (!list) return;
    const added: Item[] = [];
    for (const f of Array.from(list)) {
      const key = `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
      files.current.set(key, f);
      const tooBig = f.size > maxBytes;
      const notPdf = !/\.pdf$/i.test(f.name) && f.type !== "application/pdf";
      added.push({
        key,
        name: f.name,
        size: f.size,
        progress: 0,
        state: tooBig || notPdf ? "error" : "queued",
        error: tooBig ? `Larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.` : notPdf ? "Only PDF files are accepted." : undefined,
      });
    }
    setItems((l) => [...added, ...l]);
    void run(added.filter((i) => i.state === "queued").map((i) => i.key));
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); add(e.dataTransfer.files); }}
        className={`flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center ${dragging ? "border-focus bg-surface-2" : "border-border"}`}
      >
        <UploadCloud aria-hidden className="mb-3 size-8 text-silver" />
        <p className="text-sm">Drag PDF invoices here, or</p>
        <button type="button" className="btn btn-primary mt-3" onClick={() => input.current?.click()}>Choose files</button>
        <label htmlFor="invoice-files" className="sr-only">Choose PDF invoices</label>
        <input ref={input} id="invoice-files" type="file" accept="application/pdf,.pdf" multiple className="sr-only" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>

      {items.length > 0 && (
        <ul className="mt-5 divide-y divide-border" aria-live="polite">
          {items.map((i) => (
            <li key={i.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm">{i.name}</div>
                <div className="num text-xs text-muted">{(i.size / 1024).toFixed(0)} KB</div>
                {i.state === "uploading" && (
                  <div className="mt-1 h-1.5 w-48 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={i.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${i.name}`}>
                    <div className="h-full bg-primary transition-all" style={{ width: `${i.progress}%` }} />
                  </div>
                )}
                {i.error && <p role="alert" className="mt-1 text-xs text-danger">{i.error}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {i.state === "queued" && <StatusBadge tone="neutral" label="Queued" />}
                {i.state === "uploading" && <StatusBadge tone="progress" label={`Uploading ${i.progress}%`} />}
                {i.state === "done" && <StatusBadge tone="ok" label="Uploaded" />}
                {i.state === "duplicate" && <StatusBadge tone="info" label="Already uploaded" />}
                {i.state === "error" && <StatusBadge tone="danger" label="Failed" />}
                {i.invoiceId && <Link href={`/invoices/${i.invoiceId}`} className="text-sm text-focus hover:underline">{i.state === "duplicate" ? "View existing" : "View"}</Link>}
                {i.state === "error" && files.current.has(i.key) && !/limit|Only PDF/.test(i.error ?? "") && (
                  <button type="button" className="btn btn-secondary py-1" onClick={() => void run([i.key])}>Retry</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
