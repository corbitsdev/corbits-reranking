import { describe, expect, it } from "bun:test";
import type { Dependencies } from "@intx/inference";

import { rerankDocuments, type RerankConfig } from "./rerank";
import {
  createRerankAdapterRegistry,
  rerankAdapterRegistry,
  rerankAdapters,
  type RerankAPIStyle,
} from "./adapters";
import { extractRetryAfterMs, ModelRequestError } from "./request";

const DOCS = [
  { id: "a", text: "alpha" },
  { id: "b", text: "bravo" },
  { id: "c", text: "charlie" },
];

type Call = { url: string; init: RequestInit };

function deps(responses: Response[]): { deps: Dependencies; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  let virtualNow = 0;

  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next === undefined) throw new Error("no response queued");
    return next;
  }) as unknown as Dependencies["fetch"];

  const scheduler = {
    now: () => virtualNow,
    setTimeout: (callback: () => void, delayMs: number) => {
      virtualNow += delayMs;
      queueMicrotask(callback);
      return () => {};
    },
  };

  return {
    deps: { fetch: fetchImpl, scheduler } as unknown as Dependencies,
    calls,
  };
}

function config(apiStyle: RerankAPIStyle): RerankConfig {
  // Cohere and Voyage reject a request without a model; TEI ignores it.
  return { baseURL: "https://rerank.example", apiStyle, model: "rerank-v2" };
}

function body(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("wire formats", () => {
  it("TEI posts /rerank with texts and reads a bare array", async () => {
    const { deps: d, calls } = deps([
      Response.json([
        { index: 2, score: 0.9 },
        { index: 0, score: 0.1 },
      ]),
    ]);
    const out = await rerankDocuments("q", DOCS, config("tei"), { deps: d });

    expect(calls[0]?.url).toBe("https://rerank.example/rerank");
    expect(body(calls[0]).texts).toEqual(["alpha", "bravo", "charlie"]);
    expect(out).toEqual([
      { id: "c", score: 0.9 },
      { id: "a", score: 0.1 },
    ]);
  });

  it("Cohere posts /v2/rerank with documents and reads results[]", async () => {
    const { deps: d, calls } = deps([
      Response.json({ results: [{ index: 1, relevance_score: 0.7 }] }),
    ]);
    const out = await rerankDocuments("q", DOCS, config("cohere"), { deps: d });

    expect(calls[0]?.url).toBe("https://rerank.example/v2/rerank");
    expect(body(calls[0]).documents).toEqual(["alpha", "bravo", "charlie"]);
    expect(out).toEqual([{ id: "b", score: 0.7 }]);
  });

  it("Voyage posts /v1/rerank and reads data[]", async () => {
    const { deps: d, calls } = deps([
      Response.json({ data: [{ index: 0, relevance_score: 0.5 }] }),
    ]);
    const out = await rerankDocuments("q", DOCS, config("voyage"), { deps: d });

    expect(calls[0]?.url).toBe("https://rerank.example/v1/rerank");
    expect(out).toEqual([{ id: "a", score: 0.5 }]);
  });

  it("requires a model for the styles that mandate one", async () => {
    // Cohere and Voyage 400 without it. Fail by name here rather than in prod.
    const { deps: d, calls } = deps([]);
    for (const style of ["cohere", "voyage"] as const) {
      await expect(
        rerankDocuments(
          "q",
          DOCS,
          { baseURL: "https://rerank.example", apiStyle: style },
          { deps: d },
        ),
      ).rejects.toThrow(`${style} rerank requires config.model`);
    }
    expect(calls).toHaveLength(0);
  });

  it("does not require a model for TEI, which serves a fixed one", async () => {
    const { deps: d } = deps([Response.json([{ index: 0, score: 0.3 }])]);
    const out = await rerankDocuments(
      "q",
      DOCS,
      { baseURL: "https://rerank.example", apiStyle: "tei" },
      { deps: d },
    );
    expect(out).toEqual([{ id: "a", score: 0.3 }]);
  });

  it("rejects an unknown apiStyle by name", async () => {
    const { deps: d } = deps([]);
    await expect(
      rerankDocuments(
        "q",
        DOCS,
        { baseURL: "https://rerank.example", apiStyle: "nope" },
        { deps: d },
      ),
    ).rejects.toThrow(/Unknown rerank API style "nope"/);
  });

  it("rejects a reply in another provider's shape", async () => {
    // Cohere's body through the TEI adapter: the formats do not converge, and
    // a mismatch must fail rather than silently rerank nothing.
    const { deps: d } = deps([
      Response.json({ results: [{ index: 0, relevance_score: 0.5 }] }),
    ]);
    await expect(
      rerankDocuments("q", DOCS, config("tei"), { deps: d }),
    ).rejects.toThrow(/malformed tei rerank response/);
  });
});

describe("result mapping", () => {
  it("maps by response index, not reply position", async () => {
    // TEI's reply is explicitly unordered. Trusting position would silently
    // attach the top score to the wrong document.
    const { deps: d } = deps([
      Response.json([
        { index: 1, score: 0.2 },
        { index: 2, score: 0.95 },
      ]),
    ]);
    const out = await rerankDocuments("q", DOCS, config("tei"), { deps: d });
    expect(out.map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("raises when a provider returns an out-of-range index", async () => {
    const { deps: d } = deps([Response.json([{ index: 99, score: 0.5 }])]);
    await expect(
      rerankDocuments("q", DOCS, config("tei"), { deps: d }),
    ).rejects.toThrow(/index 99 out of bounds for 3 documents/);
  });

  it("returns nothing and issues no request for empty input", async () => {
    const { deps: d, calls } = deps([]);
    expect(await rerankDocuments("q", [], config("tei"), { deps: d })).toEqual(
      [],
    );
    expect(calls).toHaveLength(0);
  });
});

describe("retry behaviour inherited from the inference policy", () => {
  it("retries a 429 and succeeds on the follow-up", async () => {
    const { deps: d, calls } = deps([
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
      Response.json([{ index: 0, score: 0.4 }]),
    ]);
    const out = await rerankDocuments("q", DOCS, config("tei"), { deps: d });
    expect(calls).toHaveLength(2);
    expect(out).toEqual([{ id: "a", score: 0.4 }]);
  });

  it("aborts immediately on 401 instead of hammering a bad key", async () => {
    const { deps: d, calls } = deps([new Response("nope", { status: 401 })]);
    await expect(
      rerankDocuments("q", DOCS, config("tei"), { deps: d }),
    ).rejects.toBeInstanceOf(ModelRequestError);
    expect(calls).toHaveLength(1);
  });

  it("lets an adapter override how Retry-After is read", async () => {
    // Mirrors ProviderAdapter.extractRetryAfterMs: a provider that signals
    // pacing its own way overrides without the transport knowing.
    const seen: Array<string | null> = [];
    const registry = createRerankAdapterRegistry({
      tei: {
        ...rerankAdapters.tei,
        extractRetryAfterMs: (headers) => {
          seen.push(headers.get("x-ratelimit-reset"));
          return 0;
        },
      },
    });
    const { deps: d } = deps([
      new Response("slow down", {
        status: 429,
        headers: { "x-ratelimit-reset": "7" },
      }),
      Response.json([{ index: 0, score: 0.4 }]),
    ]);
    await rerankDocuments("q", DOCS, config("tei"), { deps: d, registry });
    expect(seen).toEqual(["7"]);
  });
});

describe("retry-after parsing", () => {
  it("reads the seconds form", () => {
    expect(extractRetryAfterMs(new Headers({ "retry-after": "2" }))).toBe(
      2_000,
    );
  });

  it("returns undefined when the header is absent", () => {
    expect(extractRetryAfterMs(new Headers())).toBeUndefined();
  });

  it("clamps a date already past to zero", () => {
    expect(
      extractRetryAfterMs(
        new Headers({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }),
      ),
    ).toBe(0);
  });

  it("clamps a negative seconds value to zero", () => {
    expect(extractRetryAfterMs(new Headers({ "retry-after": "-5" }))).toBe(0);
  });

  it("treats a blank header as absent", () => {
    expect(
      extractRetryAfterMs(new Headers({ "retry-after": "   " })),
    ).toBeUndefined();
  });
});

describe("adapter registry", () => {
  it("resolves each built-in style", () => {
    for (const style of ["tei", "cohere", "voyage"]) {
      expect(rerankAdapterRegistry.resolve(style).buildRequest).toBeTypeOf(
        "function",
      );
    }
  });

  it("does not let an inherited member masquerade as an adapter", () => {
    // A plain object lookup returns Object.prototype.toString here, which then
    // fails later with an opaque TypeError. apiStyle often comes from config,
    // so the failure must be immediate and by name.
    expect(rerankAdapterRegistry.has("toString")).toBe(false);
    expect(() => rerankAdapterRegistry.resolve("toString")).toThrow(
      /Unknown rerank API style "toString"/,
    );
  });

  it("is not mutable through the map it was built from", () => {
    const source: Record<string, (typeof rerankAdapters)["tei"]> = {
      tei: rerankAdapters.tei,
    };
    const registry = createRerankAdapterRegistry(source);
    source.voyage = rerankAdapters.voyage;
    expect(registry.has("voyage")).toBe(false);
  });
});
