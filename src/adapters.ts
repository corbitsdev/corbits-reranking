import { type } from "arktype";
import { ProtocolMismatchError, type BuiltRequest } from "@intx/inference";

import type { RetryAfterExtractor } from "./request.js";

/**
 * A document offered to the reranker. `id` is the caller's own handle — the
 * wire protocols address documents by array index, and mapping back to a
 * stable id is this package's job, not the caller's.
 */
export type RerankDoc = {
  id: string;
  text: string;
};

export type RerankResult = {
  id: string;
  score: number;
};

export type RerankRequestConfig = {
  baseURL: string;
  model?: string | undefined;
  apiKey?: string | undefined;
};

export type RerankRequestBuilder = (
  query: string,
  docs: readonly RerankDoc[],
  config: RerankRequestConfig,
) => BuiltRequest;

/**
 * Positions into the `docs` array the request was built from. Throws
 * `ProtocolMismatchError` on a reply it cannot read, per the
 * `@intx/inference` `ResponseParser` contract.
 */
export type RerankResponseParser = (
  body: unknown,
) => Array<{ index: number; score: number }>;

/**
 * One rerank wire format: how to build the request and how to read the reply.
 *
 * Unlike embeddings, reranking has no OpenAI-compatible standard and is not
 * converging on one — TEI does not serve an OpenAI-shaped rerank route at all
 * (huggingface/text-embeddings-inference#683). The formats below are genuinely
 * different, so this is a real adapter boundary rather than a knob.
 *
 * Member names and the optional `extractRetryAfterMs` mirror
 * `@intx/inference`'s `ProviderAdapter`, so the two read as the same kind of
 * object.
 *
 * `parseResponse` returns positions into the `docs` array it was given; the
 * caller maps those back to ids, so an out-of-range index is caught in one
 * place instead of in each adapter.
 */
export type RerankAdapter = {
  buildRequest: RerankRequestBuilder;
  parseResponse: RerankResponseParser;
  extractRetryAfterMs?: RetryAfterExtractor;
};

export type RerankAPIStyle = "tei" | "cohere" | "voyage";

function headers(config: RerankRequestConfig): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey !== undefined) {
    out.authorization = `Bearer ${config.apiKey}`;
  }
  return out;
}

function invalid(style: RerankAPIStyle, body: unknown, summary: string): never {
  throw new ProtocolMismatchError(
    `malformed ${style} rerank response — ${summary}`,
    body,
  );
}

/**
 * Cohere and Voyage both reject a request without a model. `model` is optional
 * on the config because TEI serves whatever it was started with, so the
 * requirement is enforced per adapter rather than as a 400 discovered in
 * production.
 */
const WithModel = type({ model: "string" });

/** TEI: `{query, texts}` -> a bare array of `{index, score}`, unordered. */
const TeiResponse = type({ index: "number", score: "number" }).array();

const tei: RerankAdapter = {
  buildRequest: (query, docs, config) => ({
    url: `${config.baseURL}/rerank`,
    headers: headers(config),
    body: JSON.stringify({ query, texts: docs.map((doc) => doc.text) }),
  }),
  parseResponse: (body) => {
    const parsed = TeiResponse(body);
    if (parsed instanceof type.errors) invalid("tei", body, parsed.summary);
    return [...parsed];
  },
};

/**
 * Cohere v2: `{model, query, documents}` -> `{results: [{index,
 * relevance_score}]}`. Jina's `/rerank` uses the same shape, so it is served by
 * this adapter.
 */
const CohereResponse = type({
  results: type({ index: "number", relevance_score: "number" }).array(),
});

const cohere: RerankAdapter = {
  buildRequest: (query, docs, config) => ({
    url: `${config.baseURL}/v2/rerank`,
    headers: headers(config),
    body: JSON.stringify({
      model: WithModel.assert(config).model,
      query,
      documents: docs.map((doc) => doc.text),
    }),
  }),
  parseResponse: (body) => {
    const parsed = CohereResponse(body);
    if (parsed instanceof type.errors) invalid("cohere", body, parsed.summary);
    return parsed.results.map((r) => ({
      index: r.index,
      score: r.relevance_score,
    }));
  },
};

/** Voyage: `{model, query, documents}` -> `{data: [{index, relevance_score}]}`. */
const VoyageResponse = type({
  data: type({ index: "number", relevance_score: "number" }).array(),
});

const voyage: RerankAdapter = {
  buildRequest: (query, docs, config) => ({
    url: `${config.baseURL}/v1/rerank`,
    headers: headers(config),
    body: JSON.stringify({
      model: WithModel.assert(config).model,
      query,
      documents: docs.map((doc) => doc.text),
    }),
  }),
  parseResponse: (body) => {
    const parsed = VoyageResponse(body);
    if (parsed instanceof type.errors) invalid("voyage", body, parsed.summary);
    return parsed.data.map((r) => ({
      index: r.index,
      score: r.relevance_score,
    }));
  },
};

export type RerankAdapterRegistry = {
  has(apiStyle: string): boolean;
  resolve(apiStyle: string): RerankAdapter;
};

/**
 * Builds a registry from a map of API style to adapter, mirroring
 * `@intx/inference`'s `createAdapterRegistry`.
 *
 * The registry closes over a private `Map` copy, so callers cannot mutate the
 * set after construction and a lookup never consults `Object.prototype`. The
 * `apiStyle` is a plain string — a custom registry may name any format — so a
 * bare object lookup for `"toString"` would resolve to an inherited function
 * and fail later as an opaque `TypeError`. This fails immediately and by name.
 *
 * Unlike upstream this maps to adapters rather than factories. Upstream
 * resolves a factory per call because its response parsers hold per-request
 * state; these parsers are pure, so a shared instance is safe.
 */
export function createRerankAdapterRegistry(
  adapters: Readonly<Record<string, RerankAdapter>>,
): RerankAdapterRegistry {
  const byStyle = new Map(Object.entries(adapters));
  return {
    has: (apiStyle) => byStyle.has(apiStyle),
    resolve: (apiStyle) => {
      const adapter = byStyle.get(apiStyle);
      if (adapter === undefined) {
        throw new Error(
          `Unknown rerank API style "${apiStyle}" — expected one of ${[...byStyle.keys()].join(", ")}`,
        );
      }
      return adapter;
    },
  };
}

export const rerankAdapters: Readonly<Record<RerankAPIStyle, RerankAdapter>> = {
  tei,
  cohere,
  voyage,
};

/** The built-in registry covering TEI, Cohere/Jina and Voyage. */
export const rerankAdapterRegistry: RerankAdapterRegistry =
  createRerankAdapterRegistry(rerankAdapters);
