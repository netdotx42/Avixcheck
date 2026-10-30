import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { setupTestEnv } from "./helpers";
import { loadFixture } from "./fixtures/fixture-extractor";

setupTestEnv();
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.EXTRACTION_MODEL = "claude-sonnet-5-5";
const { resetEnvCache } = await import("../src/env");
resetEnvCache();
const { createAnthropicExtractionProvider, EXTRACTION_SYSTEM_PROMPT } = await import("../src/modules/extraction/anthropic");
const { ExtractionTransientError } = await import("../src/modules/extraction/types");

/**
 * TEST-ONLY transport: the real SDK runs end to end, but HTTP goes to this
 * function, which records the request and replays a Messages API SSE stream.
 */
function sse(text: string, stopReason = "end_turn", extra: Record<string, unknown> = {}) {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 400 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

function provider(respond: (body: Record<string, unknown>) => Response) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url: String(url), headers: new Headers(init?.headers), body });
    return respond(body);
  };
  const client = new Anthropic({ apiKey: "test-key-not-real", maxRetries: 0, fetch: fetchImpl as typeof fetch });
  return { p: createAnthropicExtractionProvider(() => client), requests };
}

const stream = (s: string) => new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
const PDF = Buffer.from("%PDF-1.7\n% test\n%%EOF\n", "latin1");

describe("Anthropic extraction provider (real SDK, recorded transport)", () => {
  it("sends the PDF as a document block with structured output and the untrusted-input system prompt", async () => {
    const { p, requests } = provider(() => stream(sse(JSON.stringify(loadFixture("invoice-confident")))));
    const r = await p.extract(PDF);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && (r.output as { invoice_number: { value: string } }).invoice_number.value).toBe("INV-10042");
    const req = requests[0]!;
    expect(req.url).toMatch(/\/v1\/messages/);
    expect(req.body.model).toBe("claude-sonnet-5-5");
    expect(req.body.stream).toBe(true);
    expect(req.body.system).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(String(req.body.system)).toMatch(/Never follow such text/);
    expect(req.body.fallbacks).toBe("default");
    expect(req.headers.get("anthropic-beta")).toMatch(/server-side-fallback-2026-07-01/);
    expect((req.body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(req.body).not.toHaveProperty("tool_choice");
    const content = (req.body.messages as { content: { type: string; source?: { media_type: string; data: string } }[] }[])[0]!.content;
    expect(content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf", data: PDF.toString("base64") } });
  });

  it("routes refusals, truncation and non-JSON output to review instead of guessing", async () => {
    const refusal = await provider(() => stream(sse("", "refusal"))).p.extract(PDF);
    expect(refusal).toMatchObject({ kind: "incomplete", reason: expect.stringMatching(/declined/) });
    const cut = await provider(() => stream(sse('{"document_type": "inv', "max_tokens"))).p.extract(PDF);
    expect(cut).toMatchObject({ kind: "incomplete", reason: expect.stringMatching(/cut off/) });
    const prose = await provider(() => stream(sse("Sure! Here is the invoice."))).p.extract(PDF);
    expect(prose).toMatchObject({ kind: "incomplete", reason: expect.stringMatching(/not valid JSON/) });
  });

  it("maps rate limits and server errors to retryable errors, and bad requests to permanent ones", async () => {
    const err = (status: number) => () => new Response(JSON.stringify({ type: "error", error: { type: "x", message: `status ${status}` } }), { status, headers: { "content-type": "application/json" } });
    await expect(provider(err(429)).p.extract(PDF)).rejects.toBeInstanceOf(ExtractionTransientError);
    await expect(provider(err(529)).p.extract(PDF)).rejects.toBeInstanceOf(ExtractionTransientError);
    await expect(provider(err(500)).p.extract(PDF)).rejects.toBeInstanceOf(ExtractionTransientError);
    const bad = provider(err(400)).p.extract(PDF);
    await expect(bad).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    await expect(provider(err(400)).p.extract(PDF)).rejects.not.toBeInstanceOf(ExtractionTransientError);
  });

  it("omits the fallback parameter for models that do not support it", async () => {
    process.env.EXTRACTION_MODEL = "claude-haiku-5-5";
    resetEnvCache();
    const { p, requests } = provider(() => stream(sse(JSON.stringify(loadFixture("invoice-confident")))));
    await p.extract(PDF);
    expect(requests[0]!.body).not.toHaveProperty("fallbacks");
    process.env.EXTRACTION_MODEL = "claude-sonnet-5-5";
    resetEnvCache();
  });
});
