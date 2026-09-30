import {
  providerAvailable,
  providerRequest,
  PROVIDERS,
} from "./shared_provider.ts";
import {
  type AiRepliesRequest,
  buildPrompt,
  extractReplies,
} from "./ai_replies.ts";
import { AiRateLimiter, GOOGLE_GEMMA } from "../_shared/ai_rate_limit.ts";
import type { RolloutModel } from "./shared_router_rollout.ts";

export const MODEL_ORDER = [
  "groq-120b",
  GOOGLE_GEMMA,
  "cloudflare-gemma",
  "gemini-3.1",
  "openrouter-nemotron",
] as const;
export type Model = typeof MODEL_ORDER[number];
export class UnknownProviderResult extends Error {}
type AttemptContext = { topicId: string; attemptId: string };

const providerName = (model: Model) =>
  PROVIDERS[model].kind === "google"
    ? "google_ai_studio"
    : PROVIDERS[model].kind === "cloudflare"
    ? "cloudflare_workers_ai"
    : model === "groq-120b"
    ? "groq"
    : "openrouter";

function diagnostic(
  event: string,
  fields: Record<string, unknown>,
) {
  // Keep diagnostics structured and bounded; never include exception text or payloads.
  console.log(`[SharedAiRouter] ${JSON.stringify({ event, ...fields })}`);
}

const activeAttempts = new Map<string, {
  topicId?: string;
  attemptId: string;
  model: Model;
  stage: string;
  started: number;
  now: () => number;
  emit: typeof diagnostic;
}>();

if (typeof addEventListener === "function") {
  addEventListener("beforeunload", () => {
    for (const active of activeAttempts.values()) {
      active.emit("function_processing_interrupted", {
        ...(active.topicId ? { topic_id: active.topicId } : {}),
        attempt_id: active.attemptId,
        model: active.model,
        provider: providerName(active.model),
        stage: active.stage,
        error_class: "function_shutdown",
        duration_ms: Math.max(0, active.now() - active.started),
      });
    }
  });
}

function safeErrorClass(error: unknown): "timeout_or_abort" | "network_error" {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError"
    ? "timeout_or_abort"
    : "network_error";
}

export type RouterDeps = {
  topicId?: string;
  models?: readonly Model[];
  diagnostic?: (event: string, fields: Record<string, unknown>) => void;
  now: () => number;
  pause: (ms: number) => Promise<void>;
  ready: () => Promise<boolean>;
  reserve: (model: Model) => Promise<boolean>;
  begin: (model: Model, id: string) => Promise<boolean>;
  generate: (model: Model, context: AttemptContext) => Promise<string[]>;
  save: (id: string, replies: string[]) => Promise<void>;
  fail: (id: string) => Promise<void>;
};

/** A single owner per Topic is enforced by the DB; in-flight promises always drain. */
export async function runSharedRouter(
  deps: RouterDeps,
  attempted: string[] = [],
) {
  const emit = deps.diagnostic ?? diagnostic;
  const candidates = (deps.models ?? MODEL_ORDER).filter((m) =>
    !attempted.includes(m)
  );
  const running = new Map<string, { started: number; done: Promise<void> }>();
  let saved = false;
  const deadline = deps.now() + 20000;
  const prepare = async () => {
    while (candidates.length && !saved && deps.now() < deadline) {
      if (await deps.ready()) return null;
      const model = candidates.shift()!;
      if (!await deps.reserve(model)) continue;
      const id = crypto.randomUUID();
      const beginStarted = deps.now();
      if (!await deps.begin(model, id)) {
        emit("attempt_begin_rejected", {
          ...(deps.topicId ? { topic_id: deps.topicId } : {}),
          attempt_id: id,
          model,
          provider: providerName(model),
          stage: "database_begin_attempt",
          duration_ms: Math.max(0, deps.now() - beginStarted),
        });
        return null;
      }
      return () => {
        const started = deps.now();
        const context = { topicId: deps.topicId ?? "", attemptId: id };
        const active = {
          ...(deps.topicId ? { topicId: deps.topicId } : {}),
          attemptId: id,
          model,
          stage: "provider_processing",
          started,
          now: deps.now,
          emit,
        };
        activeAttempts.set(id, active);
        emit("attempt_started", {
          ...(deps.topicId ? { topic_id: deps.topicId } : {}),
          attempt_id: id,
          model,
          provider: providerName(model),
          stage: "provider_request_pending",
        });
        const done = (async () => {
          let replies: string[];
          try {
            replies = await deps.generate(model, context);
          } catch (error) {
            if (error instanceof UnknownProviderResult) {
              emit("attempt_result_unknown", {
                ...(deps.topicId ? { topic_id: deps.topicId } : {}),
                attempt_id: id,
                model,
                provider: providerName(model),
                stage: "provider_request",
                error_class: "provider_result_unknown",
                duration_ms: Math.max(0, deps.now() - started),
              });
              return;
            }
            emit("attempt_failed", {
              ...(deps.topicId ? { topic_id: deps.topicId } : {}),
              attempt_id: id,
              model,
              provider: providerName(model),
              stage: "provider_or_validation",
              error_class: "provider_failure",
              duration_ms: Math.max(0, deps.now() - started),
            });
            await deps.fail(id).catch(() => {});
            return;
          }
          // A failed/ambiguous save must not cause regeneration or a failed-state overwrite.
          try {
            active.stage = "database_rpc_save";
            emit("save_started", {
              ...(deps.topicId ? { topic_id: deps.topicId } : {}),
              attempt_id: id,
              model,
              provider: providerName(model),
              stage: "database_rpc",
              duration_ms: Math.max(0, deps.now() - started),
            });
            await deps.save(id, replies);
            saved = true;
            emit("save_succeeded", {
              ...(deps.topicId ? { topic_id: deps.topicId } : {}),
              attempt_id: id,
              model,
              provider: providerName(model),
              stage: "database_rpc",
              duration_ms: Math.max(0, deps.now() - started),
            });
          } catch {
            emit("save_failed", {
              ...(deps.topicId ? { topic_id: deps.topicId } : {}),
              attempt_id: id,
              model,
              provider: providerName(model),
              stage: "database_rpc",
              error_class: "database_rpc_failure",
              duration_ms: Math.max(0, deps.now() - started),
            });
          }
        })().finally(() => {
          activeAttempts.delete(id);
          running.delete(id);
        });
        running.set(id, { started, done });
      };
    }
    return null;
  };
  try {
    // Reserve/start both without awaiting either provider response.
    const first = await prepare();
    let second: (() => void) | null = null;
    try {
      if (first) second = await prepare();
    } finally {
      first?.();
      second?.();
    }
    while (candidates.length && !saved) {
      const elapsed = running.size
        ? deps.now() - Math.max(...[...running.values()].map((v) => v.started))
        : 3000;
      if (elapsed >= 3000) {
        const start = await prepare();
        if (!start) break;
        start();
      } else await deps.pause(Math.min(100, 3000 - elapsed));
    }
  } finally {
    await Promise.allSettled([...running.values()].map((v) => v.done));
  }
}

export function parseTen(text: unknown): string[] {
  // Reuse the raw-control-character repair, but reject truncation/filtering.
  const replies = extractReplies(
    { candidates: [{ content: { parts: [{ text }] } }] },
    10,
    true,
  );
  if (replies.length !== 10) throw Error("invalid_count");
  return replies;
}

export { providerAvailable, PROVIDERS } from "./shared_provider.ts";

export async function generateFreeModel(
  model: Model,
  prompt: string,
  limiter: AiRateLimiter,
  fetcher = fetch,
  context?: AttemptContext,
  emit: (event: string, fields: Record<string, unknown>) => void = diagnostic,
): Promise<string[]> {
  const p = PROVIDERS[model];
  const started = performance.now();
  const base = {
    ...(context
      ? { topic_id: context.topicId, attempt_id: context.attemptId }
      : {}),
    model,
    provider: providerName(model),
  };
  if (!providerAvailable(model, limiter)) {
    emit("provider_request_skipped", {
      ...base,
      stage: "pre_request_validation",
      error_class: "provider_unavailable",
      duration_ms: Math.round(performance.now() - started),
    });
    throw Error("model_unavailable");
  }
  const { url, headers, body } = providerRequest(model, prompt, limiter);
  let serializedBody: string;
  try {
    serializedBody = JSON.stringify(body);
  } catch {
    emit("provider_request_failed", {
      ...base,
      stage: "pre_request_serialization",
      error_class: "request_serialization_failure",
      duration_ms: Math.round(performance.now() - started),
    });
    throw Error("provider_request_unavailable");
  }
  emit("provider_request_started", {
    ...base,
    stage: "provider_request",
    duration_ms: 0,
  });
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers,
      body: serializedBody,
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    const errorClass = safeErrorClass(error);
    emit("provider_request_failed", {
      ...base,
      stage: "provider_transport",
      error_class: errorClass,
      duration_ms: Math.round(performance.now() - started),
    });
    throw new UnknownProviderResult("provider_result_unknown");
  }
  const duration = Math.round(performance.now() - started);
  if (!response.ok) {
    const retryAfter = response.status === 429
      ? response.headers.get("retry-after")
      : null;
    const retryAfterSeconds = retryAfter && /^[0-9]{1,6}$/.test(retryAfter)
      ? Number(retryAfter)
      : retryAfter && Number.isFinite(Date.parse(retryAfter))
      ? Math.max(
        0,
        Math.min(
          1_000_000,
          Math.ceil(
            (Date.parse(retryAfter) - Date.now()) / 1000,
          ),
        ),
      )
      : undefined;
    emit("provider_http_error", {
      ...base,
      stage: "provider_response",
      error_class: "http_error",
      http_status: response.status,
      ...(retryAfterSeconds !== undefined
        ? { retry_after_seconds: retryAfterSeconds }
        : {}),
      duration_ms: duration,
    });
    if (response.status === 429) await limiter.cooldown(model, response);
    throw Error("provider_failed");
  }
  let result: Record<string, any>;
  try {
    result = await response.json();
  } catch {
    emit("provider_response_parse_failed", {
      ...base,
      stage: "response_parse",
      error_class: "response_parse_failure",
      http_status: response.status,
      duration_ms: Math.round(performance.now() - started),
    });
    throw Error("provider_response_parse_failed");
  }
  const text = p.kind === "google"
    ? result.candidates?.[0]?.content?.parts?.filter((
      p: { thought?: boolean },
    ) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("")
    : p.kind === "cloudflare"
    ? result.result?.response
    : result.choices?.[0]?.message?.content;
  try {
    const replies = parseTen(text);
    emit("provider_response_validated", {
      ...base,
      stage: "output_validation",
      http_status: response.status,
      result_count: replies.length,
      duration_ms: Math.round(performance.now() - started),
    });
    return replies;
  } catch {
    emit("provider_output_invalid", {
      ...base,
      stage: "output_validation",
      error_class: "comment_format_validation_failure",
      http_status: response.status,
      duration_ms: Math.round(performance.now() - started),
    });
    throw Error("invalid_count");
  }
}

type Claim = {
  status: string;
  chunkIndex?: number;
  retryAfterSeconds?: number;
  attempted?: string[];
  topic?: {
    title: string;
    description: string;
    subject: string;
    event: string;
    facts: string[];
  };
};
export class RouterStore {
  constructor(
    readonly env = (key: string) => Deno.env.get(key),
    readonly fetcher = fetch,
    readonly emit: typeof diagnostic = diagnostic,
  ) {}
  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const started = performance.now();
    const url = this.env("SUPABASE_URL");
    const key = this.env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw Error("store_unavailable");
    const topicId = typeof args.p_topic_id === "string"
      ? args.p_topic_id
      : undefined;
    const attemptId = typeof args.p_attempt_id === "string"
      ? args.p_attempt_id
      : undefined;
    const stage = name === "complete_shared_ai_attempt" &&
        args.p_replies !== undefined
      ? "database_rpc_save"
      : "database_rpc";
    const fields = {
      ...(topicId ? { topic_id: topicId } : {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
      rpc: name,
      stage,
    };
    let response: Response;
    try {
      response = await this.fetcher(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      this.emit("database_rpc_failed", {
        ...fields,
        error_class: safeErrorClass(error),
        duration_ms: Math.round(performance.now() - started),
      });
      throw Error("store_unavailable");
    }
    if (!response.ok) {
      this.emit("database_rpc_failed", {
        ...fields,
        error_class: "database_http_error",
        http_status: response.status,
        duration_ms: Math.round(performance.now() - started),
      });
      throw Error("store_unavailable");
    }
    if (response.status === 204) return undefined as T;
    try {
      return await response.json();
    } catch {
      this.emit("database_rpc_failed", {
        ...fields,
        error_class: "database_response_parse_failure",
        http_status: response.status,
        duration_ms: Math.round(performance.now() - started),
      });
      throw Error("store_unavailable");
    }
  }
  claim(topicId: string, owner: string) {
    return this.rpc<Claim>("claim_shared_ai_job", {
      p_topic_id: topicId,
      p_owner: owner,
    });
  }
}

export async function startSharedInitial(
  topicId: string,
  waitUntil: (task: Promise<unknown>) => void,
  singleModel?: RolloutModel,
  store = new RouterStore(),
  limiter = new AiRateLimiter(),
) {
  const owner = crypto.randomUUID();
  const claimStarted = performance.now();
  let claim: Claim;
  try {
    claim = await store.claim(topicId, owner);
    diagnostic("claim_succeeded", {
      topic_id: topicId,
      stage: "database_claim",
      duration_ms: Math.round(performance.now() - claimStarted),
      outcome: claim.status,
    });
  } catch {
    diagnostic("claim_failed", {
      topic_id: topicId,
      stage: "database_claim",
      error_class: "database_rpc_failure",
      duration_ms: Math.round(performance.now() - claimStarted),
    });
    throw Error("router_claim_failed");
  }
  if (claim.status !== "claimed") {
    return {
      status: claim.status,
      ...(claim.chunkIndex ? { chunkIndex: claim.chunkIndex } : {}),
      ...(claim.retryAfterSeconds
        ? { retryAfterSeconds: claim.retryAfterSeconds }
        : {}),
    };
  }
  const topic = claim.topic!;
  const input: AiRepliesRequest = {
    mode: "sharedAi",
    newsTitle: topic.title,
    articleBody: topic.description,
    count: 10,
    context: [],
    replyRelations: [],
    useTopicContext: Boolean(
      topic.subject && topic.event && topic.facts?.length,
    ),
    topicThreadTitle: topic.title,
    topicSubject: topic.subject,
    topicEvent: topic.event,
    topicFacts: topic.facts,
  };
  const prompt = buildPrompt(input);
  const inputTokens = new TextEncoder().encode(prompt).length + 128;
  diagnostic("router_task_started", {
    topic_id: topicId,
    stage: "router_processing",
  });
  const task = runSharedRouter({
    topicId,
    ...(singleModel ? { models: [singleModel] } : {}),
    now: Date.now,
    pause: (ms) => new Promise((r) => setTimeout(r, ms)),
    // A non-mutating observer must never claim/recover another owner's job.
    ready: async () =>
      await store.rpc<boolean>("shared_ai_chunk_ready", {
        p_topic_id: topicId,
      }),
    reserve: (model) =>
      providerAvailable(model, limiter)
        ? limiter.reserve(model, inputTokens, 1200)
        : Promise.resolve(false),
    begin: (model, id) =>
      store.rpc<boolean>("begin_shared_ai_attempt", {
        p_topic_id: topicId,
        p_owner: owner,
        p_model: model,
        p_attempt_id: id,
      }),
    generate: (model, context) =>
      generateFreeModel(model, prompt, limiter, fetch, {
        topicId,
        attemptId: context.attemptId,
      }),
    save: async (id, replies) => {
      await store.rpc("complete_shared_ai_attempt", {
        p_topic_id: topicId,
        p_attempt_id: id,
        p_replies: replies.map((text) => ({
          text,
          type: "ai",
          origin: "sharedAi",
          name: "名無しのAIさん",
          id: crypto.randomUUID(),
          replyTo: null,
        })),
      });
    },
    fail: async (id) => {
      await store.rpc("complete_shared_ai_attempt", {
        p_topic_id: topicId,
        p_attempt_id: id,
      });
    },
  }, claim.attempted).catch(() => {
    diagnostic("router_task_failed", {
      topic_id: topicId,
      stage: "router_processing",
      error_class: "processing_failure",
    });
  }).finally(async () => {
    diagnostic("router_task_finished", {
      topic_id: topicId,
      stage: "router_processing",
    });
    await store.rpc("finish_shared_ai_job", {
      p_topic_id: topicId,
      p_owner: owner,
    }).catch(() => {});
  });
  waitUntil(task);
  diagnostic("background_task_registered", {
    topic_id: topicId,
    stage: "wait_until_registration",
  });
  return { status: "running" };
}
