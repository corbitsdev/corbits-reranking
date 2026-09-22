# @corbits/reranking

Cross-encoder reranking for retrieval pipelines. Send a query plus candidates, get scored ids back in ranked order.

Give `rerankDocuments` a query and your own `{id, text}` docs; it posts them to the reranker, maps the reply back to your ids, and returns `{id, score}` sorted descending.

## Runtime support

Runs on Bun >= 1.2 or Node >= 24. The built `dist/` entry is the default import.

## Quickstart

```bash
bun add @corbits/reranking
```

`rerankDocuments(query, docs, config, options)` validates config with `RerankConfigSchema`, short-circuits empty input with no request, and returns ranked results. Options carry `deps`, with optional `retryPolicy`, `registry`, and `signal`. Config takes `baseURL` and `apiStyle`, with optional `model` (used by Cohere and Voyage), `apiKey`, and `timeoutMs`.

```ts
import { createDefaultScheduler } from "@intx/inference";
import { rerankDocuments } from "@corbits/reranking";

const deps = { fetch, scheduler: createDefaultScheduler() };

const ranked = await rerankDocuments(
  "how do I deploy to staging?",
  [
    { id: "doc-1", text: "Staging deploys run from main…" },
    { id: "doc-2", text: "On-call rotation is weekly…" },
  ],
  { baseURL: "http://localhost:8085", apiStyle: "tei" },
  { deps },
);
console.log(ranked);
```

## How it works

Reranking has no single OpenAI-style standard, so this package draws the adapter boundary explicitly:

| `apiStyle` | Endpoint     | Request shape        | Response shape                          |
| ---------- | ------------ | -------------------- | --------------------------------------- |
| `tei`      | `/rerank`    | `{query, texts}`     | `[{index, score}]`                      |
| `cohere`   | `/v2/rerank` | `{query, documents}` | `{results: [{index, relevance_score}]}` |
| `voyage`   | `/v1/rerank` | `{query, documents}` | `{data: [{index, relevance_score}]}`    |

Jina's `/rerank` follows the Cohere shape and is served by the `cohere` adapter.

`RerankAdapter` mirrors inference's `ProviderAdapter` with `buildRequest` / `parseResponse` plus optional `extractRetryAfterMs`. Styles resolve through `createRerankAdapterRegistry`, which keeps a private `Map` copy so config-supplied style names resolve safely. Pass a custom `registry` to add a house format alongside the built-ins (`rerankAdapters`, `rerankAdapterRegistry`).

Every protocol addresses documents by position in the request array, and TEI replies unordered. Results map back through `docs[index]`, with an out-of-range index raising so a score always lands on the right document. `RerankDoc.id` carries your stable identifier across that index-based wire, and the final list sorts by score descending.

This package raises on failure, leaving fallback policy at the call site. Retrieval pipelines commonly fall back to their fused ordering when the reranker is unavailable and carry on serving.

Every failure mode — transport, HTTP status, or a 200 with an unexpected body — raises `ModelRequestError`, carrying the classified `InferenceError` as `reason` plus the request URL. Transport, classification, and retry come from `@intx/inference`: built requests travel the shared `deps.fetch` path with `createDefaultRetryPolicy` guiding backoff. The embedding and reranking packages each carry their own copy of this class while the shared transport is upstreamed, so code catching both discriminates on `error.name === "ModelRequestError"`.

Transport helpers (`runJSONRequest`, `extractRetryAfterMs`, `ModelRequestError`, `RunRequestOptions`, `RetryAfterExtractor`) are also re-exported for sibling one-shot JSON clients.

Interchange retrieval pipelines call `rerankDocuments` after hybrid search to lift the strongest candidates to the top. The shared `@intx/inference` transport keeps rerank retries and error taxonomy consistent with chat and embeddings across the hub.

## Development

```bash
bun install
bun test ./src
bunx tsc --noEmit
```

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
