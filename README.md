# @corbits/reranking

Cross-encoder rerank client. Given a query and a candidate set, `rerankDocuments`
posts them to a reranker, maps the reply back to your own document ids, and
returns `{id, score}` sorted descending.

Unlike embeddings, reranking has **no OpenAI-compatible standard** and is not
converging on one — TEI does not serve an OpenAI-shaped rerank route at all
([text-embeddings-inference#683](https://github.com/huggingface/text-embeddings-inference/issues/683)).
So this is a real adapter boundary, not a knob:

| `apiStyle` | endpoint     | request              | response                                |
| ---------- | ------------ | -------------------- | --------------------------------------- |
| `tei`      | `/rerank`    | `{query, texts}`     | `[{index, score}]`                      |
| `cohere`   | `/v2/rerank` | `{query, documents}` | `{results: [{index, relevance_score}]}` |
| `voyage`   | `/v1/rerank` | `{query, documents}` | `{data: [{index, relevance_score}]}`    |

Jina's `/rerank` uses Cohere's shape and is served by the `cohere` adapter.

Transport, error classification and retry come from `@intx/inference` rather
than being reimplemented: requests are `BuiltRequest`s sent through the single
`deps.fetch` path, failures become an `InferenceError` through the same
classifiers a chat call uses, and `createDefaultRetryPolicy` decides whether to
back off or abort.

`RerankAdapter` deliberately mirrors inference's `ProviderAdapter` — same
`buildRequest` / `parseResponse` members, same optional `extractRetryAfterMs`
for a provider that signals pacing its own way. Styles resolve through
`createRerankAdapterRegistry`, which closes over a private `Map` copy so an
`apiStyle` arriving from config or an environment variable cannot reach an
inherited member of `Object.prototype` and fail later as an opaque `TypeError`.
Pass your own `registry` to add a house format without forking the package.

```ts
import { createDefaultScheduler } from "@intx/inference";
import { rerankDocuments } from "@corbits/reranking";

// Only `fetch` and `scheduler` are needed — a full harness `Dependencies`
// also satisfies this if you already have one.
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
```

## Scores are mapped by index, never by position

Every one of these protocols addresses documents by their position in the
_request_ array, and TEI's reply is explicitly unordered. Results are therefore
mapped back through `docs[index]`, and an out-of-range index raises rather than
silently attaching a score to the wrong document.

`RerankDoc.id` exists for this reason: the wire formats only speak in array
offsets, so translating back to a stable identifier is this package's job rather
than the caller's.

## Degrading soft is the caller's decision

This package raises on failure. It does not swallow errors, because a reranker
outage should be a policy decision at the call site — a retrieval pipeline
typically wants to fall back to its fused ordering and carry on, which it cannot
do if the failure is hidden here.

## Errors

Every failure — transport, HTTP status, or a 200 whose body is not JSON —
raises `ModelRequestError`, carrying the classified `InferenceError` as `reason`
and the URL.

Note that `@corbits/embedding` and `@corbits/reranking` each carry their own
copy of this class until the shared transport is upstreamed, so `instanceof`
does not hold across the two. Catching both? Discriminate on
`error.name === "ModelRequestError"`.

## Versioning

Semver. Released manually with `bun run build && npm publish` once CI is green.

## Development

```bash
bun install
bun test ./src
bunx tsc --noEmit
```

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
