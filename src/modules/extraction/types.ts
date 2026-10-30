/**
 * An extraction provider reads a PDF and returns the model's raw structured
 * output. The output is untrusted: it is validated and normalised by
 * `normalizeExtraction` before anything is written to invoice fields.
 */
export interface ExtractionProvider {
  /** Stable provider name stored with the result, e.g. "anthropic". */
  readonly name: string;
  configured(): boolean;
  /** Names of missing settings, shown in setup states. */
  missing(): string[];
  extract(pdf: Buffer): Promise<ProviderResult>;
}

export type ProviderResult =
  | { kind: "ok"; model: string; output: unknown; usage?: Record<string, unknown> }
  /** The model declined or its output was cut off. Routed to manual review, never passed. */
  | { kind: "incomplete"; model: string; reason: string; output?: unknown };

/** Transient provider failure (rate limit, 5xx, network). The job will retry. */
export class ExtractionTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionTransientError";
  }
}
