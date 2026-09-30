import { AiRateLimiter, GOOGLE_GEMMA } from "../_shared/ai_rate_limit.ts";
import {
  type AiRepliesRequest,
  buildPrompt,
  extractReplies,
} from "./ai_replies.ts";
import { SHARED_QUOTA_BUDGET_MS } from "./generation_budget.ts";
import {
  type Model,
  providerAvailable,
  providerRequest,
  PROVIDERS,
} from "./shared_provider.ts";
import { SharedAiChunkStore } from "./shared_ai_store.ts";

const NORMAL_MODELS: Model[] = [
  "groq-120b",
  "cloudflare-gemma",
  "gemini-3.1",
  "openrouter-nemotron",
];
const NORMAL_PARALLEL_AT_MS = 7_000;
const NORMAL_MAX_MS = 30_000;
const GEMMA_MAX_MS = 6_000;
const REQUEST_MAX_MS = 40_000;

export type SharedChunkTarget = {
  newsUrl: string;
  chunkIndex: number;
  conversationPattern: string;
};
export type ParallelRouterDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetcher?: typeof fetch;
  limiter?: AiRateLimiter;
  store?: SharedAiChunkStore;
  emit?: (event: string, fields: Record<string, unknown>) => void;
  parallelThresholdMs?: number;
  requestTimeoutMs?: number;
};

type Outcome = {
  model: Model;
  replies?: string[];
  error?: string;
  timedOut?: boolean;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function generateSharedChunkParallel(
  input: AiRepliesRequest,
  target: SharedChunkTarget,
  requestId: string,
  waitUntil: (task: Promise<unknown>) => void,
  dependencies: ParallelRouterDependencies = {},
): Promise<{ replies: string[]; chunkIndex: number }> {
  const now = dependencies.now ?? (() => performance.now());
  const wait = dependencies.sleep ?? sleep;
  const fetcher = dependencies.fetcher ?? fetch;
  const limiter = dependencies.limiter ?? new AiRateLimiter();
  const store = dependencies.store ?? new SharedAiChunkStore();
  const emit = dependencies.emit ??
    ((event, fields) =>
      console.log(
        `[AiReplies] ${
          JSON.stringify({ event, diagnostic_id: requestId, ...fields })
        }`,
      ));
  const started = now();
  const deadline = started + (dependencies.requestTimeoutMs ?? REQUEST_MAX_MS);
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    Math.max(0, deadline - started),
  );
  let quotaRemaining = SHARED_QUOTA_BUDGET_MS;
  const context = {
    diagnostic_id: requestId,
    requested_chunk: target.chunkIndex,
  };
  const requestBudget = () => Math.max(0, deadline - now());
  const reserve = async (model: Model, prompt: string): Promise<boolean> => {
    const remaining = Math.min(quotaRemaining, requestBudget());
    if (remaining <= 0) {
      emit("quota_budget_exhausted", {
        ...context,
        model: PROVIDERS[model].model,
      });
      return false;
    }
    const before = now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const scoped = new AiRateLimiter(
        limiter.config,
        async (url, init) =>
          limiter.fetcher(url, {
            ...init,
            signal: AbortSignal.any([
              controller.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
        limiter.env,
      );
      const tokens = new TextEncoder().encode(prompt).length + 128;
      const result = await Promise.race([
        scoped.reserve(model, tokens, 1200, "comment"),
        new Promise<false>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(false), {
            once: true,
          })
        ),
      ]);
      const elapsed = now() - before;
      quotaRemaining = Math.max(0, quotaRemaining - elapsed);
      emit("quota_reservation", {
        ...context,
        model: PROVIDERS[model].model,
        success: result,
        duration_ms: Math.round(elapsed),
        timed_out: controller.signal.aborted,
      });
      return result && !controller.signal.aborted && requestBudget() > 0;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (now() - before <= 0) quotaRemaining = Math.max(0, quotaRemaining - 1);
    }
  };
  const updateCooldown = async (model: Model, response: Response) => {
    const remaining = Math.min(quotaRemaining, requestBudget());
    if (remaining <= 0) {
      emit("quota_budget_exhausted", {
        ...context,
        model: PROVIDERS[model].model,
        operation: "cooldown",
      });
      return;
    }
    const before = now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    const scoped = new AiRateLimiter(
      limiter.config,
      async (url, init) =>
        limiter.fetcher(url, {
          ...init,
          signal: AbortSignal.any([
            controller.signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
      limiter.env,
    );
    try {
      await Promise.race([
        scoped.cooldown(model, response),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          })
        ),
      ]);
      emit("provider_cooldown_recorded", {
        ...context,
        model: PROVIDERS[model].model,
        duration_ms: Math.round(now() - before),
        timed_out: controller.signal.aborted,
      });
    } catch {
      emit("provider_cooldown_failed", {
        ...context,
        model: PROVIDERS[model].model,
        duration_ms: Math.round(now() - before),
      });
    } finally {
      quotaRemaining = Math.max(0, quotaRemaining - (now() - before));
      clearTimeout(timeout);
      controller.abort();
    }
  };
  const prompt = buildPrompt(input);
  let claim = await store.rpc<Record<string, unknown>>(
    "claim_shared_ai_chunk_generation",
    {
      p_news_url: target.newsUrl,
      p_news_title: input.newsTitle,
      p_chunk_index: target.chunkIndex,
      p_request_id: requestId,
      p_conversation_pattern: target.conversationPattern,
    },
    deadlineController.signal,
  );
  if (claim.status === "ready") {
    const replies = (claim.replies as Array<{ text: string }>).map((r) =>
      r.text
    );
    clearTimeout(deadlineTimer);
    return { replies, chunkIndex: Number(claim.chunkIndex) };
  }
  if (claim.status === "gap") {
    clearTimeout(deadlineTimer);
    throw new Error("shared_chunk_gap");
  }
  if (claim.status === "running") {
    const stopAt = Math.min(deadline, now() + 35_000);
    while (now() < stopAt) {
      await wait(500);
      const polled = await store.rpc<Record<string, unknown>>(
        "claim_shared_ai_chunk_generation",
        {
          p_news_url: target.newsUrl,
          p_news_title: input.newsTitle,
          p_chunk_index: target.chunkIndex,
          p_request_id: requestId,
          p_conversation_pattern: target.conversationPattern,
        },
        deadlineController.signal,
      );
      if (polled.status === "ready") {
        clearTimeout(deadlineTimer);
        return {
          replies: (polled.replies as Array<{ text: string }>).map((r) =>
            r.text
          ),
          chunkIndex: Number(polled.chunkIndex),
        };
      }
      if (polled.status === "claimed") {
        claim = polled;
        break;
      }
    }
    clearTimeout(deadlineTimer);
    throw new Error("shared_chunk_generation_in_progress");
  }
  if (claim.status !== "claimed" || typeof claim.articleId !== "number") {
    clearTimeout(deadlineTimer);
    throw new Error("shared_chunk_claim_failed");
  }
  const articleId = claim.articleId;

  const attempt = async (
    model: Model,
    timeoutMs: number,
    lifecycle: { started: () => void; settled: () => void } = {
      started: () => {},
      settled: () => {},
    },
  ): Promise<Outcome> => {
    if (requestBudget() <= 0) {
      return { model, error: "request_deadline", timedOut: true };
    }
    if (model === GOOGLE_GEMMA && requestBudget() < GEMMA_MAX_MS) {
      emit("request_deadline_provider_skipped", {
        ...context,
        model: PROVIDERS[model].model,
        required_ms: GEMMA_MAX_MS,
        remaining_ms: Math.round(requestBudget()),
      });
      return { model, error: "request_deadline", timedOut: true };
    }
    if (!providerAvailable(model, limiter)) {
      return { model, error: "provider_unavailable" };
    }
    if (!await reserve(model, prompt)) {
      return {
        model,
        error: quotaRemaining <= 0 ? "quota_unavailable" : "quota_timeout",
      };
    }
    const timeout = Math.min(timeoutMs, requestBudget());
    if (timeout <= 0) {
      return { model, error: "request_deadline", timedOut: true };
    }
    const request = providerRequest(model, prompt, limiter);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const attemptStarted = now();
    let status: number | null = null;
    let phase = "provider_transport";
    emit("provider_request_started", {
      ...context,
      provider: PROVIDERS[model].kind,
      model: PROVIDERS[model].model,
    });
    lifecycle.started();
    try {
      const response = await fetcher(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      status = response.status;
      phase = "provider_response";
      emit("provider_response_received", {
        ...context,
        model: PROVIDERS[model].model,
        http_status: status,
      });
      if (!response.ok) {
        lifecycle.settled();
        if (status === 429) await updateCooldown(model, response);
        emit("provider_failed", {
          ...context,
          model: PROVIDERS[model].model,
          http_status: status,
          phase,
          error_class: "http_error",
          timed_out: false,
          duration_ms: Math.round(now() - attemptStarted),
        });
        return { model, error: `http_${status}` };
      }
      phase = "provider_response_parse";
      const result = await response.json();
      if (controller.signal.aborted || now() >= deadline) {
        return { model, error: "timeout", timedOut: true };
      }
      const kind = PROVIDERS[model].kind;
      const text = kind === "google"
        ? result.candidates?.[0]?.content?.parts?.filter((
          part: { thought?: boolean },
        ) => !part.thought).map((part: { text?: string }) => part.text ?? "")
          .join("")
        : kind === "cloudflare"
        ? result.result?.response
        : result.choices?.[0]?.message?.content;
      phase = "provider_response_validation";
      const replies = extractReplies(
        { candidates: [{ content: { parts: [{ text }] } }] },
        input.count,
        true,
      );
      if (controller.signal.aborted || now() >= deadline) {
        return { model, error: "timeout", timedOut: true };
      }
      emit("provider_succeeded", {
        ...context,
        model: PROVIDERS[model].model,
        http_status: status,
        reply_count: replies.length,
        duration_ms: Math.round(now() - attemptStarted),
      });
      emit("provider_output_validation", {
        ...context,
        model: PROVIDERS[model].model,
        http_status: status,
        valid: true,
        reply_count: replies.length,
      });
      return { model, replies };
    } catch (error) {
      lifecycle.settled();
      const timedOut = controller.signal.aborted || now() >= deadline;
      emit("provider_failed", {
        ...context,
        model: PROVIDERS[model].model,
        http_status: status,
        timed_out: timedOut,
        phase,
        error_class: timedOut
          ? "timeout"
          : phase === "provider_response_parse"
          ? "invalid_json"
          : phase === "provider_response_validation"
          ? "invalid_response"
          : "network_error",
        duration_ms: Math.round(now() - attemptStarted),
      });
      if (
        phase === "provider_response_parse" ||
        phase === "provider_response_validation"
      ) {
        emit("provider_output_validation", {
          ...context,
          model: PROVIDERS[model].model,
          http_status: status,
          valid: false,
          error_class: phase === "provider_response_parse"
            ? "invalid_json"
            : "invalid_response",
        });
      }
      return {
        model,
        error: timedOut
          ? "timeout"
          : phase === "provider_response_parse"
          ? "invalid_json"
          : phase === "provider_response_validation"
          ? "invalid_response"
          : "provider_error",
        timedOut,
      };
    } finally {
      lifecycle.settled();
      clearTimeout(timer);
    }
  };

  const savePrimary = async (result: Outcome) => {
    const saved = await store.rpc<Record<string, unknown>>(
      "complete_shared_ai_chunk_primary",
      {
        p_article_id: articleId,
        p_chunk_index: target.chunkIndex,
        p_request_id: requestId,
        p_model: result.model,
        p_replies: result.replies,
        p_reply_relations: input.replyRelations,
      },
      deadlineController.signal,
    );
    if (saved.status !== "saved") {
      throw new Error(`shared_chunk_primary_${String(saved.status)}`);
    }
    emit("shared_chunk_primary_saved", {
      ...context,
      model: PROVIDERS[result.model].model,
      chunk_index: saved.chunkIndex,
    });
    return {
      replies: (saved.replies as Array<{ text: string }>).map((r) => r.text),
      chunkIndex: Number(saved.chunkIndex),
    };
  };
  const saveLate = async (resultPromise: Promise<Outcome>) => {
    const result = await resultPromise;
    if (!result.replies) return;
    const saved = await store.rpc<Record<string, unknown>>(
      "append_shared_ai_late_result",
      {
        p_article_id: articleId,
        p_chunk_index: target.chunkIndex,
        p_request_id: requestId,
        p_model: result.model,
        p_replies: result.replies,
        p_reply_relations: input.replyRelations,
      },
      deadlineController.signal,
    );
    emit("shared_chunk_late_result_saved", {
      ...context,
      model: PROVIDERS[result.model].model,
      status: saved.status,
      chunk_index: saved.chunkIndex ?? null,
    });
  };

  let loser: Promise<Outcome> | undefined;
  let winner: Outcome | undefined;
  let finalFallbackReason = "normal_models_exhausted";
  for (const model of NORMAL_MODELS) {
    if (requestBudget() < 7_000) break;
    let providerPending = false;
    let providerStartResolve!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      providerStartResolve = resolve;
    });
    const running = attempt(model, NORMAL_MAX_MS, {
      started: () => {
        providerPending = true;
        providerStartResolve();
      },
      settled: () => providerPending = false,
    });
    let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
    const threshold = providerStarted.then(() =>
      new Promise<"threshold">((resolve) => {
        thresholdTimer = setTimeout(
          () => providerPending ? resolve("threshold") : undefined,
          Math.min(
            dependencies.parallelThresholdMs ?? NORMAL_PARALLEL_AT_MS,
            requestBudget(),
          ),
        );
      })
    );
    const first = await Promise.race([running, threshold]);
    clearTimeout(thresholdTimer);
    if (first !== "threshold") {
      if (first.replies) {
        winner = first;
        break;
      }
      emit("provider_next_model", {
        ...context,
        model: PROVIDERS[model].model,
        reason: first.error,
      });
      if (first.timedOut) {
        finalFallbackReason = "normal_provider_timeout";
        break;
      }
      continue;
    }
    emit("google_gemma_parallel_threshold_reached", {
      ...context,
      normal_model: PROVIDERS[model].model,
      elapsed_ms: Math.round(now() - started),
    });
    const gemma = (async (): Promise<Outcome> => {
      const result = await attempt(GOOGLE_GEMMA, GEMMA_MAX_MS);
      emit(
        result.replies
          ? "google_gemma_parallel_succeeded"
          : "google_gemma_parallel_failed",
        { ...context, error_class: result.error ?? null },
      );
      return result;
    })();
    const concurrent = await Promise.race([
      running.then((value) => ({ source: "normal" as const, value })),
      gemma.then((value) => ({ source: "gemma" as const, value })),
    ]);
    if (concurrent.value.replies) {
      winner = concurrent.value;
      loser = concurrent.source === "normal" ? gemma : running;
      break;
    }
    const other = concurrent.source === "normal" ? await gemma : await running;
    if (other.replies) winner = other;
    else finalFallbackReason = "parallel_models_failed";
    break;
  }

  if (!winner) {
    // All normal models failed before the parallel threshold (or no provider was available).
    if (
      finalFallbackReason === "normal_models_exhausted" &&
      requestBudget() >= GEMMA_MAX_MS
    ) {
      emit("google_gemma_fallback_started", {
        ...context,
        reason: finalFallbackReason,
      });
      const gemma = await attempt(GOOGLE_GEMMA, GEMMA_MAX_MS);
      if (gemma.replies) winner = gemma;
    }
  }
  if (!winner?.replies) {
    clearTimeout(deadlineTimer);
    await store.rpc("fail_shared_ai_chunk_generation", {
      p_article_id: articleId,
      p_chunk_index: target.chunkIndex,
      p_request_id: requestId,
    }, deadlineController.signal).catch(() => undefined);
    throw new Error("shared_ai_generation_failed");
  }
  let result: { replies: string[]; chunkIndex: number };
  try {
    result = await savePrimary(winner);
  } catch (error) {
    clearTimeout(deadlineTimer);
    await store.rpc("fail_shared_ai_chunk_generation", {
      p_article_id: articleId,
      p_chunk_index: target.chunkIndex,
      p_request_id: requestId,
    }, deadlineController.signal).catch(() => undefined);
    throw error;
  }
  if (loser) {
    // Keep the late result attached to the Edge Runtime without delaying the client response.
    waitUntil(
      saveLate(loser).catch((error) =>
        emit("shared_chunk_late_result_failed", {
          ...context,
          error_class: error instanceof Error ? error.message : "unknown",
        })
      ).finally(() => clearTimeout(deadlineTimer)),
    );
  } else {
    clearTimeout(deadlineTimer);
  }
  return result;
}
