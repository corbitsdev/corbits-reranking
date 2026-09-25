import { describe, expect, test } from "bun:test";

import { rerankDocuments } from "../src/index";

// A local TEI reranker, e.g.
// `docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest --model-id BAAI/bge-reranker-base`
const baseURL = process.env.TEI_RERANK_URL ?? "http://localhost:8080";

const reachable = await fetch(`${baseURL}/health`, {
  signal: AbortSignal.timeout(1_000),
})
  .then((res) => res.ok)
  .catch(() => false);

describe.skipIf(!reachable)(`TEI at ${baseURL}`, () => {
  test("ranks the relevant document first and maps every id back", async () => {
    const docs = [
      { id: "weather", text: "Rain is expected across the valley tomorrow." },
      { id: "paris", text: "Paris is the capital and largest city of France." },
      { id: "recipe", text: "Whisk the eggs before folding in the flour." },
    ];

    const out = await rerankDocuments("What is the capital of France?", docs, {
      baseURL,
      apiStyle: "tei",
    });

    expect(out[0]?.id).toBe("paris");
    expect(out.map((r) => r.id).sort()).toEqual(["paris", "recipe", "weather"]);
  });
});
