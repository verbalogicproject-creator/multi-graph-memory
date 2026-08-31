/**
 * Gemini embedding provider. OUTSIDE the governance core.
 *
 * Verified against https://ai.google.dev/gemini-api/docs/embeddings on
 * 2026-08-31, immediately before implementation as Ruling 2 requires:
 *
 *   - model `gemini-embedding-2`, stable, latest update April 2026
 *   - input limit 8,192 tokens
 *   - dimensions 128..3072; recommended 768 / 1536 / 3072; default 3072
 *   - truncated dimensions are AUTO-NORMALIZED (unlike gemini-embedding-001,
 *     which required manual normalization) -- so we must NOT re-normalize
 *   - `task_type` is NOT SUPPORTED. The docs are explicit: "You cannot use the
 *     task_type field for the gemini-embedding-2 model." Task intent goes in the
 *     prompt instead
 *   - embedding spaces are incompatible with gemini-embedding-001, so switching
 *     models forces a re-embed
 *
 * The antigravity-memory-os provider this replaces sends `taskType` and `title`
 * to this model at all three call sites, which the docs forbid; that defect is
 * corrected here and upstream.
 *
 * `@google/genai` is an OPTIONAL dependency, imported lazily. Nothing here runs
 * unless a caller constructs this provider, so `npm install --omit=optional`
 * leaves the rest of the package fully functional.
 */

import { refuse } from "../core/errors.ts";
import type { EmbeddingAdapter, EmbeddingRequest, VectorMetadata } from "../relevance/embedding-port.ts";

export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const GEMINI_DOCS_VERIFIED_ON = "2026-08-31";

/** Bump whenever the prefix convention below changes: it changes the space in practice. */
export const PROMPT_FORMAT_VERSION = "gemini2-prefix-v1";

/** Conservative char ceiling for the 8,192-token input limit (~4 chars/token). */
export const MAX_INPUT_CHARS = 30_000;

export type EmbeddingTask = NonNullable<EmbeddingRequest["task"]>;

const TASK_PREFIX: Record<EmbeddingTask, string> = {
  search: "search result",
  "question-answering": "question answering",
  "fact-checking": "fact checking",
  "code-retrieval": "code retrieval",
};

/**
 * The asymmetric retrieval format from the docs. Queries carry a task prefix;
 * documents carry title/text. Getting this wrong degrades recall silently, which
 * is exactly what the old `taskType` path was doing.
 */
export function formatForEmbedding(request: EmbeddingRequest): string {
  const text = request.text.length > MAX_INPUT_CHARS ? request.text.slice(0, MAX_INPUT_CHARS) : request.text;

  if (request.role === "query") {
    return `task: ${TASK_PREFIX[request.task ?? "search"]} | query: ${text}`;
  }
  return `title: ${request.title?.trim() || "none"} | text: ${text}`;
}

export interface GeminiEmbeddingOptions {
  apiKey?: string;
  model?: string;
  /** 768 is the default here: recommended by the docs and cheap on-device. */
  dimensions?: number;
}

interface GenAIClient {
  models: {
    embedContent(args: {
      model: string;
      contents: string;
      config?: { outputDimensionality?: number };
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

export class GeminiEmbeddingProvider implements EmbeddingAdapter {
  readonly metadata: VectorMetadata;
  private readonly apiKey: string;
  private client: GenAIClient | null = null;

  constructor(options: GeminiEmbeddingOptions = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      refuse("VALIDATION_FAILED", "GEMINI_API_KEY is required to construct the Gemini embedding provider.", {});
    }
    this.apiKey = apiKey;
    this.metadata = {
      modelId: options.model ?? GEMINI_EMBEDDING_MODEL,
      dimensions: options.dimensions ?? 768,
      promptFormatVersion: PROMPT_FORMAT_VERSION,
    };
  }

  private async ensureClient(): Promise<GenAIClient> {
    if (this.client) return this.client;
    let module: { GoogleGenAI: new (options: { apiKey: string }) => GenAIClient };
    try {
      module = (await import("@google/genai")) as never;
    } catch {
      refuse(
        "VALIDATION_FAILED",
        "@google/genai is an optional dependency and is not installed. Install it to use the Gemini provider, or use the deterministic relevance adapter.",
        {},
      );
    }
    this.client = new module.GoogleGenAI({ apiKey: this.apiKey });
    return this.client;
  }

  /**
   * Callers must go through `guardedEmbed`, which runs the redaction gate first.
   * This method performs no gating of its own by design: one gate, one place.
   */
  async embed(request: EmbeddingRequest): Promise<Float32Array> {
    const client = await this.ensureClient();
    const contents = formatForEmbedding(request);

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await client.models.embedContent({
          model: this.metadata.modelId,
          contents,
          // No taskType and no title: unsupported on gemini-embedding-2.
          config: { outputDimensionality: this.metadata.dimensions },
        });

        const values = response.embeddings?.[0]?.values;
        if (!values || values.length === 0) throw new Error("Provider returned an empty embedding vector.");
        // Truncated dimensions arrive already normalized; do not re-normalize.
        return Float32Array.from(values);
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    }

    refuse("VALIDATION_FAILED", `Gemini embedding failed after 3 attempts: ${String(lastError)}`, {
      model: this.metadata.modelId,
    });
  }
}
