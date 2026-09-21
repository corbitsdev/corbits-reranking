# @corbits/reranking

Cross-encoder rerank client. Given a query and a candidate set,
`rerankDocuments` posts them to a reranker, maps the reply back to your own
document ids, and returns `{id, score}` sorted descending.

Unlike embeddings, reranking has no OpenAI-compatible standard — TEI does
not serve an OpenAI-shaped rerank route at all — so this is a real adapter
boundary, not a knob.

## Runtime support

Bun >= 1.2 is the development runtime. Node >= 24 consumes built `dist/`;
native Node does not load this package's TypeScript source.

## Quickstart

```bash
npm add @corbits/reranking
pnpm add @corbits/reranking
yarn add @corbits/reranking
bun add @corbits/reranking
```

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
```

```ts
import { createDefaultScheduler } from "@intx/inference";
import { rerankDocuments } from "@corbits/reranking";

const deps = { fetch, scheduler: createDefaultScheduler() };

const ranked = await rerankDocuments(
  "how do I deploy to staging?",
  [
    { id: "doc-1", text: "Staging deploys run from main." },
    { id: "doc-2", text: "On-call rotation is weekly." },
    { id: "doc-3", text: "The billing export lives in finance." },
  ],
  {
    baseURL: "https://api.cohere.com",
    apiStyle: "cohere", // also Jina's /rerank; TEI: "tei"; Voyage: "voyage"
    model: "rerank-v3.5",
    apiKey: process.env.COHERE_API_KEY,
  },
  { deps },
);

for (const { id, score } of ranked) {
  console.log(id, score);
}
```

Empty input short-circuits without a request. Failures raise
`ModelRequestError` (transport, HTTP status, or a 200 whose body is not
JSON). `@corbits/embedding` and `@corbits/reranking` each carry their own
copy of this class, so `instanceof` does not hold across the two — catch on
`error.name === "ModelRequestError"`. This package does not swallow errors:
a reranker outage is a policy decision at the call site.

## How it works

Built-in `apiStyle` values:

| `apiStyle` | endpoint     | request              | response                                |
| ---------- | ------------ | -------------------- | --------------------------------------- |
| `tei`      | `/rerank`    | `{query, texts}`     | `[{index, score}]`                      |
| `cohere`   | `/v2/rerank` | `{query, documents}` | `{results: [{index, relevance_score}]}` |
| `voyage`   | `/v1/rerank` | `{query, documents}` | `{data: [{index, relevance_score}]}`    |

Every protocol addresses documents by their position in the request array,
and TEI's reply is explicitly unordered. Results are mapped back through
`docs[index]`; an out-of-range index raises rather than attaching a score to
the wrong document. `RerankDoc.id` exists because the wire formats only
speak in array offsets.

Styles resolve through `createRerankAdapterRegistry`, which closes over a
private `Map` copy so an `apiStyle` from config cannot hit
`Object.prototype`. Pass your own `registry` to add a house format without
forking the package. `RerankAdapter` mirrors inference's `ProviderAdapter`
(`buildRequest` / `parseResponse`, optional `extractRetryAfterMs`).

Transport, classification, and retry come from `@intx/inference` — the same
`deps.fetch` path and `createDefaultRetryPolicy` a chat call uses.

## Development

```bash
git clone https://github.com/corbitsdev/corbits-reranking.git
cd corbits-reranking
bun install
bun run build      # tsc -p tsconfig.build.json
bun run test       # bun test ./src
bun run typecheck  # tsc --noEmit
```

## License

LGPL-2.1-only — see [`LICENSE`](LICENSE).
