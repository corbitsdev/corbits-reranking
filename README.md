# @corbits/reranking

Cross-encoder reranking over Hugging Face Text Embeddings Inference (TEI), Cohere/Jina and Voyage rerank endpoints, built on `@intx/inference` retries and error classification. A retrieval building block for Corbits and Interchange agents that also works standalone.

## Why @corbits/reranking?

1. **One call for three wire formats.** `rerankDocuments` speaks TEI, Cohere (also Jina) and Voyage. Switching providers is a config change.
2. **Your ids back, sorted.** Providers score by array position. The client maps each score back to your `id` and returns `{ id, score }`, best first.
3. **Interchange retry semantics.** 429s and 5xx are retried under the `@intx/inference` retry policy, and every failure is a `RerankRequestError` carrying a classified `InferenceError`.

## Install

```bash
bun add @corbits/reranking @intx/inference@^0.4.0 @intx/types@^0.4.0
```

Runs on Bun >= 1.2 or Node >= 24.

## Quickstart

This example needs a local TEI reranker:

```bash
docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id BAAI/bge-reranker-base
```

```ts
import { rerankDocuments } from "@corbits/reranking";

const docs = [
  { id: "weather", text: "Rain is expected across the valley tomorrow." },
  { id: "paris", text: "Paris is the capital and largest city of France." },
  { id: "recipe", text: "Whisk the eggs before folding in the flour." },
];

const ranked = await rerankDocuments("What is the capital of France?", docs, {
  baseURL: "http://localhost:8080",
  apiStyle: "tei",
});
console.log(ranked[0]?.id); // paris
```

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents with their own identity and permissions. Corbits packages add the parts an agent product needs around it.

- **Runs in:** any process. That can be the Interchange hub (the server that manages tenants and agents), an agent sidecar (the runtime next to each agent), or a plain script. No hub is needed.
- **Plugs into:** [`@intx/inference`](https://github.com/faremeter/interchange) for retries and error types, and [`@intx/types`](https://github.com/faremeter/interchange).
- **Pairs with:** [`@corbits/embedding`](https://github.com/corbitsdev/corbits-embedding) to turn text into vectors, and [`@corbits/memory`](https://github.com/corbitsdev/corbits-memory) to store and search them.

## Reference

| Export                                                          | Description                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `rerankDocuments(query, docs, config, options?)`                | Scores each doc and returns `{ id, score }`, best first.          |
| `RerankConfigSchema`, `RerankConfig`                            | Schema and type for `config`.                                     |
| `RerankOptions`                                                 | Type for `options`.                                               |
| `rerankAdapterRegistry`                                         | The built-in formats: `tei`, `cohere` and `voyage`.               |
| `createRerankAdapterRegistry(adapters)`                         | Builds a registry with your own formats.                          |
| `RerankRequestError`                                            | Thrown when a request fails.                                      |
| `RerankAdapter`, `RerankRequestBuilder`, `RerankResponseParser` | Types for writing an adapter.                                     |
| `RerankRequestConfig`                                           | Config an adapter's `buildRequest` receives.                      |
| `RerankAdapterRegistry`, `RerankAPIStyle`                       | Types for registries and built-in style names.                    |
| `RerankDoc`, `RerankResult`                                     | Types for docs and results.                                       |
| `RequestDependencies`, `RetryAfterExtractor`                    | Types for `options.deps` and `RerankAdapter.extractRetryAfterMs`. |

### Config

| Field       | Type      | Description                                                                         |
| ----------- | --------- | ----------------------------------------------------------------------------------- |
| `baseURL`   | `string`  | Server root, such as `http://localhost:8080`.                                       |
| `apiStyle`  | `string`  | Wire format: `tei`, `cohere` (also Jina) or `voyage`.                               |
| `model`     | `string?` | Model name. Required by `cohere` (and Jina) and `voyage`. TEI serves its own model. |
| `apiKey`    | `string?` | Sent as a bearer token.                                                             |
| `timeoutMs` | `number?` | Time limit per attempt, so retries can exceed it. Defaults to 30000.                |

### Options

| Field         | Description                                                                     |
| ------------- | ------------------------------------------------------------------------------- |
| `deps`        | `{ fetch, scheduler }`. Defaults to global `fetch` and Interchange's scheduler. |
| `retryPolicy` | Decides when to retry. Defaults to Interchange's policy.                        |
| `registry`    | Wire formats to choose from. Defaults to `rerankAdapterRegistry`.               |
| `signal`      | Cancels the request.                                                            |

### Wire formats

| `apiStyle` | Endpoint     | Request              | Reply                                   |
| ---------- | ------------ | -------------------- | --------------------------------------- |
| `tei`      | `/rerank`    | `{query, texts}`     | `[{index, score}]`                      |
| `cohere`   | `/v2/rerank` | `{query, documents}` | `{results: [{index, relevance_score}]}` |
| `voyage`   | `/v1/rerank` | `{query, documents}` | `{data: [{index, relevance_score}]}`    |

To add your own format, build a registry and pass it as `registry`. This one serves TEI-shaped replies at `/score`:

```ts
import {
  createRerankAdapterRegistry,
  rerankAdapterRegistry,
} from "@corbits/reranking";

const tei = rerankAdapterRegistry.resolve("tei");

const registry = createRerankAdapterRegistry({
  tei,
  house: {
    buildRequest: (query, docs, config) => ({
      url: `${config.baseURL}/score`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, texts: docs.map((doc) => doc.text) }),
    }),
    parseResponse: tei.parseResponse,
  },
});
```

### Errors

- A failed request throws `RerankRequestError`. Its `reason` says what went wrong, and `url` says where. Network errors, timeouts, rate limits and server errors are retried first under the retry policy.
- A bad config throws arktype's `TraversalError` before any request is sent.
- With non-empty `docs`, a missing `model` for `cohere` or `voyage` throws `TraversalError`, and an `apiStyle` the registry does not know throws an `Error` that names it.
- A custom `parseResponse` should throw `ProtocolMismatchError` from `@intx/inference` so the failure becomes a `RerankRequestError`. Anything else it throws is rethrown as is.

An empty `docs` list returns `[]` without a request. To keep search working when the reranker is down, catch the error and keep your original order.

## Using with Interchange

To share your host's retry scheduler, pass it as `options.deps.scheduler` along with `fetch`.

## Upgrading from 0.1

- Install `@intx/inference` and `@intx/types` (^0.4.0) yourself. They are now peer dependencies.
- `ModelRequestError` is renamed to `RerankRequestError`.
- `rerankAdapters` is no longer exported. Use `rerankAdapterRegistry` or `createRerankAdapterRegistry`.
- `runJSONRequest`, `extractRetryAfterMs` and `RunRequestOptions` are no longer exported.
- A missing `model` for Cohere or Voyage now throws `TraversalError` instead of a plain `Error`.
- Config, wire requests and results are unchanged.

## License

[LGPL-2.1-only](https://github.com/corbitsdev/corbits-reranking/blob/main/LICENSE)
