# @corbits/reranking — Implementation

Package: `@corbits/reranking` `0.1.0`. License: LGPL-2.1-only.

## Runtime

- **Bun >= 1.2.0** — development runtime (`bun test`, `bun run build`).
- **Node >= 24** — consumes built `dist/`. Native Node does not load this
  package's TypeScript source.
- **TypeScript 5.9.3**, ES modules. Default export is `dist/index.js` with
  types from `dist/index.d.ts`. The `intx-src` export condition points at
  `src/index.ts` for source-linked Interchange workspaces.

## Dependencies

| Package | Version | Role |
| ------- | ------- | ---- |
| `@intx/inference` | ^0.3.0 | `createDefaultScheduler`, `BuiltRequest`, classifiers, `createDefaultRetryPolicy` |
| `@intx/types` | ^0.3.0 | `RetryPolicy`, `InferenceError` |
| `@intx/log` | ^0.3.0 | Harness logging peer |
| `arktype` | ^2.1.29 | `RerankConfigSchema` and per-style response shapes |

Dev: `@intx/inference-testing` 0.3.0, `@types/bun` 1.3.9, `prettier` 3.6.2.

## Public surface (`src/index.ts`)

`rerankDocuments`, `RerankConfigSchema`, `createRerankAdapterRegistry`,
`rerankAdapterRegistry`, `rerankAdapters`, `runJSONRequest`,
`extractRetryAfterMs`, `ModelRequestError`, and the associated types
(`RerankDoc`, `RerankResult`, `RerankAdapter`, `RerankAPIStyle`, …).

## Quickstart

Matches the README. Registry install, then `rerankDocuments`:

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

`deps` is `{ fetch, scheduler }`. A full harness `Dependencies` object also
satisfies this.

## Config (`RerankConfigSchema`)

| Field | Rule |
| ----- | ---- |
| `baseURL` | string (provider root, no path suffix beyond what the adapter appends) |
| `apiStyle` | string key into the registry (`tei`, `cohere`, `voyage`, or a custom name) |
| `model` | optional; required at request-build time for Cohere and Voyage |
| `apiKey` | optional; sent as `Authorization: Bearer …` when set |
| `timeoutMs` | optional, `number > 0`; default per-attempt ceiling is 30s |

`RerankOptions`: required `deps`; optional `retryPolicy`, `registry`, `signal`.

## Built-in wire formats

| `apiStyle` | endpoint | request | response |
| ---------- | -------- | ------- | -------- |
| `tei` | `/rerank` | `{query, texts}` | `[{index, score}]` |
| `cohere` | `/v2/rerank` | `{query, documents}` plus `model` | `{results: [{index, relevance_score}]}` |
| `voyage` | `/v1/rerank` | `{query, documents}` plus `model` | `{data: [{index, relevance_score}]}` |

Jina's `/rerank` uses Cohere's shape and is served by the `cohere` adapter.

## Errors

Every transport, HTTP-status, or 200-non-JSON failure raises
`ModelRequestError` (`error.name === "ModelRequestError"`), with classified
`reason` (`InferenceError`) and `url`.

`@corbits/embedding` and `@corbits/reranking` each carry their own copy of this
class until the shared transport is upstreamed in `@intx/inference`. `instanceof`
does not hold across the two — catch on `error.name`.

`runJSONRequest` in `src/request.ts` is duplicated (modulo comments) with the
embedding package. Fix both copies or neither.

## Layout

```
src/
  index.ts       barrel
  rerank.ts      rerankDocuments + RerankConfigSchema
  adapters.ts    TEI / Cohere / Voyage + createRerankAdapterRegistry
  request.ts     runJSONRequest, ModelRequestError, extractRetryAfterMs
  rerank.test.ts bun:test
```

## Development

```bash
git clone https://github.com/corbitsdev/corbits-reranking.git
cd corbits-reranking
bun install
bun run build      # tsc -p tsconfig.build.json
bun run test       # bun test ./src
bun run typecheck  # tsc --noEmit
```

Publish is `bun run build && npm publish` (`publishConfig.access: public`).
The npm tarball includes `dist`, `README.md`, and `LICENSE` — not these P/A/I
docs.
