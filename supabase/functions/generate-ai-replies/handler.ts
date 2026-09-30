import { withSupabase } from "jsr:@supabase/server@1.7.0";
import { startSharedInitial } from "./shared_router.ts";
import { sharedRouterDecision } from "./shared_router_rollout.ts";
import { BudgetExpired, GenerationBudget } from "./generation_budget.ts";
import {
  generateSharedChunkParallel,
  type SharedChunkTarget,
} from "./parallel_router.ts";
import {
  type AiRepliesRequest,
  generateReplies,
  InvalidRequestError,
  ProviderError,
  validateRequest,
} from "./ai_replies.ts";

type PublishableEnv = {
  url: string;
  publishableKeys: Record<string, string>;
};

type HandlerDependencies = {
  env?: PublishableEnv;
  generate?: (
    input: AiRepliesRequest,
    diagnosticId?: string,
    budget?: GenerationBudget,
  ) => Promise<string[]>;
  sharedBudget?: () => GenerationBudget;
  startInitial?: typeof startSharedInitial;
  generateSharedChunk?: typeof generateSharedChunkParallel;
  sharedRouterRollout?: string;
  waitUntil?: (task: Promise<unknown>) => void;
};

const json = (
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

const requestDiagnosticId = (request: Request) => {
  const supplied = request.headers.get("x-ai-diagnostic-id");
  return supplied &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(supplied)
    ? supplied
    : crypto.randomUUID();
};

const safeDiagnosticFields = (error: unknown) => {
  if (error instanceof BudgetExpired) {
    return {
      stage: "request_deadline",
      error_class: "request_deadline",
      timeout: true,
    };
  }
  if (!(error instanceof ProviderError)) {
    return { stage: "function_handler", error_class: "unexpected_error" };
  }
  const source = error.diagnostic;
  const allowedStages = new Set([
    "provider_call_start",
    "provider_transport",
    "timeout",
    "provider_exception",
    "provider_response",
    "provider_response_parse",
    "provider_response_validation",
    "request_deadline",
  ]);
  const allowedErrors = new Set([
    "missing_secret",
    "timeout",
    "fetch_failed",
    "http_error",
    "quota_unavailable",
    "invalid_json",
    "invalid_response",
    "request_deadline",
  ]);
  const result: Record<string, unknown> = {
    stage: typeof source.stage === "string" && allowedStages.has(source.stage)
      ? source.stage
      : "provider_or_validation",
    error_class: typeof source.exception === "string" &&
        allowedErrors.has(source.exception)
      ? source.exception
      : "provider_failure",
  };
  if (typeof source.status === "number" || source.status === null) {
    result.provider_status = source.status;
  }
  if (typeof source.timeout === "boolean") result.timeout = source.timeout;
  if (typeof source.duration_ms === "number") {
    result.duration_ms = source.duration_ms;
  }
  return result;
};

export function createGenerateAiRepliesHandler(
  dependencies: HandlerDependencies = {},
) {
  const config = {
    auth: "publishable" as const,
    cors: "disabled" as const,
    ...(dependencies.env ? { env: dependencies.env } : {}),
  };
  const generate = dependencies.generate ?? generateReplies;

  return withSupabase(config, async (request: Request) => {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    try {
      const raw = await request.json();
      if (raw?.mode === "sharedInitial") {
        if (
          typeof raw.topicId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(raw.topicId)
        ) {
          throw new InvalidRequestError("invalid_topic_id");
        }
        const rollout = Object.hasOwn(dependencies, "sharedRouterRollout")
          ? dependencies.sharedRouterRollout
          : Deno.env.get("AI_SHARED_ROUTER_ROLLOUT");
        const decision = sharedRouterDecision(raw.topicId, rollout);
        if (!decision.allowed) {
          return json({ status: "deferred", retryAfterSeconds: 60 }, 202);
        }
        const waitUntil = dependencies.waitUntil ?? ((globalThis as unknown as {
          EdgeRuntime?: { waitUntil: (task: Promise<unknown>) => void };
        }).EdgeRuntime?.waitUntil);
        if (!waitUntil) return json({ error: "background_unavailable" }, 503);
        const result = await (dependencies.startInitial ?? startSharedInitial)(
          raw.topicId,
          waitUntil,
          decision.singleModel,
        );
        return json(
          result,
          result.status === "not_found"
            ? 404
            : ["ready", "exhausted"].includes(result.status)
            ? 200
            : 202,
        );
      }
      const input = validateRequest(raw);
      if (input.mode !== "sharedAi") {
        const replies = await generate(input);
        return json({ replies }, 200);
      }
      const diagnosticId = requestDiagnosticId(request);
      const requestStarted = performance.now();
      const targetKeys = ["articleUrl", "chunkIndex", "conversationPattern"];
      const hasTarget = targetKeys.some((key) => Object.hasOwn(raw, key));
      if (hasTarget) {
        if (!targetKeys.every((key) => Object.hasOwn(raw, key))) {
          throw new InvalidRequestError("incomplete_shared_chunk_target");
        }
        const target: SharedChunkTarget = {
          newsUrl: raw.articleUrl,
          chunkIndex: raw.chunkIndex,
          conversationPattern: raw.conversationPattern,
        };
        if (
          typeof target.newsUrl !== "string" || target.newsUrl.length > 4000 ||
          !Number.isInteger(target.chunkIndex) || target.chunkIndex < 2 ||
          typeof target.conversationPattern !== "string" ||
          ![
            "independent",
            "singleReply",
            "doubleReply",
            "chain3",
            "branch",
            "mixed",
          ].includes(target.conversationPattern)
        ) throw new InvalidRequestError("invalid_shared_chunk_target");
        const waitUntil = dependencies.waitUntil ?? ((globalThis as unknown as {
          EdgeRuntime?: { waitUntil: (task: Promise<unknown>) => void };
        }).EdgeRuntime?.waitUntil);
        if (!waitUntil) return json({ error: "background_unavailable" }, 503);
        try {
          const result = await (dependencies.generateSharedChunk ??
            generateSharedChunkParallel)(
              input,
              target,
              diagnosticId,
              waitUntil,
            );
          console.log(`[AiReplies] ${
            JSON.stringify({
              event: "request_completed",
              diagnostic_id: diagnosticId,
              stage: "function_response",
              function_status: 200,
              chunk_index: result.chunkIndex,
              duration_ms: Math.round(performance.now() - requestStarted),
            })
          }`);
          return json(
            { replies: result.replies, chunkIndex: result.chunkIndex },
            200,
            { "X-AI-Diagnostic-ID": diagnosticId },
          );
        } catch (error) {
          console.log(`[AiReplies] ${
            JSON.stringify({
              event: "request_failed",
              diagnostic_id: diagnosticId,
              stage: "shared_chunk_generation",
              error_class: error instanceof Error
                ? error.message
                : "unexpected_error",
              function_status: 502,
              request_duration_ms: Math.round(
                performance.now() - requestStarted,
              ),
            })
          }`);
          return json({ error: "ai_generation_failed", diagnosticId }, 502, {
            "X-AI-Diagnostic-ID": diagnosticId,
          });
        }
      }
      const budget = dependencies.sharedBudget?.() ?? new GenerationBudget();
      console.log(`[AiReplies] ${
        JSON.stringify({
          event: "request_started",
          diagnostic_id: diagnosticId,
          mode: "sharedAi",
        })
      }`);
      try {
        return await budget.run(async () => {
          const replies = await (dependencies.generate ?? ((value, id) =>
            generateReplies(value, undefined, fetch, id, { budget })))(
              input,
              diagnosticId,
              budget,
            );
          budget.check();
          console.log(`[AiReplies] ${
            JSON.stringify({
              event: "request_completed",
              diagnostic_id: diagnosticId,
              stage: "function_response",
              function_status: 200,
              duration_ms: Math.round(performance.now() - requestStarted),
            })
          }`);
          return json({ replies }, 200, { "X-AI-Diagnostic-ID": diagnosticId });
        });
      } catch (error) {
        console.log(`[AiReplies] ${
          JSON.stringify({
            event: "request_failed",
            diagnostic_id: diagnosticId,
            ...safeDiagnosticFields(error),
            function_status: 502,
            request_duration_ms: Math.round(performance.now() - requestStarted),
          })
        }`);
        return json(
          { error: "ai_generation_failed", diagnosticId },
          502,
          { "X-AI-Diagnostic-ID": diagnosticId },
        );
      } finally {
        budget.controller.abort();
      }
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return json({ error: "invalid_request" }, 400);
      }
      return json({ error: "ai_generation_failed" }, 502);
    }
  });
}
