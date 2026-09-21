# @corbits/reranking — Product

## What it is

A cross-encoder rerank client published as `@corbits/reranking`. Given a query
and a candidate set, callers get `{id, score}` rows sorted descending — better
answers from the same retrieval, without rewriting the pipeline per provider.

The public entry is `rerankDocuments`.

## Why it exists

Retrieval already produced a candidate list. Reranking is the step that scores
those candidates against the query so the best evidence surfaces first.

Unlike embeddings, reranking has no OpenAI-compatible standard — TEI does not
serve an OpenAI-shaped rerank route at all — so teams otherwise fork a client
per vendor. This package is that adapter boundary: one call, caller-owned
document ids, provider chosen at config time.

## Who it's for

Authors of retrieval, RAG, and search pipelines who already have documents with
stable ids and need a reranker to order them. Not an embedding client, not a
ranker that invents ids, not a policy layer that decides what to do when the
reranker is down.

## What users can do

- Install from the registry (`npm` / `pnpm` / `yarn` / `bun` add
  `@corbits/reranking`) and call `rerankDocuments` with a query, `{id, text}`
  documents, a config (`baseURL`, `apiStyle`, optional `model` / `apiKey`), and
  harness `deps`.
- Rank against a local TEI server or a hosted Cohere, Jina (`cohere` style), or
  Voyage reranker without changing the call shape.
- Keep their own document ids: the result is `{id, score}`, not array offsets.
- Pass an empty candidate list and get an empty result with no network request.
- Decide at the call site how to degrade when the reranker fails. This package
  does not swallow errors; a reranker outage is a policy decision for the
  pipeline (typically: keep the fused retrieval order and continue).

## Out of scope

- Embedding generation (`@corbits/embedding`).
- Choosing or fusing retrieval results.
- Hiding transport or protocol failures behind a silent fallback.
