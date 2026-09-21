# @corbits/reranking — Architecture

## Overview

The package is a one-shot JSON client, not a streaming inference turn. A caller
hands `rerankDocuments` a query, a candidate list, a style-addressed config, and
transport dependencies. An adapter builds the provider request and parses the
reply into positions; the client maps those positions back onto caller ids and
sorts by score descending.

## Components

| Component | Role |
| --------- | ---- |
| `rerankDocuments` | Public orchestration: validate config, short-circuit empty input, resolve an adapter, send, map, sort. |
| `RerankAdapter` | One wire format: `buildRequest` / `parseResponse`, optional `extractRetryAfterMs`. Mirrors the inference harness `ProviderAdapter` so the two read as the same kind of object. |
| Adapter registry | Maps `apiStyle` strings to adapters. Built-ins cover TEI, Cohere (also Jina's `/rerank`), and Voyage. |
| JSON request runner | Single POST of a built request: classify failures, retry or abort, return a JSON body. |

Callers inject `deps` (`fetch` and a scheduler). A full harness dependency bag
satisfies this structurally; assembling an inference-provider registry is not
required to rerank.

## Control flow

```
query + docs + config + deps
        │
        ▼
  validate config
        │
        ├── docs.length === 0 → []
        │
        ▼
  registry.resolve(apiStyle)
        │
        ▼
  adapter.buildRequest(query, docs, { baseURL, model, apiKey })
        │
        ▼
  JSON POST (classify + retry)
        │
        ▼
  adapter.parseResponse(body) → [{ index, score }]
        │
        ▼
  map through docs[index] → { id, score }
        │
        ▼
  sort score descending
```

## Adapter registry

Reranking is a real adapter boundary, not a knob: the built-in styles disagree
on path, request field names, and where scores live in the reply.

`createRerankAdapterRegistry` closes over a private `Map` copy of the style →
adapter table. Lookups never consult `Object.prototype`, so an `apiStyle` from
config cannot resolve to an inherited function and fail later as an opaque
`TypeError`. Unknown styles fail immediately, by name.

Pass `options.registry` to add a house format without forking the package.
`apiStyle` is an open string for that reason; the registry, not a closed enum,
is the source of truth for what is legal.

Parsers are pure (no per-request state), so a shared adapter instance is safe.
`parseResponse` returns positions into the `docs` array it was given; id mapping
and bounds checks live in one place (`rerankDocuments`), not in each adapter.

## Index mapping

Every built-in protocol addresses documents by their position in the *request*
array. TEI's reply is explicitly unordered. Results are therefore mapped through
`docs[index]`. An out-of-range index raises rather than attaching a score to the
wrong document.

`RerankDoc.id` exists because the wire formats only speak in array offsets.
Translating back to a stable identifier is this package's job, not the
caller's.

## Failure modes

| Condition | Behavior |
| --------- | -------- |
| Empty `docs` | Return `[]`; no request. |
| Invalid config | Throw a validation error; no request. |
| Unknown `apiStyle` | Throw naming the known styles. |
| Adapter-required `model` missing (Cohere, Voyage) | Throw before the request. TEI serves whatever model it was started with. |
| Reply index out of range | Throw; do not invent a document. |
| Transport, HTTP error, or 200 with a non-JSON body | Raise a request error carrying the classified reason and URL. Never swallowed. |

Retry and classification are the same policy a chat call uses: retryables back
off; credential failures abort. A reranker outage is visible so the call site
can fall back to its fused ordering.

## Boundaries

- **This package owns:** style adapters, index→id mapping, config validation,
  one-shot JSON transport wrapping the harness classifiers.
- **The harness owns:** `fetch`, scheduling, retry policy, error taxonomy.
- **The caller owns:** candidate selection, document ids, fallback when ranking
  fails, which `apiStyle` and endpoint to use.
- **Not this package:** embedding generation, retrieval fusion, OpenAI-shaped
  rerank (there isn't one).
