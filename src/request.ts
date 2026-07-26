import {
  classifyAbortError,
  classifyHTTPError,
  classifyNetworkError,
  classifyProtocolMismatch,
  createDefaultRetryPolicy,
  type BuiltRequest,
  type Dependencies,
} from "@intx/inference";
import type { InferenceError, RetryPolicy } from "@intx/types/runtime";

/**
 * One JSON request, classified and retried the way Interchange classifies and
 * retries an inference call.
 *
 * `runInference` cannot serve this: it is turn-shaped and streams SSE, whereas
 * a rerank is one-shot JSON. What carries over is everything around it — the
 * single `deps.fetch` transport, the error taxonomy, and the retry policy — so
 * a 429 from a rerank endpoint is classified and backed off exactly as one from
 * a chat endpoint.
 *
 * XXX: this file is duplicated, modulo the wording of this comment, in `@corbits/embedding`. It is not
 * shared infrastructure yet — the intended home is `@intx/inference` itself, as
 * a non-streaming sibling of `runInference`, pending that upstream
 * conversation. Fix both copies or neither.
 */

/**
 * What the transport actually reads from the harness.
 *
 * Deliberately narrower than `Dependencies`, whose `adapters: AdapterRegistry`
 * member is required: a caller should not have to assemble a registry of
 * *inference providers* in order to rerank a list. A real `Dependencies`
 * satisfies this structurally, so passing one still works.
 */
export type RequestDependencies = Pick<Dependencies, "fetch" | "scheduler">;

/**
 * Raised for every failure mode: transport, HTTP status, and a 200 whose body
 * is not the JSON the protocol promises.
 *
 * XXX: duplicated alongside this module, so `instanceof` does not hold across
 * the embedding and reranking copies. Discriminate on
 * `error.name === "ModelRequestError"` when catching both.
 */
export class ModelRequestError extends Error {
  constructor(
    readonly reason: InferenceError,
    readonly url: string,
  ) {
    super(`${url}: ${reason.message}`);
    this.name = "ModelRequestError";
  }
}

/**
 * Same signature as `@intx/inference`'s `RetryAfterExtractor`, which is not
 * exported from its barrel. Re-declared rather than reached for through a deep
 * import so this package depends only on the published surface.
 */
export type RetryAfterExtractor = (headers: Headers) => number | undefined;

export type RunRequestOptions = {
  deps: RequestDependencies;
  /** Defaults to Interchange's policy: back off retryables, abort the rest. */
  retryPolicy?: RetryPolicy;
  /**
   * Per-attempt ceiling, enforced alongside any caller `signal` rather than
   * instead of it. A cold local model can take a while to page in.
   */
  timeoutMs?: number;
  /**
   * Reads `Retry-After` off a failed response. Mirrors `ProviderAdapter`'s
   * member of the same name, so a provider that signals pacing its own way can
   * override without touching the transport. Defaults to
   * {@link extractRetryAfterMs}.
   */
  extractRetryAfterMs?: RetryAfterExtractor;
  signal?: AbortSignal;
};

type Attempt =
  | { ok: true; body: unknown }
  | { ok: false; error: InferenceError };

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `Retry-After` in seconds or as an HTTP date; undefined when absent.
 *
 * Both branches clamp at zero. A server may name an instant that has already
 * passed, and `Retry-After: -5` is not unheard of; a negative delay would flow
 * into the retry policy as though it were a pacing hint.
 *
 * The HTTP-date branch is wall-clock by necessity — the header names an
 * absolute instant, so it cannot be resolved against the harness scheduler's
 * virtual clock. Upstream's extractor has the same constraint.
 */
export const extractRetryAfterMs: RetryAfterExtractor = (headers) => {
  const header = headers.get("retry-after")?.trim();
  if (header === undefined || header === "") return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

/** Aborts on the caller's signal or the per-attempt timeout, whichever first. */
function attemptSignal(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function attemptOnce(
  request: BuiltRequest,
  deps: RequestDependencies,
  timeoutMs: number,
  extractRetryAfter: RetryAfterExtractor,
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  let res: Response;
  let raw: string;
  try {
    res = await deps.fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: attemptSignal(timeoutMs, signal),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      return {
        ok: false,
        error: classifyHTTPError(
          res.status,
          detail,
          detail,
          extractRetryAfter(res.headers),
        ),
      };
    }

    // Read as text and parse here rather than `res.json()`, so a 200 carrying
    // an HTML interstitial or a truncated body — both common in front of local
    // model servers — is classified like any other failure instead of escaping
    // as a bare SyntaxError.
    raw = await res.text();
  } catch (cause) {
    const aborted =
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError");
    return {
      ok: false,
      error: aborted ? classifyAbortError() : classifyNetworkError(cause),
    };
  }

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      error: classifyProtocolMismatch(
        `expected a JSON body, got ${raw.slice(0, 200)}`,
        raw,
      ),
    };
  }
}

/** Sleeps on the harness scheduler, waking early if the caller aborts. */
function delay(
  deps: RequestDependencies,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const cancel = deps.scheduler.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      cancel();
      resolve();
    }

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function runJSONRequest(
  request: BuiltRequest,
  options: RunRequestOptions,
): Promise<unknown> {
  const { deps, signal } = options;
  const policy = options.retryPolicy ?? createDefaultRetryPolicy();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const extractRetryAfter = options.extractRetryAfterMs ?? extractRetryAfterMs;

  // Time comes from the harness scheduler, not globals, so a virtual-clock
  // test scheduler drives the retry loop deterministically.
  const startedAt = deps.scheduler.now();

  for (let attempt = 1; ; attempt++) {
    const result = await attemptOnce(
      request,
      deps,
      timeoutMs,
      extractRetryAfter,
      signal,
    );
    if (result.ok) return result.body;

    const decision = await policy({
      error: result.error,
      attempt,
      elapsedMs: deps.scheduler.now() - startedAt,
    });
    if (decision.kind === "abort") {
      throw new ModelRequestError(result.error, request.url);
    }

    // Aborting mid-delay wakes immediately; the next attempt then fails its
    // entry-time signal check, which the default policy aborts on. Matches the
    // harness's documented cancellation semantics.
    await delay(deps, decision.delayMs, signal);
  }
}
