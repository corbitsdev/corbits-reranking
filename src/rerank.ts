import { type } from "arktype";
import {
  classifyProtocolMismatch,
  createDefaultRetryPolicy,
  createDefaultScheduler,
  ProtocolMismatchError,
} from "@intx/inference";
import type { RetryPolicy } from "@intx/types/runtime";

import {
  rerankAdapterRegistry,
  type RerankAdapterRegistry,
  type RerankDoc,
  type RerankResult,
} from "./adapters.js";
import {
  extractRetryAfterMs,
  RerankRequestError,
  runJSONRequest,
  type RequestDependencies,
} from "./request.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export const RerankConfigSchema = type({
  /** Provider root, e.g. `http://localhost:8080` for a TEI server. */
  baseURL: "string",
  /**
   * A key into the registry. Left open rather than pinned to
   * `RerankAPIStyle` so a custom registry can name a house format; the
   * registry rejects an unknown style by name. The built-ins are `tei`,
   * `cohere` (also Jina) and `voyage`.
   */
  apiStyle: "string",
  /** Required by Cohere and Voyage; TEI serves whatever model it was started with. */
  "model?": "string",
  "apiKey?": "string",
  "timeoutMs?": "number > 0",
});
export type RerankConfig = typeof RerankConfigSchema.infer;

export type RerankOptions = {
  /** Defaults to global `fetch` and `createDefaultScheduler()`. */
  deps?: RequestDependencies;
  retryPolicy?: RetryPolicy;
  /** Defaults to the built-in registry: TEI, Cohere/Jina and Voyage. */
  registry?: RerankAdapterRegistry;
  signal?: AbortSignal;
};

/**
 * Rerank a candidate set, returning `{id, score}` sorted descending.
 *
 * Empty input short-circuits without a request. Every protocol addresses
 * documents by their position in the request array and TEI's reply is
 * explicitly unordered, so results are mapped back through `docs[index]` rather
 * than by reply position.
 */
export async function rerankDocuments(
  query: string,
  docs: readonly RerankDoc[],
  config: RerankConfig,
  options: RerankOptions = {},
): Promise<RerankResult[]> {
  const parsed = RerankConfigSchema.assert(config);

  if (docs.length === 0) return [];

  const registry = options.registry ?? rerankAdapterRegistry;
  const adapter = registry.resolve(parsed.apiStyle);
  const request = adapter.buildRequest(query, docs, {
    baseURL: parsed.baseURL,
    model: parsed.model,
    apiKey: parsed.apiKey,
  });

  const body = await runJSONRequest(request, {
    deps: options.deps ?? {
      fetch: globalThis.fetch,
      scheduler: createDefaultScheduler(),
    },
    retryPolicy: options.retryPolicy ?? createDefaultRetryPolicy(),
    timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    extractRetryAfterMs: adapter.extractRetryAfterMs ?? extractRetryAfterMs,
    signal: options.signal,
  });

  let scored: { index: number; score: number }[];
  try {
    scored = adapter.parseResponse(body);
  } catch (cause) {
    if (!(cause instanceof ProtocolMismatchError)) throw cause;
    throw new RerankRequestError(
      classifyProtocolMismatch(cause.message, cause.raw),
      request.url,
    );
  }

  return scored
    .map(({ index, score }) => {
      const doc = docs[index];
      if (doc === undefined) {
        throw new RerankRequestError(
          classifyProtocolMismatch(
            `rerank response index ${index} out of bounds for ${docs.length} documents`,
            body,
          ),
          request.url,
        );
      }
      return { id: doc.id, score };
    })
    .sort((a, b) => b.score - a.score);
}
