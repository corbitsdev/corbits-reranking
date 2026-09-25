# @corbits/reranking

Cross-encoder reranking for retrieval pipelines. Send a query plus candidates, get scored ids back in ranked order.

Give `rerankDocuments` a query and your own `{id, text}` docs; it posts them to the reranker, maps the reply back to your ids, and returns `{id, score}` sorted descending.

## Quickstart

```bash
bun add @corbits/reranking
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

console.log(ranked);
// [{ id: "paris", score: 0.99 }, { id: "weather", score: 0.01 }, ...]
```

Config takes `baseURL` and `apiStyle`, with optional `model` (required by Cohere and Voyage), `apiKey`, and `timeoutMs`. The optional fourth argument takes `deps` (defaults to global `fetch` and `createDefaultScheduler()`), `retryPolicy`, `registry`, and `signal`.

## How it works

| `apiStyle` | Endpoint     | Request shape        | Response shape                          |
| ---------- | ------------ | -------------------- | --------------------------------------- |
| `tei`      | `/rerank`    | `{query, texts}`     | `[{index, score}]`                      |
| `cohere`   | `/v2/rerank` | `{query, documents}` | `{results: [{index, relevance_score}]}` |
| `voyage`   | `/v1/rerank` | `{query, documents}` | `{data: [{index, relevance_score}]}`    |

Jina's `/rerank` follows the Cohere shape and is served by the `cohere` adapter.

To add a house format, such as a TEI-shaped reply served at `/score`, build a registry with `createRerankAdapterRegistry` and pass it as `registry`:

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

Providers reply with positions into the request array, so each score maps back to your `id` through that index.

## Errors

Failures throw `RerankRequestError` (`extends Error`), carrying the classified `InferenceError` from `@intx/inference` as `reason` and the request `url`. That covers transport failures, HTTP errors, and replies in the wrong shape; retryable errors are retried first under the `retryPolicy` option, which defaults to `createDefaultRetryPolicy()`. An invalid config throws arktype's `TraversalError` before any request is sent, as does a missing `model` for Cohere or Voyage once `docs` is non-empty (an empty `docs` returns `[]` without building a request); an `apiStyle` the registry does not know throws a plain `Error` naming it.

Fallback is left to the caller: catch the error and keep your own ordering if a reranker outage should not fail search.

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
