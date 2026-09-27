import { afterEach, describe, expect, test } from "bun:test";
import { setupHarness, type Harness } from "@intx/inference-testing";

import {
  rerankDocuments,
  type RerankConfig,
  type RerankOptions,
} from "./rerank";
import {
  createRerankAdapterRegistry,
  rerankAdapterRegistry,
  type RerankAdapter,
} from "./adapters";
import { extractRetryAfterMs, RerankRequestError } from "./request";

const DOCS = [
  { id: "a", text: "alpha" },
  { id: "b", text: "bravo" },
  { id: "c", text: "charlie" },
];

const BASE_URL = "https://rerank.example";

let harness: Harness;
let undisposed: Harness | undefined;

afterEach(() => {
  undisposed?.dispose();
  undisposed = undefined;
});

function setup(): Harness {
  harness = setupHarness({ enableInferenceTimers: true });
  undisposed = harness;
  return harness;
}

function reply(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  const stream = harness.scenario.createStream();
  stream.enqueue(new TextEncoder().encode(body));
  stream.closeAt(0);
  harness.scenario.whenRequestMatches(() => true, stream, { status, headers });
}

async function rerank(
  config: RerankConfig,
  docs = DOCS,
  registry = rerankAdapterRegistry,
): Promise<unknown> {
  const options: RerankOptions = { deps: harness.deps, registry };
  const pending = rerankDocuments("q", docs, config, options).catch(
    (error: unknown) => error,
  );
  await harness.run();
  return pending;
}

function requestBodies(): Promise<unknown[]> {
  return Promise.all(
    harness.scenario.matchedRequests().map((req) => req.json()),
  );
}

describe("wire formats", () => {
  test.each([
    {
      apiStyle: "tei",
      path: "/rerank",
      sent: { query: "q", texts: ["alpha", "bravo", "charlie"] },
      received: [
        { index: 1, score: 0.2 },
        { index: 2, score: 0.9 },
      ],
    },
    {
      apiStyle: "cohere",
      path: "/v2/rerank",
      sent: {
        model: "rerank-v2",
        query: "q",
        documents: ["alpha", "bravo", "charlie"],
      },
      received: {
        results: [
          { index: 1, relevance_score: 0.2 },
          { index: 2, relevance_score: 0.9 },
        ],
      },
    },
    {
      apiStyle: "voyage",
      path: "/v1/rerank",
      sent: {
        model: "rerank-v2",
        query: "q",
        documents: ["alpha", "bravo", "charlie"],
      },
      received: {
        data: [
          { index: 1, relevance_score: 0.2 },
          { index: 2, relevance_score: 0.9 },
        ],
      },
    },
  ])("$apiStyle", async ({ apiStyle, path, sent, received }) => {
    setup();
    reply(200, JSON.stringify(received));

    const out = await rerank({
      baseURL: BASE_URL,
      apiStyle,
      model: "rerank-v2",
    });

    // Mapped through the reply's index, not its position, and sorted.
    expect(out).toEqual([
      { id: "c", score: 0.9 },
      { id: "b", score: 0.2 },
    ]);
    expect(harness.scenario.matchedRequests().map((req) => req.url)).toEqual([
      `${BASE_URL}${path}`,
    ]);
    expect(await requestBodies()).toEqual([sent]);
  });
});

describe("retry", () => {
  test("backs off a 429 by Retry-After on the harness clock", async () => {
    setup();
    reply(429, "slow down", { "retry-after": "2" });
    reply(200, JSON.stringify([{ index: 0, score: 0.4 }]));

    const out = await rerank({ baseURL: BASE_URL, apiStyle: "tei" });

    expect(out).toEqual([{ id: "a", score: 0.4 }]);
    expect(harness.scenario.matchedRequests()).toHaveLength(2);
    expect(harness.clock.now()).toBe(2_000);
  });

  test("aborts on a 401 without retrying", async () => {
    setup();
    reply(401, "bad key");

    const error = await rerank({ baseURL: BASE_URL, apiStyle: "tei" });

    expect(error).toBeInstanceOf(RerankRequestError);
    expect((error as RerankRequestError).reason.category).toBe(
      "credential_failure",
    );
    expect((error as RerankRequestError).url).toBe(`${BASE_URL}/rerank`);
    expect(harness.scenario.matchedRequests()).toHaveLength(1);
  });

  test("reads Retry-After through the adapter override", async () => {
    setup();
    const tei = rerankAdapterRegistry.resolve("tei");
    const registry = createRerankAdapterRegistry({
      tei: {
        buildRequest: tei.buildRequest,
        parseResponse: tei.parseResponse,
        extractRetryAfterMs: (headers) =>
          Number(headers.get("x-ratelimit-reset")) * 1_000,
      },
    });
    reply(429, "slow down", { "x-ratelimit-reset": "7" });
    reply(200, JSON.stringify([{ index: 0, score: 0.4 }]));

    await rerank({ baseURL: BASE_URL, apiStyle: "tei" }, DOCS, registry);

    expect(harness.clock.now()).toBe(7_000);
  });
});

describe("errors", () => {
  test("a reply in another provider's shape is a protocol mismatch", async () => {
    setup();
    reply(200, JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }));

    const error = await rerank({ baseURL: BASE_URL, apiStyle: "tei" });

    expect(error).toBeInstanceOf(RerankRequestError);
    expect((error as RerankRequestError).reason.category).toBe(
      "protocol_mismatch",
    );
  });

  test("an out-of-range index is a protocol mismatch", async () => {
    setup();
    reply(200, JSON.stringify([{ index: 99, score: 0.5 }]));

    const error = await rerank({ baseURL: BASE_URL, apiStyle: "tei" });

    expect(error).toBeInstanceOf(RerankRequestError);
    expect((error as RerankRequestError).reason.message).toBe(
      "rerank response index 99 out of bounds for 3 documents",
    );
  });

  test.each(["cohere", "voyage"])(
    "%s without a model fails before posting",
    async (apiStyle) => {
      setup();
      const error = await rerank({ baseURL: BASE_URL, apiStyle });

      expect((error as Error).message).toBe(
        "model must be a string (was undefined)",
      );
      expect(harness.scenario.matchedRequests()).toHaveLength(0);
    },
  );

  test("an invalid config fails before posting", async () => {
    setup();
    const error = await rerank({
      baseURL: BASE_URL,
      apiStyle: "tei",
      timeoutMs: 0,
    });

    expect((error as Error).message).toBe("timeoutMs must be positive (was 0)");
    expect(harness.scenario.matchedRequests()).toHaveLength(0);
  });

  test("an unknown apiStyle, including an inherited name, fails by name", async () => {
    setup();
    for (const apiStyle of ["nope", "toString"]) {
      const error = await rerank({ baseURL: BASE_URL, apiStyle });
      expect((error as Error).message).toMatch(
        `Unknown rerank API style "${apiStyle}"`,
      );
    }
  });
});

test("empty input returns nothing without a request", async () => {
  setup();
  expect(await rerank({ baseURL: BASE_URL, apiStyle: "tei" }, [])).toEqual([]);
  expect(harness.scenario.matchedRequests()).toHaveLength(0);
});

test("a registry is not mutable through the map it was built from", () => {
  const source: Record<string, RerankAdapter> = {
    tei: rerankAdapterRegistry.resolve("tei"),
  };
  const registry = createRerankAdapterRegistry(source);
  source.voyage = rerankAdapterRegistry.resolve("voyage");
  expect(registry.has("voyage")).toBe(false);
});

test("options default to global fetch", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json([{ index: 0, score: 0.5 }]),
  });
  try {
    const out = await rerankDocuments("q", DOCS, {
      baseURL: server.url.origin,
      apiStyle: "tei",
    });
    expect(out).toEqual([{ id: "a", score: 0.5 }]);
  } finally {
    await server.stop();
  }
});

describe("retry-after parsing", () => {
  test("reads the seconds form", () => {
    expect(extractRetryAfterMs(new Headers({ "retry-after": "2" }))).toBe(
      2_000,
    );
  });

  test("returns undefined when the header is absent", () => {
    expect(extractRetryAfterMs(new Headers())).toBeUndefined();
  });

  test("clamps a date already past to zero", () => {
    expect(
      extractRetryAfterMs(
        new Headers({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }),
      ),
    ).toBe(0);
  });

  test("clamps a negative seconds value to zero", () => {
    expect(extractRetryAfterMs(new Headers({ "retry-after": "-5" }))).toBe(0);
  });

  test("treats a blank header as absent", () => {
    expect(
      extractRetryAfterMs(new Headers({ "retry-after": "   " })),
    ).toBeUndefined();
  });
});
