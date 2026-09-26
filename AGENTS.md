# AGENTS.md

## Purpose

`@corbits/reranking` scores documents against a query with a cross-encoder
over TEI, Cohere/Jina or Voyage rerank endpoints, with `@intx/inference`
retries and error classification. It owns the wire adapters, id mapping and
the one-shot JSON transport. It does not retrieve or store documents.

## Layout

- `src/rerank.ts`: `RerankConfigSchema` and `rerankDocuments`, which maps
  scores back to caller ids and sorts best first.
- `src/adapters.ts`: the `tei`, `cohere` and `voyage` adapters and
  `createRerankAdapterRegistry`.
- `src/request.ts`: `runJSONRequest` (private transport), `RerankRequestError`,
  `Retry-After` extraction.
- `src/index.ts`: the only module consumers import from.
- `e2e/`: a live TEI suite that skips unless `TEI_RERANK_URL` answers.

## Rules

- Providers score by array position; always map back to the caller's `id`.
- Throw `RerankRequestError` carrying the classified `InferenceError` as
  `reason`; never throw the `InferenceError` itself.
- Adapters parse replies with arktype and throw `ProtocolMismatchError` on a
  bad shape.
- An empty `docs` list returns `[]` without a request.
- `exactOptionalPropertyTypes` is on: omit optional keys, never assign
  `undefined` to them.

## Local development

```sh
bun install
bun run check
```
