import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { QuotaReservationError } from "../_shared/ai_rate_limit.ts";
import {
  embeddingModelForCategory,
  topicConfig,
  withTopicProcessingAuth,
} from "../_shared/topic/config.ts";
import {
  createUpstashClient,
  loadClaimedArticles,
} from "../_shared/topic/article_store.ts";
import {
  claimQueue,
  deferQueueArticle,
  markExternalApiStarted,
  markProcessingStarted,
  markTerminal,
  type SupabaseConfig,
  supabaseConfigFromEnv,
} from "../_shared/topic/queue.ts";
import {
  saveArticleBodyObservability,
  saveGemmaInvalidJsonDiagnostics,
  saveGemmaLog,
  savePreFilterLog,
  saveProcessingError,
  saveStage1AttemptLogs,
  saveStage2AttemptObservability,
  updateGemmaDuration,
} from "../_shared/topic/log.ts";
import {
  decideStage2Retry,
  type GemmaDiagnostics,
  type GemmaRequestError,
  generateFactsWithGemma,
} from "../_shared/topic/gemma.ts";
import { classifyStage1 } from "../_shared/topic/stage1.ts";
import {
  embedTopicResults,
  type TopicEmbeddingResult,
} from "../_shared/topic/embedding.ts";
import {
  commitMerge,
  commitNewTopic,
  commitSingleton,
  fallbackCategory,
  finalizeExcluded,
  forEachSequential,
  isAlreadyProcessed,
  matchRecentTopic,
  shouldMerge,
} from "../_shared/topic/topic_store.ts";
import {
  type GemmaResult,
  TOPIC_CATEGORIES,
} from "../_shared/topic/gemma_parser.ts";
import type { TopicArticle } from "../_shared/topic/types.ts";
import {
  beginEmbeddingAttempt,
  completeEmbeddingProbe,
  markRpdExhausted,
} from "../_shared/topic/quota.ts";
import {
  publishTopicListCache,
  recordTopicCompletionForCache,
} from "../_shared/topic/topic_cache.ts";
import {
  notifyTopicPregen,
  processThreadTitleBatch,
} from "../_shared/topic/thread_title_queue.ts";
import { extractArticleBody } from "../_shared/topic/article_body.ts";
import { detectCommentDominatedBody } from "../_shared/topic/comment_structure_filter.ts";
import {
  queryTopicVectorWithLog,
  syncTopicVectorOutbox,
  TOPIC_VECTOR_VERSION,
} from "../_shared/topic/upstash_vector.ts";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function apiErrorType(error: unknown) {
  if (error instanceof QuotaReservationError) return error.code;
  if (error instanceof SyntaxError) return "invalid_json";
  if (
    error instanceof Error && error.message === "Gemma facts stream incomplete"
  ) {
    return "incomplete_stream";
  }
  if (error instanceof Error && error.message === "quota_unavailable") {
    return "quota_unavailable";
  }
  const status = (error as Error & { status?: number }).status;
  return status === 429
    ? "rate_limit"
    : status && status >= 500
    ? "http_5xx"
    : status && status >= 400
    ? "http_4xx"
    : error instanceof DOMException && error.name === "TimeoutError"
    ? "timeout"
    : "network_error";
}
async function failDb(
  config: SupabaseConfig,
  articleId: string,
  batchId: string,
  stage: string,
  errorType = "topic_rpc_failed",
) {
  try {
    await saveProcessingError(config, {
      articleId,
      batchId,
      stage,
      errorType,
      message: errorType,
    });
  } catch { /* avoid recursive fallback */ }
  try {
    await markTerminal(
      config,
      articleId,
      "failed_db",
      new Date().toISOString(),
    );
  } catch { /* DB outage may prevent terminal update */ }
}

Deno.serve(withTopicProcessingAuth(
  () => Deno.env.get(topicConfig.authSecretEnv),
  async (request: Request) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const workerId = crypto.randomUUID(),
      claimId = crypto.randomUUID(),
      batchId = crypto.randomUUID();
    let config: SupabaseConfig;
    let stage = "init";
    try {
      config = supabaseConfigFromEnv();
      const operation = await request.clone().json().catch(() => null) as {
        action?: unknown;
        topic_id?: unknown;
      } | null;
      if (operation?.action === "notify_topic_pregen_once") {
        if (
          typeof operation.topic_id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(operation.topic_id)
        ) {
          return json({ status: "invalid_topic_id" }, 400);
        }
        const notification = await notifyTopicPregen(
          config,
          [operation.topic_id],
          Deno.env.get("TOPIC_PREGEN_URL"),
          Deno.env.get("TOPIC_PREGEN_NOTIFICATION_SECRET"),
        );
        console.log("[TopicPregen] one-time replay outcome", {
          status: notification.status,
          httpStatus: notification.httpStatus ?? null,
        });
        const status = notification.status === "notified"
          ? 200
          : notification.status === "no_candidate"
          ? 409
          : 503;
        return json({
          status: notification.status,
          httpStatus: notification.httpStatus ?? null,
        }, status);
      }
      if (
        operation?.action === "topic_vector_outbox_status" ||
        operation?.action === "enqueue_recent_topic_vectors"
      ) {
        const rpcName = operation.action === "topic_vector_outbox_status"
          ? "topic_vector_outbox_status"
          : "enqueue_recent_topic_vectors";
        const response = await fetch(`${config.url}/rest/v1/rpc/${rpcName}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            operation.action === "enqueue_recent_topic_vectors"
              ? { p_lookback_hours: 24 }
              : {},
          ),
        });
        const body = await response.text();
        if (!response.ok) {
          throw new Error(
            `Topic vector migration RPC failed status=${response.status}`,
          );
        }
        return new Response(body, {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (operation?.action === "sync_topic_vector_outbox") {
        const vectorUrl = Deno.env.get("UPSTASH_VECTOR_REST_URL"),
          vectorToken = Deno.env.get("UPSTASH_VECTOR_REST_TOKEN");
        if (!vectorUrl || !vectorToken) {
          throw new Error("Upstash Vector configuration missing");
        }
        return json({
          status: "synced",
          synced: await syncTopicVectorOutbox(config, vectorUrl, vectorToken),
        });
      }
      stage = "queue_claim";
      const queue = await claimQueue(
        config,
        workerId,
        claimId,
        topicConfig.batchSize,
        topicConfig.claimLeaseSeconds,
      );
      if (queue.length === 0) {
        stage = "thread_title_batch";
        const titleBatchProcessed = await processThreadTitleBatch(
          config,
          Deno.env.get(topicConfig.gemmaApiKeyEnv) ?? "",
        );
        return json({
          status: "idle",
          claimed: 0,
          titleBatchProcessed,
          batchId,
        });
      }
      stage = "marking_processing_started";
      await markProcessingStarted(
        config,
        claimId,
        queue.map((item) => item.article_id),
        new Date().toISOString(),
      );
      const redisUrl = Deno.env.get("UPSTASH_REDIS_REST_URL"),
        redisToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
      if (!redisUrl || !redisToken) {
        throw new Error("Upstash configuration missing");
      }
      stage = "upstash_article_load";
      const loaded = await loadClaimedArticles(
        createUpstashClient(redisUrl, redisToken),
        queue.map((item) => item.article_id),
      );
      const articles: TopicArticle[] = [];
      for (const result of loaded) {
        if ("article" in result) articles.push(result.article);
        else {
          const status = result.errorType === "missing_title"
            ? "excluded_missing_title"
            : result.errorType === "missing_description"
            ? "excluded_missing_description"
            : "excluded_invalid_article";
          try {
            await savePreFilterLog(config, {
              articleId: result.articleId,
              batchId,
              status,
            });
            await markTerminal(
              config,
              result.articleId,
              status,
              new Date().toISOString(),
            );
          } catch {
            await failDb(
              config,
              result.articleId,
              batchId,
              "article_store",
              result.errorType,
            );
          }
        }
      }
      if (articles.length === 0) {
        return json({
          status: "ok",
          claimed: queue.length,
          loaded: 0,
          batchId,
        });
      }
      const eligible: TopicArticle[] = [];
      for (const article of articles) {
        const status = !article.title?.trim()
          ? "excluded_missing_title"
          : !article.article_id?.trim()
          ? "excluded_invalid_article"
          : null;
        if (!status && await isAlreadyProcessed(config, article.article_id)) {
          await savePreFilterLog(config, {
            articleId: article.article_id,
            batchId,
            status: "already_processed",
          });
          await markTerminal(
            config,
            article.article_id,
            "already_processed",
            new Date().toISOString(),
          );
          continue;
        }
        if (!status) {
          eligible.push(article);
          continue;
        }
        await savePreFilterLog(config, {
          articleId: article.article_id,
          batchId,
          status,
        });
        await markTerminal(
          config,
          article.article_id,
          status,
          new Date().toISOString(),
        );
      }
      if (eligible.length === 0) {
        return json({
          status: "ok",
          claimed: queue.length,
          loaded: articles.length,
          batchId,
        });
      }
      const withBody: TopicArticle[] = [];
      for (const article of eligible) {
        const body = await extractArticleBody(article.url);
        await saveArticleBodyObservability(
          config,
          batchId,
          article.article_id,
          body,
        );
        if (!body.ok) {
          console.log("[Topic] Article body excluded", {
            articleId: article.article_id,
            reason: body.reason,
            method: body.extractionMethod,
            redirected: body.redirected,
            readability: body.readability,
            chars: body.chars,
            durationMs: body.durationMs,
            httpStatus: body.httpStatus,
          });
          try {
            await savePreFilterLog(config, {
              articleId: article.article_id,
              batchId,
              status: "excluded_invalid_article",
              stage: "article_body",
              errorType: body.reason,
            });
            await markTerminal(
              config,
              article.article_id,
              "excluded_invalid_article",
              new Date().toISOString(),
            );
          } catch (error) {
            await failDb(
              config,
              article.article_id,
              batchId,
              "article_body",
              error instanceof Error ? error.name : "unknown",
            );
          }
          continue;
        }
        console.log("[Topic] Article body ready", {
          articleId: article.article_id,
          fetch: "success",
          method: body.extractionMethod,
          readability: "success",
          chars: body.chars,
          redirected: body.redirected,
          durationMs: body.durationMs,
        });
        const commentStructure = detectCommentDominatedBody(body.body);
        if (commentStructure.excluded) {
          console.log("[Topic] Article excluded by repeated post headers", {
            articleId: article.article_id,
            postCandidates: commentStructure.postCandidates,
            repeatedHeaders: commentStructure.repeatedHeaders,
          });
          try {
            await savePreFilterLog(config, {
              articleId: article.article_id,
              batchId,
              status: "excluded",
              stage: "comment_structure",
              errorType: "repeated_post_headers",
              errorMessage:
                `repeated_post_headers=${commentStructure.repeatedHeaders}; ` +
                `post_candidates=${commentStructure.postCandidates}`,
            });
            await markTerminal(
              config,
              article.article_id,
              "excluded",
              new Date().toISOString(),
            );
          } catch (error) {
            await failDb(
              config,
              article.article_id,
              batchId,
              "comment_structure",
              error instanceof Error ? error.name : "unknown",
            );
          }
          continue;
        }
        withBody.push({ ...article, cleaned_body: body.body });
      }
      if (withBody.length === 0) {
        return json({
          status: "ok",
          claimed: queue.length,
          loaded: articles.length,
          eligible: 0,
          batchId,
        });
      }
      articles.length = 0;
      articles.push(...withBody);
      stage = "external_api_started";
      await markExternalApiStarted(
        config,
        claimId,
        articles.map((a) => a.article_id),
        new Date().toISOString(),
      );


      let gemmaResults: GemmaResult[] = [],
        gemmaFailures: Array<{ articleId: string; errorType: string }> = [],
        gemmaElapsedMs: number | null = null,
        gemmaDiagnostics: GemmaDiagnostics | undefined;
      try {
          const stage1 = await classifyStage1(articles);
          await saveStage1AttemptLogs(config, batchId, stage1.attempts);
          gemmaResults = stage1.results;
          gemmaFailures = stage1.failures.filter((f) =>
            articles.some((a) => a.article_id === f.articleId)
          );
          gemmaElapsedMs = stage1.elapsedMs;
          gemmaDiagnostics = stage1.diagnostics;
          for (const result of gemmaResults) {
            try {
              await saveGemmaLog(config, {
                articleId: result.article_id,
                batchId,
                status: "new_topic",
                stage: "gemma_stage1",
                classifiedCategory: result.category,
                diagnostics: gemmaDiagnostics,
              });
            } catch { /* diagnostic log must not stop processing */ }
          }
        } catch (error) {
          gemmaElapsedMs =
            typeof (error as GemmaRequestError).elapsedMs === "number"
              ? (error as GemmaRequestError).elapsedMs
              : null;
          gemmaFailures = articles.map((a) => ({
            articleId: a.article_id,
            errorType: apiErrorType(error),
          }));
          const requestError = error as GemmaRequestError;
          await saveStage1AttemptLogs(
            config,
            batchId,
            (error as GemmaRequestError & {
              attempts?:
                import("../_shared/topic/stage1.ts").Stage1AttemptLog[];
            }).attempts ?? [],
          );
          gemmaDiagnostics = requestError.diagnostics;
          for (const article of articles) {
            try {
              await saveGemmaLog(config, {
                articleId: article.article_id,
                batchId,
                status: "failed_gemma",
                stage: "gemma_stage1",
                errorType: apiErrorType(error),
                message: `model=${
                  requestError.model ?? "groq_stage1"
                } input_length=${
                  requestError.inputLength ?? "unknown"
                } elapsed_ms=${gemmaElapsedMs ?? "unknown"} http_status=${
                  requestError.httpStatus ?? "none"
                }`,
                sourceCategory: article.newsdata_categories[0],
                diagnostics: gemmaDiagnostics,
              });
            } catch (logError) {
              console.error("[Topic] Gemma diagnostic log save failure", {
                articleId: article.article_id,
                batchId,
                errorType: apiErrorType(error),
                type: logError instanceof Error ? logError.name : "unknown",
                message: logError instanceof Error
                  ? logError.message.slice(0, 160)
                  : "unknown",
              });
            }
          }
        }

        // Stage 2 is a separate request and only runs for successful, non-excluded Stage 1 results.
        const stage2Input = gemmaResults
          .filter((r) => r.category !== TOPIC_CATEGORIES[5])
          .map((r) => ({
            ...articles.find((a) => a.article_id === r.article_id)!,
            subject: r.subject,
            event: r.event,
            category: r.category,
          }));
        if (stage2Input.length > 0) {
          try {
            const stage2Article = stage2Input[0];
            const queueItem = queue.find((item) =>
              item.article_id === stage2Article.article_id
            );
            const priorRequestCount = Math.min(
              4,
              Math.max(0, queueItem?.stage2_attempt_count ?? 0),
            );
            const facts = await generateFactsWithGemma(
              stage2Input,
              undefined,
              undefined,
              undefined,
              {
                priorRequestCount,
                inspectQuota: async (inputTokens, outputTokens) => {
                  return null;
                },
              },
            );
            const successful = facts.failures.length === 0;
            const lastAttempt = facts.attempts?.at(-1);
            await saveStage2AttemptObservability(
              config,
              batchId,
              stage2Article.article_id,
              facts.attempts ?? [],
              {
                finalResult: successful ? "success" : "failure",
                retryCount: Math.max(
                  0,
                  (lastAttempt?.attemptNo ?? priorRequestCount) - 1,
                ),
                finalHttpStatus: facts.diagnostics.httpStatus,
              },
            );
            for (const article of stage2Input) {
              const factResult = facts.results.find((r) =>
                r.article_id === article.article_id
              );
              await saveGemmaLog(config, {
                articleId: article.article_id,
                batchId,
                status: "new_topic",
                stage: "gemma_stage2",
                errorType: factResult
                  ? undefined
                  : facts.failures.find((f) =>
                    f.articleId === article.article_id
                  )
                    ?.errorType ?? "missing_article_result",
                classifiedCategory: article.category,
                diagnostics: facts.diagnostics,
              });
            }
            const failed = new Set(facts.failures.map((f) => f.articleId));
            gemmaResults = gemmaResults.map((r) => {
              const f = facts.results.find((x) =>
                x.article_id === r.article_id
              );
              return f
                ? { ...r, facts: f.facts }
                : failed.has(r.article_id)
                ? { ...r, facts: [] }
                : r;
            });
          } catch (error) {
            const requestError = error as GemmaRequestError;
            const stage2Article = stage2Input[0];
            const queueItem = queue.find((item) =>
              item.article_id === stage2Article.article_id
            );
            const priorRequestCount = Math.min(
              4,
              Math.max(0, queueItem?.stage2_attempt_count ?? 0),
            );
            const attempts = requestError.attempts ?? [];
            const retryDecision = decideStage2Retry(
              requestError,
              priorRequestCount,
            );
            const nextRequestCount = retryDecision.nextRequestCount;
            let scheduledAt: string | null = null;
            if (retryDecision.action === "defer") {
              scheduledAt = new Date(retryDecision.availableAt).toISOString();
              try {
                await deferQueueArticle(
                  config,
                  claimId,
                  stage2Article.article_id,
                  scheduledAt,
                  priorRequestCount,
                  nextRequestCount,
                );
                await saveStage2AttemptObservability(
                  config,
                  batchId,
                  stage2Article.article_id,
                  attempts,
                  {
                    finalResult: "deferred",
                    retryCount: requestError.retryCount ??
                      Math.max(0, nextRequestCount - 1),
                    finalHttpStatus: requestError.httpStatus ?? null,
                    quotaRetryStopped: requestError.quotaRetryStopped,
                    scheduledAt,
                    rateLimitType: requestError.rateLimitType ?? null,
                    quotaDiagnostic: requestError.quotaDiagnostic,
                  },
                );
                console.log("[Topic] Stage 2 retry deferred", {
                  articleId: stage2Article.article_id,
                  httpStatus: requestError.httpStatus ?? null,
                  retryCount: requestError.retryCount ?? null,
                  scheduledAt,
                  rateLimitType: requestError.rateLimitType ?? null,
                });
                return json({
                  status: "deferred",
                  claimed: queue.length,
                  batchId,
                  availableAt: scheduledAt,
                });
              } catch (deferError) {
                console.error("[Topic] Stage 2 queue defer failed", {
                  articleId: stage2Article.article_id,
                  type: deferError instanceof Error
                    ? deferError.name
                    : "unknown",
                });
              }
            }
            await saveStage2AttemptObservability(
              config,
              batchId,
              stage2Article.article_id,
              attempts,
              {
                finalResult: "failure",
                retryCount: requestError.retryCount ??
                  Math.max(0, nextRequestCount - 1),
                finalHttpStatus: requestError.httpStatus ?? null,
                quotaRetryStopped: requestError.quotaRetryStopped,
                rateLimitType: requestError.rateLimitType ?? null,
                quotaDiagnostic: requestError.quotaDiagnostic,
              },
            );
            for (const article of stage2Input) {
              try {
                await saveGemmaLog(config, {
                  articleId: article.article_id,
                  batchId,
                  status: "failed_gemma",
                  stage: "gemma_stage2",
                  errorType: apiErrorType(error),
                  message: "Stage 2 facts generation failed",
                  classifiedCategory: article.category,
                  diagnostics: requestError.diagnostics,
                });
              } catch { /* diagnostic log must not stop fallback */ }
            }
            console.error("[Topic] Gemma Stage 2 failure", {
              type: error instanceof Error ? error.name : "unknown",
            });
            gemmaResults = gemmaResults.map((r) =>
              stage2Input.some((a) => a.article_id === r.article_id)
                ? { ...r, facts: [] }
                : r
            );
          }
        }
      let completed = 0, duplicates = 0, excluded = 0, failedDb = 0;
      for (const failure of gemmaFailures) {
        const article = articles.find((a) =>
          a.article_id === failure.articleId
        )!;
        const category = fallbackCategory(article);
        if (!category) {
          await failDb(
            config,
            article.article_id,
            batchId,
            "gemma_fallback",
            "missing_fallback_category",
          );
          failedDb++;
          continue;
        }
        try {
          const result = await commitSingleton(
            config,
            article,
            null,
            category,
            "gemma_failed",
            batchId,
            failure.errorType,
          );
          if (failure.errorType === "invalid_json" && gemmaDiagnostics) {
            try {
              await saveGemmaInvalidJsonDiagnostics(
                config,
                article.article_id,
                batchId,
                gemmaDiagnostics,
              );
            } catch (logError) {
              console.error(
                "[Topic] Gemma invalid JSON diagnostics save failure",
                {
                  articleId: article.article_id,
                  batchId,
                  type: logError instanceof Error ? logError.name : "unknown",
                  message: logError instanceof Error
                    ? logError.message.slice(0, 160)
                    : "unknown",
                },
              );
            }
          }
          result.outcome === "duplicate_skipped" ? duplicates++ : completed++;
        } catch {
          await failDb(config, article.article_id, batchId, "topic_commit");
          failedDb++;
        }
      }
      for (
        const result of gemmaResults.filter((r) =>
          r.category === TOPIC_CATEGORIES[5]
        )
      ) {
        try {
          await finalizeExcluded(config, result.article_id, batchId);
          excluded++;
        } catch {
          await failDb(config, result.article_id, batchId, "exclude_commit");
          failedDb++;
        }
      }

      const embeddingInput = gemmaResults.filter((r) =>
        r.category !== TOPIC_CATEGORIES[5]
      );
      let embeddingResults: TopicEmbeddingResult[] = [],
        embeddingFailures: Array<{ articleId: string; errorType: string }> = [];
      const useUpstashVectors =
        Deno.env.get("TOPIC_VECTOR_SEARCH_MODE") === "upstash";
      if (useUpstashVectors) {
        embeddingResults = embeddingInput.map((r) => ({
          ...r,
          embedding: [],
          embedding_version: TOPIC_VECTOR_VERSION,
        }));
      } else {for (
          const model of ["gemini-embedding-001", "gemini-embedding-2"] as const
        ) {
          const modelInput = embeddingInput.filter((r) =>
            embeddingModelForCategory(r.category) === model
          );
          if (modelInput.length === 0) continue;
          const permitted: GemmaResult[] = [];
          let probe = false;
          for (const result of modelInput) {
            try {
              const reservation = await beginEmbeddingAttempt(config, model);
              if (reservation.allowed && (!reservation.probe || !probe)) {
                permitted.push(result);
                probe = probe || reservation.probe;
              } else {embeddingFailures.push({
                  articleId: result.article_id,
                  errorType: reservation.probe
                    ? "embedding_quota_reset_pending"
                    : `embedding_quota_${reservation.status}`,
                });}
            } catch {
              embeddingFailures.push({
                articleId: result.article_id,
                errorType: "embedding_quota_unavailable",
              });
            }
          }
          if (permitted.length === 0) continue;
          try {
            const embedding = await embedTopicResults(
              permitted,
              undefined,
              fetch,
              model,
            );
            embeddingResults.push(...embedding.results);
            embeddingFailures.push(...embedding.failures);
            if (probe) {
              await completeEmbeddingProbe(
                config,
                model,
                embedding.results.length === 1,
              );
            }
          } catch (error) {
            const errorType = apiErrorType(error);
            embeddingFailures.push(...permitted.map((r) => ({
              articleId: r.article_id,
              errorType,
            })));
            if (probe) await completeEmbeddingProbe(config, model, false);
            if (
              errorType === "rate_limit" &&
              (error as Error & { embedding429Kind?: string })
                  .embedding429Kind ===
                "rpd"
            ) {
              try {
                await markRpdExhausted(config, model);
              } catch { /* retain singleton fallback */ }
            }
          }
        }}
      for (const failure of embeddingFailures) {
        const article = articles.find((a) =>
          a.article_id === failure.articleId
        )!;
        const result = embeddingInput.find((r) =>
          r.article_id === failure.articleId
        )!;
        try {
          const committed = await commitSingleton(
            config,
            article,
            result,
            result.category,
            "embedding_failed",
            batchId,
            failure.errorType,
          );
          committed.outcome === "duplicate_skipped"
            ? duplicates++
            : completed++;
        } catch {
          await failDb(config, article.article_id, batchId, "topic_commit");
          failedDb++;
        }
      }

      // Deliberately sequential: each newly committed Topic is visible to the next article in this batch.
      await forEachSequential(embeddingResults, async (result) => {
        const article = articles.find((a) =>
          a.article_id === result.article_id
        )!;
        try {
          let candidate;
          let searchFailureType = useUpstashVectors
            ? "upstash_configuration_missing"
            : "vector_rpc_failed";
          try {
            if (useUpstashVectors) {
              const vectorUrl = Deno.env.get("UPSTASH_VECTOR_REST_URL"),
                vectorToken = Deno.env.get("UPSTASH_VECTOR_REST_TOKEN");
              if (!vectorUrl || !vectorToken) {
                throw new Error("Upstash Vector configuration missing");
              }
              searchFailureType = "vector_outbox_sync_failed";
              await syncTopicVectorOutbox(config, vectorUrl, vectorToken);
              searchFailureType = "vector_search_failed";
              candidate = await queryTopicVectorWithLog(
                config,
                vectorUrl,
                vectorToken,
                result.topic_text,
                Date.now() - topicConfig.lookbackHours * 60 * 60 * 1000,
                result.category,
                batchId,
                article.article_id,
                result.embedding_version,
              );
            } else {
              const model = embeddingModelForCategory(result.category);
              if (!model || !result.embedding) {
                throw new Error("embedding_model_not_configured");
              }
              candidate = await matchRecentTopic(
                config,
                result.embedding,
                model,
                result.category,
              );
            }
          } catch (error) {
            if (
              useUpstashVectors && searchFailureType === "vector_search_failed"
            ) {
              searchFailureType = error instanceof Error &&
                  /HTTP failure status=\d{3}/u.test(error.message)
                ? `vector_${
                  error.message.match(/HTTP failure status=(\d{3})/u)?.[1]
                }`
                : error instanceof DOMException &&
                    error.name === "TimeoutError"
                ? "vector_timeout"
                : error instanceof TypeError
                ? "vector_network_error"
                : "vector_search_failed";
            }
            const committed = await commitSingleton(
              config,
              article,
              result,
              result.category,
              "vector_search_failed",
              batchId,
              searchFailureType,
              null,
              result.embedding_version,
            );
            committed.outcome === "duplicate_skipped"
              ? duplicates++
              : completed++;
            return;
          }
          if (shouldMerge(candidate)) {
            const committed = await commitMerge(
              config,
              article,
              result,
              candidate!,
              batchId,
            );
            committed.outcome === "duplicate_skipped"
              ? duplicates++
              : completed++;
            return;
          }
          const committed = await commitNewTopic(
            config,
            article,
            result,
            batchId,
            candidate,
            null,
          );
          committed.outcome === "duplicate_skipped"
            ? duplicates++
            : completed++;
        } catch {
          await failDb(config, article.article_id, batchId, "topic_commit");
          failedDb++;
        }
      });
      if (gemmaElapsedMs !== null) {
        try {
          await updateGemmaDuration(
            config,
            articles.map((a) => a.article_id),
            batchId,
            gemmaElapsedMs,
          );
        } catch {
          /* duration is diagnostic data and must not fail processing */
        }
      }
      let titleBatchProcessed = false;
      stage = "thread_title_batch";
      try {
        titleBatchProcessed = await processThreadTitleBatch(
          config,
          Deno.env.get(topicConfig.gemmaApiKeyEnv) ?? "",
        );
      } catch (error) {
        console.error("[Topic] thread title batch failure", {
          type: error instanceof Error ? error.name : "unknown",
        });
      }
      let topicCacheItems: number | null = null;
      if (completed > 0) {
        try {
          const shouldPublish = await recordTopicCompletionForCache(config);
          if (shouldPublish) {
            topicCacheItems = await publishTopicListCache(
              config,
              redisUrl,
              redisToken,
            );
          }
        } catch (error) {
          console.error("[Topic] cache publish failure", {
            type: error instanceof Error ? error.name : "unknown",
            message: error instanceof Error
              ? error.message.slice(0, 160)
              : "unknown",
          });
        }
      }
      return json({
        status: "ok",
        claimed: queue.length,
        loaded: articles.length,
        completed,
        duplicates,
        excluded,
        failedDb,
        topicCacheItems,
        titleBatchProcessed,
        batchId,
      });
    } catch (error) {
      console.error("[Topic] worker failure", {
        workerId,
        claimId,
        batchId,
        stage,
        type: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error
          ? error.message.slice(0, 160)
          : "unknown",
      });
      return json({ status: "error", claimed: 0, batchId }, 500);
    }
  },
));
