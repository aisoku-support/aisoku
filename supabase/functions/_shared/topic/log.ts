import { safeReadJson, type SupabaseConfig } from "./queue.ts";
import type { GemmaDiagnostics, GemmaStage2Attempt } from "./gemma.ts";
import type { Stage1AttemptLog } from "./stage1.ts";
import type { ArticleBodyResult } from "./article_body.ts";
import type { QuotaDiagnostic } from "../ai_rate_limit.ts";
import { topicConfig } from "./config.ts";

export type TopicObservabilityRow = {
  operation:
    | "stage1_attempt"
    | "stage2_attempt"
    | "vector_search"
    | "outbox_sync"
    | "article_body";
  status: "success" | "failure";
  batch_id?: string | null;
  article_id?: string | null;
  model?: string | null;
  attempt_no?: number | null;
  model_role?: "primary" | "fallback" | null;
  timeout_retry?: boolean | null;
  fallback_reason?: string | null;
  embedding_version?: string | null;
  duration_ms?: number | null;
  item_count?: number | null;
  error_type?: string | null;
  http_status?: number | null;
  article_body_method?: "none" | "readability" | null;
  article_body_readability?: "not_run" | "failed" | "success" | null;
  article_body_chars?: number | null;
  article_body_redirected?: boolean | null;
  diagnostic_details?: Record<string, unknown> | null;
};

export function safeTransportErrorType(error: unknown): string | null {
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  const code = String(value?.cause?.code ?? value?.code ?? "").toUpperCase();
  const name = error instanceof Error ? error.name : "";
  if (
    name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT"
  ) return "timeout";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) {
    return "dns_resolution_failed";
  }
  if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
    return "connection_failed";
  }
  if (["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(code)) {
    return "connection_interrupted";
  }
  if (error instanceof TypeError) return "network_error";
  return null;
}

function safeQuotaDetails(value?: QuotaDiagnostic | null) {
  if (!value) return null;
  return {
    reason: value.reason,
    scope: value.scope,
    axis: value.dimension ?? null,
    window: value.window ?? null,
    limit: value.limit ?? null,
    used: value.used ?? null,
    requested: value.requested ?? null,
    reserved: value.reserved ?? null,
    nextAvailableAt: value.nextAvailableAt == null
      ? null
      : new Date(value.nextAvailableAt).toISOString(),
  };
}

export function safeTopicOperationErrorType(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }
  const message = error instanceof Error ? error.message : "";
  const status = /HTTP failure status=(\d{3})/u.exec(message)?.[1];
  if (status) return `http_${status}`;
  if (error instanceof TypeError) return "network_error";
  if (/malformed JSON|invalid response|empty response/u.test(message)) {
    return "invalid_response";
  }
  return "request_failed";
}

export function safeTopicOperationHttpStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const status = /HTTP failure status=(\d{3})/u.exec(message)?.[1];
  return status ? Number(status) : null;
}

export async function saveTopicObservabilityRows(
  config: SupabaseConfig,
  rows: TopicObservabilityRow[],
  fetcher: typeof fetch = fetch,
  timeoutMs = 0,
) {
  if (!rows.length) return true;
  try {
    const response = await fetcher(
      `${config.url}/rest/v1/topic_observability_logs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.serviceRoleKey}`,
          apikey: config.serviceRoleKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(rows),
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      },
    );
    if (!response.ok) {
      console.error("[Topic] observability log save failure", {
        httpStatus: response.status,
      });
      return false;
    }
    await response.text();
    return true;
  } catch (error) {
    console.error("[Topic] observability log save failure", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

export async function saveStage1AttemptLogs(
  config: SupabaseConfig,
  batchId: string,
  attempts: Stage1AttemptLog[],
) {
  return await saveTopicObservabilityRows(
    config,
    attempts.map((attempt) => ({
      operation: "stage1_attempt",
      status: attempt.outcome,
      batch_id: batchId,
      model: attempt.model,
      attempt_no: attempt.attemptNo,
      model_role: attempt.role,
      timeout_retry: attempt.timeoutRetry,
      fallback_reason: attempt.fallbackReason,
      duration_ms: attempt.durationMs,
      error_type: attempt.errorType,
      http_status: attempt.httpStatus,
      diagnostic_details: {
        provider: "groq",
        model: attempt.model,
        apiSendState: attempt.apiSendState ?? "not_recorded",
        quota: safeQuotaDetails(attempt.quotaDiagnostic),
        transportErrorType: attempt.transportErrorType ?? null,
      },
    })),
  );
}

export async function saveArticleBodyObservability(
  config: SupabaseConfig,
  batchId: string,
  articleId: string,
  result: ArticleBodyResult,
) {
  return await saveTopicObservabilityRows(config, [{
    operation: "article_body",
    status: result.ok ? "success" : "failure",
    batch_id: batchId,
    article_id: articleId,
    duration_ms: result.durationMs,
    error_type: result.ok ? null : result.reason,
    http_status: result.httpStatus,
    article_body_method: result.extractionMethod,
    article_body_readability: result.ok ? "success" : result.readability,
    article_body_chars: result.chars,
    article_body_redirected: result.redirected,
    diagnostic_details: result.diagnostics
      ? {
        domain: result.diagnostics.domain,
        finalDomain: result.diagnostics.finalDomain,
        domParse: result.diagnostics.domParse,
        readabilityFailure: result.diagnostics.readabilityFailure,
        exceptionType: result.diagnostics.exceptionType,
        retryCount: result.diagnostics.retryCount,
        finalExclusionReason: result.ok ? null : result.reason,
      }
      : null,
  }]);
}

export async function saveStage2FailureObservability(
  config: SupabaseConfig,
  batchId: string,
  affectedArticleCount: number,
  error: unknown,
) {
  const errorValue = error as Error & {
    diagnostics?: { httpStatus?: number | null };
    httpStatus?: number | null;
    quotaDiagnostic?: QuotaDiagnostic | null;
    apiSendState?: string;
    model?: string;
    elapsedMs?: number;
  };
  const httpStatus = errorValue?.httpStatus ??
    errorValue?.diagnostics?.httpStatus ??
    safeTopicOperationHttpStatus(error);
  const apiSendState = errorValue?.apiSendState ??
    (errorValue?.quotaDiagnostic
      ? "blocked_before_send"
      : httpStatus != null
      ? "response_received"
      : "send_attempted_no_response");
  return await saveTopicObservabilityRows(
    config,
    [{
      operation: "stage2_attempt",
      status: "failure",
      batch_id: batchId,
      model: topicConfig.gemmaModel,
      duration_ms: Number.isFinite(errorValue?.elapsedMs)
        ? errorValue.elapsedMs
        : null,
      error_type: safeTopicOperationErrorType(error),
      http_status: httpStatus,
      diagnostic_details: {
        provider: "google",
        model: errorValue?.model || topicConfig.gemmaModel,
        apiSendState,
        retryCount: 0,
        affectedArticleCount,
        quota: safeQuotaDetails(errorValue?.quotaDiagnostic),
        transportErrorType: safeTransportErrorType(error),
      },
    }],
    fetch,
    5000,
  );
}

export async function saveStage2AttemptObservability(
  config: SupabaseConfig,
  batchId: string,
  articleId: string,
  attempts: GemmaStage2Attempt[],
  options: {
    finalResult: "success" | "failure" | "deferred";
    retryCount: number;
    finalHttpStatus: number | null;
    quotaRetryStopped?: boolean;
    scheduledAt?: string | null;
    rateLimitType?: string | null;
    quotaDiagnostic?: QuotaDiagnostic | null;
  },
) {
  const firstHttpError = attempts.find((attempt) =>
    attempt.httpStatus !== null &&
    (attempt.httpStatus < 200 || attempt.httpStatus >= 300)
  );
  return await saveTopicObservabilityRows(
    config,
    attempts.map((attempt) => {
      const failedAttempt = attempt.quotaBlocked ||
        Boolean(attempt.errorType) ||
        (attempt.httpStatus !== null &&
          (attempt.httpStatus < 200 || attempt.httpStatus >= 300));
      return {
        operation: "stage2_attempt" as const,
        status: failedAttempt ? "failure" as const : "success" as const,
        batch_id: batchId,
        article_id: articleId,
        model: topicConfig.gemmaModel,
        attempt_no: attempt.attemptNo,
        error_type: attempt.errorType,
        http_status: attempt.httpStatus,
        diagnostic_details: {
          provider: "google",
          retryCount: options.retryCount,
          retryAfterMs: attempt.retryAfterMs,
          retryWaitMs: attempt.waitMs,
          firstHttpError: firstHttpError
            ? {
              status: firstHttpError.httpStatus,
              errorType: firstHttpError.errorType,
            }
            : null,
          finalResult: options.finalResult,
          finalHttpStatus: options.finalHttpStatus,
          quotaRetryStopped: options.quotaRetryStopped ?? false,
          quota: safeQuotaDetails(options.quotaDiagnostic),
          rateLimitType: options.rateLimitType ?? attempt.rateLimitType ?? null,
          scheduledAt: options.scheduledAt ?? null,
        },
      };
    }),
    fetch,
    5000,
  );
}

export type TopicLogStatus =
  | "failed_db"
  | "duplicate_skipped"
  | "excluded"
  | "failed_gemma"
  | "failed_embedding";

export async function savePreFilterLog(
  config: SupabaseConfig,
  input: {
    articleId: string;
    batchId: string;
    status:
      | "excluded_missing_title"
      | "excluded_missing_description"
      | "excluded_invalid_article"
      | "excluded"
      | "already_processed";
    stage?: string;
    errorType?: string;
    errorMessage?: string;
  },
) {
  const response = await fetch(`${config.url}/rest/v1/topic_processing_logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      article_id: input.articleId,
      batch_id: input.batchId,
      status: input.status,
      stage: input.stage ?? "pre_filter",
      error_type: input.errorType ?? null,
      error_message: input.errorMessage?.slice(0, 500) ?? null,
    }),
  });
  await safeReadJson(response, "Topic pre-filter log save", {
    requireBody: false,
  });
}

export async function saveProcessingError(
  config: SupabaseConfig,
  input: {
    articleId: string;
    batchId: string;
    stage: string;
    errorType: string;
    message: string;
  },
) {
  const response = await fetch(`${config.url}/rest/v1/topic_processing_logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      article_id: input.articleId,
      batch_id: input.batchId,
      status: "failed_db" satisfies TopicLogStatus,
      stage: input.stage,
      error_type: input.errorType,
      error_message: input.message.slice(0, 500),
    }),
  });
  await safeReadJson(response, "Topic log save", { requireBody: false });
}

export async function saveGemmaLog(
  config: SupabaseConfig,
  input: {
    articleId: string;
    batchId: string;
    status: "excluded" | "failed_gemma" | "new_topic";
    stage?: "gemma_stage1" | "gemma_stage2";
    errorType?: string;
    message?: string;
    sourceCategory?: string;
    classifiedCategory?: string;
    diagnostics?: GemmaDiagnostics;
  },
) {
  const response = await fetch(`${config.url}/rest/v1/topic_processing_logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      article_id: input.articleId,
      batch_id: input.batchId,
      status: input.status,
      stage: input.stage ?? "gemma_stage1",
      error_type: input.errorType ?? null,
      error_message: (input.message ?? "").slice(0, 500),
      source_category: input.sourceCategory ? [input.sourceCategory] : null,
      classified_category: input.classifiedCategory ?? null,
      gemma_http_status: input.diagnostics?.httpStatus ?? null,
      gemma_finish_reason: input.diagnostics?.finishReason ?? null,
      gemma_block_reason: input.diagnostics?.blockReason ?? null,
      gemma_api_completed: input.diagnostics?.apiCompleted ?? null,
      gemma_response_chars: input.diagnostics?.responseChars ?? null,
      gemma_response_tail_preview: null,
      gemma_output_tokens: input.diagnostics?.outputTokens ?? null,
      gemma_prompt_tokens: input.diagnostics?.promptTokens ?? null,
      gemma_thinking_tokens: input.diagnostics?.thinkingTokens ?? null,
      gemma_api_duration_ms: input.diagnostics?.apiDurationMs ?? null,
    }),
  });
  await safeReadJson(response, "Topic gemma log save", { requireBody: false });
}

export async function saveGemmaInvalidJsonDiagnostics(
  config: SupabaseConfig,
  articleId: string,
  batchId: string,
  diagnostics: GemmaDiagnostics,
) {
  const query =
    `batch_id=eq.${encodeURIComponent(batchId)}&article_id=eq.${
      encodeURIComponent(articleId)
    }` +
    "&status=eq.failed_gemma&stage=eq.topic_commit&error_type=eq.invalid_json";
  const response = await fetch(
    `${config.url}/rest/v1/topic_processing_logs?${query}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        gemma_http_status: diagnostics.httpStatus,
        gemma_finish_reason: diagnostics.finishReason,
        gemma_block_reason: diagnostics.blockReason,
        gemma_api_completed: diagnostics.apiCompleted,
        gemma_response_chars: diagnostics.responseChars,
        gemma_response_tail_preview: null,
        gemma_output_tokens: diagnostics.outputTokens,
        gemma_prompt_tokens: diagnostics.promptTokens,
        gemma_thinking_tokens: diagnostics.thinkingTokens,
        gemma_api_duration_ms: diagnostics.apiDurationMs,
      }),
    },
  );
  const rows = await safeReadJson<Array<{ id: string }>>(
    response,
    "Topic Gemma invalid JSON diagnostics save",
  );
  if (rows.length !== 1) {
    throw new Error(
      `Topic Gemma invalid JSON diagnostics save matched=${rows.length}`,
    );
  }
}

export async function updateGemmaDuration(
  config: SupabaseConfig,
  articleIds: string[],
  batchId: string,
  durationMs: number,
) {
  if (articleIds.length === 0) return;
  const response = await fetch(
    `${config.url}/rest/v1/topic_processing_logs?batch_id=eq.${
      encodeURIComponent(batchId)
    }&article_id=in.(${articleIds.map(encodeURIComponent).join(",")})`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ duration_ms: durationMs }),
    },
  );
  await safeReadJson(response, "Topic Gemma duration save", {
    requireBody: false,
  });
}

export async function updateThreadTitleLog(
  config: SupabaseConfig,
  articleId: string,
  batchId: string,
  input: { status: string; attempts: number; durationMs: number },
) {
  const query = `batch_id=eq.${encodeURIComponent(batchId)}&article_id=eq.${
    encodeURIComponent(articleId)
  }&status=eq.new_topic`;
  const response = await fetch(
    `${config.url}/rest/v1/topic_processing_logs?${query}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        thread_title_status: input.status,
        thread_title_attempts: input.attempts,
        thread_title_duration_ms: input.durationMs,
      }),
    },
  );
  await safeReadJson(response, "Topic thread title log save", {
    requireBody: false,
  });
}

export async function saveEmbeddingFailureLog(
  config: SupabaseConfig,
  input: {
    articleId: string;
    batchId: string;
    errorType: string;
    message?: string;
    classifiedCategory?: string;
  },
) {
  const response = await fetch(`${config.url}/rest/v1/topic_processing_logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      article_id: input.articleId,
      batch_id: input.batchId,
      status: "failed_embedding",
      stage: "embedding",
      error_type: input.errorType,
      error_message: (input.message ?? input.errorType).slice(0, 500),
      classified_category: input.classifiedCategory ?? null,
    }),
  });
  await safeReadJson(response, "Topic embedding failure log save", {
    requireBody: false,
  });
}
