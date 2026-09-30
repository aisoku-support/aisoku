import { AiRateLimiter, GOOGLE_GEMMA } from "../_shared/ai_rate_limit.ts";
import {
  type AiRepliesRequest,
  buildPrompt,
  extractReplies,
  ProviderError,
} from "./ai_replies.ts";
import {
  BudgetExpired,
  GenerationBudget,
  SHARED_QUOTA_BUDGET_MS,
} from "./generation_budget.ts";
import {
  type Model,
  providerAvailable,
  providerRequest,
  PROVIDERS,
} from "./shared_provider.ts";

export const NORMAL_MODEL_ORDER = [
  "groq-120b",
  "cloudflare-gemma",
  "gemini-3.1",
  "openrouter-nemotron",
] as const;
export const NORMAL_PROVIDER_TIMEOUT_MS = 7_000;
export const GEMMA_PROVIDER_TIMEOUT_MS = 6_000;

export type NormalRouterOptions = {
  budget?: GenerationBudget;
  limiter?: AiRateLimiter;
  normalTimeoutMs?: number;
  gemmaTimeoutMs?: number;
  quotaBudgetMs?: number;
};

export async function generateSharedReplies(
  input: AiRepliesRequest,
  fetcher: typeof fetch,
  diagnosticId?: string,
  options: NormalRouterOptions = {},
): Promise<string[]> {
  const budget = options.budget ?? new GenerationBudget();
  const limiter = options.limiter ?? new AiRateLimiter();
  let quotaRemaining = options.quotaBudgetMs ?? SHARED_QUOTA_BUDGET_MS;
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    if (diagnosticId) {
      console.log(
        `[AiReplies] ${
          JSON.stringify({ event, diagnostic_id: diagnosticId, ...fields })
        }`,
      );
    }
  };
  const fields = (model: Model) => ({
    model: PROVIDERS[model].model,
    provider: PROVIDERS[model].kind === "google"
      ? "google_ai_studio"
      : PROVIDERS[model].kind === "cloudflare"
      ? "cloudflare_workers_ai"
      : model === "groq-120b"
      ? "groq"
      : "openrouter",
  });
  const quota = async (
    model: Model,
    operation: "reservation" | "cooldown",
    work: (scoped: AiRateLimiter) => Promise<unknown>,
  ) => {
    budget.check();
    if (quotaRemaining <= 0) {
      emit("quota_budget_exhausted", {
        ...fields(model),
        operation,
        quota_remaining_ms: 0,
      });
      return false;
    }
    const started = budget.now();
    const scope = new GenerationBudget(
      quotaRemaining,
      budget.now,
      "quota_timeout",
      budget,
    );
    // Same config, Redis keys, atomic Lua and conservative reservations as chunk 1.
    // The transport checks prevent a late cooldown parse from starting Redis work.
    let redisSignal: AbortSignal | null | undefined;
    let transportTimeout = false;
    const scoped = new AiRateLimiter(limiter.config, async (url, init) => {
      scope.check();
      redisSignal = init?.signal;
      try {
        return await limiter.fetcher(url, {
          ...init,
          signal: AbortSignal.any([
            scope.signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
      } catch (error) {
        transportTimeout = error instanceof DOMException &&
          error.name === "TimeoutError";
        throw error;
      }
    }, limiter.env);
    try {
      const result = await scope.run(() => work(scoped));
      if (result === false && (transportTimeout || redisSignal?.aborted)) {
        throw new BudgetExpired("quota_timeout");
      }
      emit("quota_completed", {
        ...fields(model),
        operation,
        success: result !== false,
        duration_ms: Math.round(budget.now() - started),
      });
      return result !== false;
    } catch (error) {
      if (error instanceof BudgetExpired && error.kind === "request_deadline") {
        throw error;
      }
      emit("quota_failed", {
        ...fields(model),
        operation,
        timeout: error instanceof BudgetExpired || transportTimeout ||
          redisSignal?.aborted === true,
        error_class: error instanceof BudgetExpired || transportTimeout ||
            redisSignal?.aborted
          ? "quota_timeout"
          : "quota_unavailable",
        duration_ms: Math.round(budget.now() - started),
      });
      return false;
    } finally {
      quotaRemaining = Math.max(0, quotaRemaining - (budget.now() - started));
      // Abort body reads too; an ambiguous reservation is deliberately never refunded.
      scope.controller.abort();
    }
  };

  try {
    return await budget.run(async () => {
      const prompt = buildPrompt(input);
      const inputTokens = new TextEncoder().encode(prompt).length + 128;
      budget.check();
      const attempt = async (model: Model): Promise<string[] | undefined> => {
        const timeout = model === GOOGLE_GEMMA
          ? options.gemmaTimeoutMs ?? GEMMA_PROVIDER_TIMEOUT_MS
          : options.normalTimeoutMs ?? NORMAL_PROVIDER_TIMEOUT_MS;
        budget.check(timeout);
        if (!providerAvailable(model, limiter)) {
          emit("provider_request_skipped", {
            ...fields(model),
            reason: "provider_unavailable",
            timeout: false,
          });
          return undefined;
        }
        if (
          !await quota(
            model,
            "reservation",
            (scoped) => scoped.reserve(model, inputTokens, 1200, "comment"),
          )
        ) {
          emit("provider_request_skipped", {
            ...fields(model),
            reason: "quota_unavailable",
            timeout: false,
          });
          return undefined;
        }
        // Reservation latency may leave insufficient time for the full provider window.
        budget.check(timeout);
        const request = providerRequest(model, prompt, limiter);
        const body = JSON.stringify(request.body);
        budget.check(timeout);
        const started = budget.now();
        const provider = new GenerationBudget(
          timeout,
          budget.now,
          "timeout",
          budget,
        );
        let status: number | null = null;
        let phase = "provider_transport";
        let response: Response | undefined;
        emit("provider_request_started", {
          ...fields(model),
          timeout_ms: timeout,
        });
        try {
          const replies = await provider.run(async () => {
            response = await fetcher(request.url, {
              method: "POST",
              headers: request.headers,
              body,
              signal: provider.signal,
            });
            provider.check();
            status = response.status;
            phase = "provider_response";
            emit("provider_response_received", {
              ...fields(model),
              provider_status: status,
              duration_ms: Math.round(budget.now() - started),
            });
            if (!response.ok) {
              throw new ProviderError("provider_unavailable", {
                exception: "http_error",
              });
            }
            phase = "provider_response_parse";
            const result = await response.json();
            provider.check();
            const kind = PROVIDERS[model].kind;
            const text = kind === "google"
              ? result.candidates?.[0]?.content?.parts?.filter((
                p: { thought?: boolean },
              ) => !p.thought).map((p: { text?: string }) => p.text ?? "").join(
                "",
              )
              : kind === "cloudflare"
              ? result.result?.response
              : result.choices?.[0]?.message?.content;
            phase = "provider_response_validation";
            // Existing JSON repair/validation; shared chunks must contain all ten strings.
            const replies = extractReplies(
              { candidates: [{ content: { parts: [{ text }] } }] },
              input.count,
              true,
            );
            provider.check();
            emit("provider_output_validation", {
              ...fields(model),
              provider_status: status,
              valid: true,
              reply_count: replies.length,
              duration_ms: Math.round(budget.now() - started),
            });
            return replies;
          });
          budget.check();
          emit("provider_succeeded", {
            ...fields(model),
            provider_status: status,
            timeout: false,
            duration_ms: Math.round(budget.now() - started),
          });
          return replies;
        } catch (error) {
          if (
            error instanceof BudgetExpired && error.kind === "request_deadline"
          ) throw error;
          const timedOut = error instanceof BudgetExpired ||
            error instanceof DOMException && error.name === "TimeoutError";
          const reason = timedOut
            ? "timeout"
            : phase === "provider_response_parse"
            ? "invalid_json"
            : phase === "provider_response_validation"
            ? "invalid_response"
            : phase === "provider_response"
            ? "http_error"
            : "fetch_failed";
          emit("provider_request_failed", {
            ...fields(model),
            stage: phase,
            provider_status: status,
            error_class: reason,
            timeout: timedOut,
            duration_ms: Math.round(budget.now() - started),
          });
          if (
            phase === "provider_response_parse" ||
            phase === "provider_response_validation"
          ) {
            emit("provider_output_validation", {
              ...fields(model),
              provider_status: status,
              valid: false,
              error_class: reason,
            });
          }
          // Stop provider I/O before a new model starts. 429 needs only its buffered
          // error details/headers; quota budget bounds a stalled error-body read.
          if (status === 429 && response && !timedOut) {
            await quota(
              model,
              "cooldown",
              (scoped) => scoped.cooldown(model, response!),
            );
          }
          throw new ProviderError("provider_unavailable", {
            ...fields(model),
            stage: timedOut ? "timeout" : phase,
            status,
            exception: reason,
            timeout: timedOut,
            duration_ms: Math.round(budget.now() - started),
          });
        } finally {
          provider.controller.abort();
        }
      };

      let fallbackReason = "normal_models_exhausted";
      for (const model of NORMAL_MODEL_ORDER) {
        try {
          const replies = await attempt(model);
          if (replies) return replies;
          emit("provider_next_model", {
            ...fields(model),
            reason: "unavailable",
          });
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (error.diagnostic.timeout) {
            fallbackReason = "timeout";
            break;
          }
          emit("provider_next_model", {
            ...fields(model),
            reason: error.diagnostic.exception,
          });
        }
      }
      budget.check();
      emit("provider_fallback_started", {
        ...fields(GOOGLE_GEMMA),
        reason: fallbackReason,
      });
      const replies = await attempt(GOOGLE_GEMMA);
      if (replies) return replies;
      throw new ProviderError("provider_unavailable", {
        ...fields(GOOGLE_GEMMA),
        stage: "provider_call_start",
        exception: "quota_unavailable",
        timeout: false,
      });
    });
  } catch (error) {
    if (error instanceof BudgetExpired) {
      budget.controller.abort();
      emit("request_deadline_exceeded", {
        stage: "request_deadline",
        error_class: "request_deadline",
        reason: error.reason,
        remaining_ms: Math.max(0, budget.remaining()),
      });
      throw new ProviderError("provider_unavailable", {
        stage: "request_deadline",
        exception: "request_deadline",
        timeout: true,
      });
    }
    throw error;
  }
}
