import net from "node:net";
import { env, requireIntegration } from "@/env";

export type ScanResult = { status: "clean" } | { status: "infected"; signature: string } | { status: "error"; detail: string };

/**
 * Scan bytes with clamd using the INSTREAM protocol. Throws
 * IntegrationNotConfiguredError when CLAMAV_HOST is not set: callers must keep
 * the document quarantined, never treat "not scanned" as clean.
 */
export async function scanBuffer(bytes: Buffer, timeoutMs = 60_000): Promise<ScanResult> {
  requireIntegration("malwareScan");
  const { CLAMAV_HOST, CLAMAV_PORT } = env();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: CLAMAV_HOST!, port: CLAMAV_PORT });
    let response = "";
    const done = (r: ScanResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done({ status: "error", detail: "clamd timeout" }));
    socket.on("error", (e) => done({ status: "error", detail: `clamd connection error: ${e.message}` }));
    socket.on("data", (d) => (response += d.toString("utf8")));
    socket.on("end", () => resolve(parseClamdResponse(response)));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const chunk = 64 * 1024;
      for (let i = 0; i < bytes.length; i += chunk) {
        const part = bytes.subarray(i, i + chunk);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length, 0);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

export function parseClamdResponse(raw: string): ScanResult {
  const r = raw.replace(/\0/g, "").trim();
  if (/^stream: OK$/.test(r)) return { status: "clean" };
  const m = r.match(/^stream: (.+) FOUND$/);
  if (m) return { status: "infected", signature: m[1]! };
  return { status: "error", detail: r || "empty clamd response" };
}
