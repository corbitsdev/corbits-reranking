import { type } from "arktype";
import type { RetryPolicy } from "@intx/types/runtime";

import {
  rerankAdapterRegistry,
  type RerankAdapterRegistry,
  type RerankAPIStyle,
  type RerankDoc,
  type RerankResult,
} from "./adapters";
import { runJSONRequest, type RequestDependencies } from "./request";

export const RerankConfigSchema = type({
  /** Provider root, e.g. `http://localhost:8085` for a TEI server. */
  baseURL: "string",
  /**
   * A key into the registry. Left open rather than pinned to
   * {@link RerankAPIStyle} so a custom registry can name a house format; the
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
  deps: RequestDependencies;
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
  options: RerankOptions,
): Promise<RerankResult[]> {
  if (docs.length === 0) return [];

  const registry = options.registry ?? rerankAdapterRegistry;
  const adapter = registry.resolve(config.apiStyle);
  const request = adapter.buildRequest(query, docs, {
    baseURL: config.baseURL,
    model: config.model,
    apiKey: config.apiKey,
  });

  const body = await runJSONRequest(request, {
    deps: options.deps,
    ...(options.retryPolicy !== undefined
      ? { retryPolicy: options.retryPolicy }
      : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(adapter.extractRetryAfterMs !== undefined
      ? { extractRetryAfterMs: adapter.extractRetryAfterMs }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return adapter
    .parseResponse(body)
    .map(({ index, score }) => {
      const doc = docs[index];
      if (doc === undefined) {
        throw new Error(
          `${request.url}: rerank response index ${index} out of bounds for ${docs.length} documents`,
        );
      }
      return { id: doc.id, score };
    })
    .sort((a, b) => b.score - a.score);
}

export type { RerankAPIStyle, RerankDoc, RerankResult };
