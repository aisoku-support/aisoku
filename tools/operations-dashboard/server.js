"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const PORT = 48763;
const ROOT = __dirname;
const MAX_TOPIC_LOG_ROWS = 5000;
const TOPIC_PAGE_SIZE = 1000;
const RSS_ACTIVE_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const TOPIC_UPSTASH_VERSION = "openai/text-embedding-3-small:1536:v1";
// Keep these timestamps aligned with Supabase function_logs after each deploy.
const TOPIC_PROCESSING_RELEASES = [
  { version: "v83", deployedAt: "2026-09-28T23:13:48.075Z" },
  { version: "v84", deployedAt: "2026-09-29T00:21:52.205Z" },
  { version: "v85", deployedAt: "2026-09-29T05:53:23.196Z" },
  { version: "v86", deployedAt: "2026-09-29T06:12:35.924Z" },
  { version: "v87", deployedAt: "2026-09-29T06:18:09.664Z" },
  { version: "v88", deployedAt: "2026-09-29T07:00:27.733Z" },
  { version: "v89", deployedAt: "2026-09-29T09:27:38.814Z" },
  { version: "v90", deployedAt: "2026-09-29T11:57:34.717Z" },
];

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

// Process environment > repository .env > Operations-local .env.
loadEnvFile(path.resolve(ROOT, "../../.env"));
loadEnvFile(path.join(ROOT, ".env"));

function config() {
  return {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY,
    redisUrl: process.env.UPSTASH_REDIS_REST_URL,
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    links: {
      supabaseUsage: process.env.SUPABASE_USAGE_URL || null,
      supabaseLogs: process.env.SUPABASE_LOGS_URL || null,
      upstashConsole: process.env.UPSTASH_CONSOLE_URL || null,
    },
  };
}

function parseTopicPregenEnvLine(line) {
  const match = line.match(/^\s*(TOPIC_PREGEN_WORKER_URL|TOPIC_PREGEN_DIAGNOSTIC_SECRET)\s*=\s*(.*?)\s*$/);
  if (!match) return null;
  return [match[1], match[2].replace(/^(['"])(.*)\1$/, "$2")];
}

async function topicPregenSettings() {
  const values = {
    workerUrl: process.env.TOPIC_PREGEN_WORKER_URL || null,
    diagnosticSecret: process.env.TOPIC_PREGEN_DIAGNOSTIC_SECRET || null,
  };
  if (values.workerUrl && values.diagnosticSecret) return values;

  const file = path.resolve(ROOT, "../../.env.server");
  if (!fs.existsSync(file)) return values;

  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const parsed = parseTopicPregenEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (key === "TOPIC_PREGEN_WORKER_URL" && !values.workerUrl) values.workerUrl = value;
      if (key === "TOPIC_PREGEN_DIAGNOSTIC_SECRET" && !values.diagnosticSecret) values.diagnosticSecret = value;
      if (values.workerUrl && values.diagnosticSecret) {
        lines.close();
        break;
      }
    }
  } catch {
    // Configuration read failures are returned as an unavailable status below.
  } finally {
    lines.close();
    input.destroy();
  }
  return values;
}

function safeTopicPregenState(raw, fetchedAt) {
  const allowedStatuses = new Set(["idle", "pending", "attempting", "retry_wait", "failed", "completed"]);
  const allowedDiagnosticPhases = new Set(["http", "sse", "sse_read", "sse_event_parse", "model_json", "comment_count", "comment_validation", "save", "complete"]);
  const safeNumber = value => value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const safeBoolean = value => typeof value === "boolean" ? value : null;
  const safeType = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
  const safeErrorMessage = value => {
    if (typeof value !== "string") return null;
    return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ")
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/((?:api[_-]?key|authorization|access[_-]?token|secret)\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[redacted]")
      .replace(/([?&](?:key|token|secret|access_token)=)[^&#\s]+/gi, "$1[redacted]")
      .trim().slice(0, 400) || null;
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const topicId = typeof raw.topic_id === "string" && /^[0-9a-f-]{36}$/i.test(raw.topic_id) ? raw.topic_id : null;
  return {
    available: true,
    fetchedAt,
    state: {
      targetTopicId: topicId,
      generation: safeNumber(raw.generation),
      status: allowedStatuses.has(raw.status) ? raw.status : "unknown",
      attempts: safeNumber(raw.attempts),
      rollingWindowAttempts: safeNumber(raw.rolling_window_attempts),
      lastHttpStatus: safeNumber(raw.last_http_status),
      providerHttpStatus: safeNumber(raw.provider_http_status),
      saveHttpStatus: safeNumber(raw.save_http_status),
      lastDiagnosticPhase: allowedDiagnosticPhases.has(raw.last_diagnostic_phase) ? raw.last_diagnostic_phase : null,
      sseReadCompleted: safeBoolean(raw.sse_read_completed),
      sseCompletionConfirmed: safeBoolean(raw.sse_completion_confirmed),
      sseEndMarkerSeen: safeBoolean(raw.sse_end_marker_seen),
      modelFinishReason: safeType(raw.model_finish_reason),
      commentCount: safeNumber(raw.comment_count),
      commentValidationReason: safeType(raw.comment_validation_reason),
      retryCount: safeNumber(raw.attempts) == null ? null : Math.max(0, safeNumber(raw.attempts) - 1),
      lastErrorMessage: safeErrorMessage(raw.last_error_message),
      lastErrorType: safeType(raw.last_error_type),
      retryNotBefore: safeNumber(raw.retry_not_before),
      alarmScheduled: safeBoolean(raw.alarm_scheduled),
      alarmAt: safeNumber(raw.alarm_at),
      parserSucceeded: safeBoolean(raw.parser_succeeded),
      saveAttempted: safeBoolean(raw.save_attempted),
      saveSucceeded: safeBoolean(raw.save_succeeded),
      lastProcessedAt: raw.completed_at || raw.last_attempt_at || null,
    },
  };
}

async function topicPregenStatus(fetcher = fetch, suppliedSettings = null) {
  const fetchedAt = new Date().toISOString();
  const settings = suppliedSettings || await topicPregenSettings();
  if (!settings.workerUrl || !settings.diagnosticSecret) {
    settings.diagnosticSecret = null;
    return { available: false, fetchedAt, error: { type: "missing_config", httpStatus: null } };
  }
  try {
    const endpoint = new URL(settings.workerUrl);
    if (endpoint.protocol !== "https:") {
      return { available: false, fetchedAt, error: { type: "invalid_worker_url", httpStatus: null } };
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/internal/status`;
    endpoint.search = "";
    endpoint.hash = "";
    const response = await fetcher(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${settings.diagnosticSecret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { available: false, fetchedAt, error: { type: "http_error", httpStatus: response.status } };
    }
    const raw = await response.json();
    return safeTopicPregenState(raw, fetchedAt) || {
      available: false,
      fetchedAt,
      error: { type: "invalid_response", httpStatus: null },
    };
  } catch (error) {
    const type = typeof error?.name === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(error.name) ? error.name : "request_failed";
    return { available: false, fetchedAt, error: { type, httpStatus: null } };
  } finally {
    settings.diagnosticSecret = null;
  }
}

function requireConfig(c) {
  const missing = [];
  if (!c.supabaseUrl) missing.push("SUPABASE_URL");
  if (!c.serviceRole) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!c.redisUrl) missing.push("UPSTASH_REDIS_REST_URL");
  if (!c.redisToken) missing.push("UPSTASH_REDIS_REST_TOKEN");
  if (missing.length) throw new Error(`\u30ed\u30fc\u30ab\u30eb\u8a2d\u5b9a\u304c\u4e0d\u8db3\u3057\u3066\u3044\u307e\u3059: ${missing.join(", ")}`);
}

function jstTodayStart(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return new Date(`${value.year}-${value.month}-${value.day}T00:00:00+09:00`);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function countBy(rows, predicate) { return rows.reduce((n, row) => n + (predicate(row) ? 1 : 0), 0); }
function rate(value, total) { return total ? value / total : null; }
function maxTime(values) { const valid = values.filter(Boolean).map((v) => Date.parse(v)).filter(Number.isFinite); return valid.length ? new Date(Math.max(...valid)).toISOString() : null; }
function embeddingModelFromVersion(version) {
  if (typeof version !== "string") return null;
  const model = version.split(":", 1)[0];
  return /^(?:gemini-embedding-(?:001|2)|openai\/text-embedding-3-small)$/.test(model) ? model : null;
}

function topicSearchMetrics(rows, observed = null) {
  const successfulCommits = rows.filter((row) =>
    row.stage === "topic_commit" &&
    ["new_topic", "merged"].includes(row.status) &&
    row.embedding_version
  ).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const last = successfulCommits.at(-1) || null;
  const lastVersion = last?.embedding_version || null;
  return {
    currentMode: null,
    currentModeSource: "not_recorded_in_database",
    lastObservedMode: lastVersion === TOPIC_UPSTASH_VERSION
      ? "upstash"
      : lastVersion?.startsWith("gemini-") ? "gemini" : null,
    lastObservedVersion: lastVersion,
    lastObservedAt: last?.created_at || null,
    upstash: {
      successfulCommits: countBy(successfulCommits, (row) =>
        row.embedding_version === TOPIC_UPSTASH_VERSION
      ),
      searchFailures: observed?.search?.failures ?? null,
      legacyUpstashFailedSearchCommits: countBy(rows, (row) =>
        row.stage === "topic_commit" && row.status === "failed_search" &&
        row.embedding_version === TOPIC_UPSTASH_VERSION
      ),
      legacyGeminiFailedSearchCommits: countBy(rows, (row) =>
        row.stage === "topic_commit" && row.status === "failed_search" &&
        typeof row.embedding_version === "string" && row.embedding_version.startsWith("gemini-")
      ),
      outboxSyncFailures: observed?.outbox?.syncFailures ?? null,
      legacyOutboxSyncFailureCommits: countBy(rows, (row) =>
        row.stage === "topic_commit" && row.status === "failed_search" &&
        row.embedding_version === TOPIC_UPSTASH_VERSION &&
        row.error_type === "vector_outbox_sync_failed"
      ),
      searchSuccesses: observed?.search?.successes ?? null,
      searchFailures: observed?.search?.failures ?? null,
      searchAverageDurationMs: observed?.search?.averageDurationMs ?? null,
      searchP95DurationMs: observed?.search?.p95DurationMs ?? null,
      searchFailureReasons: observed?.search?.failureReasons ?? null,
      searchByEmbeddingVersion: observed?.search?.byEmbeddingVersion ?? null,
      lastSearchSuccessAt: observed?.search?.lastSuccessAt ?? null,
      lastSearchFailureAt: observed?.search?.lastFailureAt ?? null,
      newTopicCommits: countBy(successfulCommits, (row) =>
        row.embedding_version === TOPIC_UPSTASH_VERSION && row.status === "new_topic"
      ),
      mergeCommits: countBy(successfulCommits, (row) =>
        row.embedding_version === TOPIC_UPSTASH_VERSION && row.status === "merged"
      ),
      failureAttribution: "embedding_version_and_error_type",
    },
    providerUnattributedFailures: countBy(rows, (row) =>
      row.stage === "topic_commit" && row.status === "failed_search" &&
      !row.embedding_version
    ),
  };
}

function aggregateTopicObservability(rows, topicRows = []) {
  if (!Array.isArray(rows)) return null;
  const groupCount = (items, key) => Object.fromEntries([...new Set(items.map((row) => row[key]).filter(Boolean))].sort().map((value) => [value, countBy(items, (row) => row[key] === value)]));
  const attempts = rows.filter((row) => row.operation === "stage1_attempt");
  const stage2Attempts = rows.filter((row) => row.operation === "stage2_attempt");
  const attemptBatches = new Set(attempts.map((row) => row.batch_id).filter(Boolean));
  const modelNames = [...new Set(attempts.map(row => row.model).filter(Boolean))];
  const models = modelNames.map((model) => {
    const modelAttempts = attempts.filter((row) => row.model === model);
    const fallbackAttempts = modelAttempts.filter((row) => row.model_role === "fallback");
    return {
      model,
      attempts: modelAttempts.length,
      quotaBlocked: countBy(modelAttempts, row => ["quota_limit","quota_unconfigured","quota_unavailable"].includes(row.error_type)),
      httpResponses: countBy(modelAttempts, row => Number.isInteger(row.http_status)),
      sendUnknown: countBy(modelAttempts, row => row.http_status == null && !["quota_limit","quota_unconfigured","quota_unavailable"].includes(row.error_type)),
      success: countBy(modelAttempts, (row) => row.status === "success"),
      failed: countBy(modelAttempts, (row) => row.status === "failure"),
      timeoutRetries: countBy(modelAttempts, (row) => row.timeout_retry === true),
      fallback: fallbackAttempts.length,
      fallbackReasons: groupCount(fallbackAttempts, "fallback_reason"),
    };
  });
  const searchRows = rows.filter((row) => row.operation === "vector_search");
  const searchSuccess = searchRows.filter((row) => row.status === "success");
  const searchFailures = searchRows.filter((row) => row.status === "failure");
  const searchDurations = searchRows.map((row) => row.duration_ms).filter(Number.isFinite);
  const searchByVersion = new Map();
  for (const row of searchRows) {
    const version = row.embedding_version || "unknown";
    const group = searchByVersion.get(version) || { version, successes: 0, failures: 0 };
    group[row.status === "success" ? "successes" : "failures"]++;
    searchByVersion.set(version, group);
  }
  const outboxRows = rows.filter((row) => row.operation === "outbox_sync");
  const successfulSyncs = outboxRows.filter((row) => row.status === "success");
  const failedSyncs = outboxRows.filter((row) => row.status === "failure");
  const articleBodyRows = rows.filter((row) => row.operation === "article_body");
  const articleBodySuccess = articleBodyRows.filter((row) => row.status === "success");
  const articleBodyFailures = articleBodyRows.filter((row) => row.status === "failure");
  const bodyChars = articleBodyRows.map((row) => row.article_body_chars).filter(Number.isFinite);
  const bodyDurations = articleBodyRows.map((row) => row.duration_ms).filter(Number.isFinite);
  const latest = (items) => items.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
  const lastSearchSuccess = latest(searchSuccess);
  const lastSearchFailure = latest(searchFailures);
  const lastSyncSuccess = latest(successfulSyncs);
  const lastSyncFailure = latest(failedSyncs);
  return {
    stage1: {
      models,
      fallbacks: countBy(attempts, (row) => row.model_role === "fallback"),
      fallbackReasons: groupCount(attempts.filter((row) => row.model_role === "fallback"), "fallback_reason"),
      timeoutRetries: countBy(attempts, (row) => row.timeout_retry === true),
      unattributedStageRecords: countBy(topicRows, (row) =>
        row.stage === "gemma_stage1" && (!row.batch_id || !attemptBatches.has(row.batch_id))
      ),
    },
    stage2: {
      attempts: stage2Attempts.length,
      failures: countBy(stage2Attempts, (row) => row.status === "failure" && row.diagnostic_details?.finalResult === "failure"),
      recoveredAttempts: countBy(stage2Attempts, (row) => row.status === "failure" && row.diagnostic_details?.finalResult === "success"),
      deferredAttempts: countBy(stage2Attempts, (row) => row.diagnostic_details?.finalResult === "deferred"),
      failureReasons: groupCount(stage2Attempts.filter((row) => row.status === "failure" && row.diagnostic_details?.finalResult === "failure"), "error_type"),
      lastFailureAt: latest(stage2Attempts.filter((row) => row.status === "failure" && row.diagnostic_details?.finalResult === "failure"))?.created_at || null,
    },
    search: {
      successes: searchSuccess.length,
      failures: searchFailures.length,
      averageDurationMs: searchDurations.length ? Math.round(searchDurations.reduce((a, b) => a + b, 0) / searchDurations.length) : null,
      p95DurationMs: percentile(searchDurations, .95),
      failureReasons: groupCount(searchFailures, "error_type"),
      byEmbeddingVersion: [...searchByVersion.values()],
      lastSuccessAt: lastSearchSuccess?.created_at || null,
      lastFailureAt: lastSearchFailure?.created_at || null,
    },
    outbox: {
      syncSuccesses: successfulSyncs.length,
      syncFailures: failedSyncs.length,
      syncedRecords: successfulSyncs.reduce((sum, row) => sum + (Number(row.item_count) || 0), 0),
      lastSyncSuccessAt: lastSyncSuccess?.created_at || null,
      lastSyncFailureAt: lastSyncFailure?.created_at || null,
      failureReasons: groupCount(failedSyncs, "error_type"),
    },
    articleBody: {
      successes: articleBodySuccess.length,
      failures: articleBodyFailures.length,
      methods: groupCount(articleBodyRows, "article_body_method"),
      readability: groupCount(articleBodyRows, "article_body_readability"),
      failureReasons: groupCount(articleBodyFailures, "error_type"),
      redirects: countBy(articleBodyRows, (row) => row.article_body_redirected === true),
      averageChars: bodyChars.length ? Math.round(bodyChars.reduce((a, b) => a + b, 0) / bodyChars.length) : null,
      p95Chars: percentile(bodyChars, .95),
      averageDurationMs: bodyDurations.length ? Math.round(bodyDurations.reduce((a, b) => a + b, 0) / bodyDurations.length) : null,
      p95DurationMs: percentile(bodyDurations, .95),
    },
  };
}

function aggregateTopics(rows, threadTitleRows = [], processingQueueRows = [], observabilityRows = null) {
  const observability = aggregateTopicObservability(observabilityRows, rows);
  const recognized = new Set(["new_topic","merged","excluded","failed_gemma","failed_embedding","failed_search","failed_db","duplicate_skipped","excluded_missing_title","excluded_missing_description","excluded_invalid_article","already_processed","fallback_singleton"]);
  const terminal=rows.filter(r=>recognized.has(r.status)&&r.article_id), finalByArticle=new Map();
  for(const row of terminal){const old=finalByArticle.get(row.article_id);if(!old||Date.parse(row.created_at)>Date.parse(old.created_at)||(row.created_at===old.created_at&&String(row.id||"")>String(old.id||"")))finalByArticle.set(row.article_id,row);}
  const articles=[...finalByArticle.values()],total=articles.length,excludedStatuses=new Set(["excluded","excluded_missing_title","excluded_missing_description","excluded_invalid_article","already_processed"]),statusCount=status=>countBy(articles,r=>r.status===status),excludedCount=countBy(articles,r=>excludedStatuses.has(r.status));
  const analysisRows=rows.filter(r=>r.stage==="gemma_stage1"||r.stage==="gemma_stage2"),stage1FallbackFailures=rows.filter(r=>r.stage==="topic_commit"&&r.status==="failed_gemma"&&!analysisRows.some(x=>x.stage==="gemma_stage1"&&x.article_id===r.article_id&&x.batch_id===r.batch_id));
  const stage=name=>{const item=analysisRows.filter(r=>r.stage===name),failedRows=[...item.filter(r=>r.status==="failed_gemma"),...(name==="gemma_stage1"?stage1FallbackFailures:[])],failed=failedRows.length,success=countBy(item,r=>r.gemma_api_completed===true&&r.status!=="failed_gemma"),total=item.length+(name==="gemma_stage1"?stage1FallbackFailures.length:0),durations=item.map(r=>r.gemma_api_duration_ms).filter(Number.isFinite),httpFailures={};for(const r of item.filter(x=>x.gemma_http_status!=null&&(x.gemma_http_status<200||x.gemma_http_status>=300)))httpFailures[r.gemma_http_status]=(httpFailures[r.gemma_http_status]||0)+1;const maxTokenRows=item.filter(r=>r.gemma_finish_reason==="MAX_TOKENS"),maxTokensNoFacts=countBy(maxTokenRows,r=>rows.some(commit=>commit.article_id===r.article_id&&commit.stage==="topic_commit"&&commit.fact_count===0));return{failureReasons:Object.fromEntries([...new Set(failedRows.map(r=>r.error_type).filter(Boolean))].map(k=>[k,countBy(failedRows,r=>r.error_type===k)])),success,failed,total,successRate:rate(success,total),failureRate:rate(failed,total),httpFailures,maxTokens:maxTokenRows.length,maxTokensNoFacts,averageDurationMs:durations.length?Math.round(durations.reduce((x,y)=>x+y,0)/durations.length):null,p95DurationMs:percentile(durations,.95),promptTokens:item.reduce((n,r)=>n+(Number(r.gemma_prompt_tokens)||0),0),outputTokens:item.reduce((n,r)=>n+(Number(r.gemma_output_tokens)||0),0),thinkingTokens:item.reduce((n,r)=>n+(Number(r.gemma_thinking_tokens)||0),0)};};
  const byCount=(items,key)=>Object.fromEntries([...new Set(items.map(r=>r[key]).filter(Boolean))].sort().map(v=>[v,countBy(items,r=>r[key]===v)]));
  const anomalous=rows.filter(r=>["failed_gemma","failed_embedding","failed_search","failed_db"].includes(r.status)||r.gemma_http_status===429||(r.gemma_http_status>=500&&r.gemma_http_status<=599)||["timeout","network_error","invalid_json"].includes(r.error_type)).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,10);
  const embeddingRows=rows.filter(r=>r.stage==="embedding"||r.embedding_model||r.embedding_version),groups=embeddingRows.reduce((o,r)=>{const k=JSON.stringify([r.embedding_model||embeddingModelFromVersion(r.embedding_version)||null,r.embedding_version||null]);(o[k]??=[]).push(r);return o;},{}),bodyRows=rows.filter(r=>r.stage==="article_body");
  return{total,logRows:rows.length,outcomes:["new_topic","merged","failed_gemma","failed_embedding","failed_search","failed_db","fallback_singleton"].reduce((o,n)=>{const c=statusCount(n);o[n]={count:c,rate:rate(c,total),denominator:total};return o;},{excluded:{count:excludedCount,rate:rate(excludedCount,total),denominator:total}}),lastNormalAt:maxTime(articles.filter(r=>["new_topic","merged","excluded"].includes(r.status)).map(r=>r.created_at)),
    stage1:{perModelMetricsAvailable:Boolean(observability),fallbackCount:observability?.stage1.fallbacks??null,fallbackReasons:observability?.stage1.fallbackReasons??null,timeoutRetries:observability?.stage1.timeoutRetries??null,unattributedStageRecords:observability?.stage1.unattributedStageRecords??null,models:observability?.stage1.models??[{model:"モデル未記録",attempts:null,success:null,failed:null,timeoutRetries:null,fallback:null}]},
    topicSearch:topicSearchMetrics(rows,observability),
    topicOutbox:observability?.outbox??{syncSuccesses:null,syncFailures:null,syncedRecords:null,lastSyncSuccessAt:null,lastSyncFailureAt:null,failureReasons:null},
    gemma:{stage1:stage("gemma_stage1"),stage2:stage("gemma_stage2"),repetitionLoop:countBy(analysisRows,r=>r.error_type==="repetition_loop"),maxTokens:countBy(analysisRows,r=>r.gemma_finish_reason==="MAX_TOKENS"),invalid:countBy(analysisRows,r=>["invalid_json","invalid_output"].includes(r.error_type)),timeoutNetwork:countBy(analysisRows,r=>["timeout","network_error"].includes(r.error_type)),http429:countBy(analysisRows,r=>r.gemma_http_status===429),http5xx:countBy(analysisRows,r=>r.gemma_http_status>=500&&r.gemma_http_status<=599),failuresByReason:byCount([...analysisRows.filter(r=>r.status==="failed_gemma"||r.error_type),...stage1FallbackFailures],"error_type"),averageDurationMs:analysisRows.some(r=>Number.isFinite(r.gemma_api_duration_ms))?Math.round(analysisRows.filter(r=>Number.isFinite(r.gemma_api_duration_ms)).reduce((n,r)=>n+r.gemma_api_duration_ms,0)/analysisRows.filter(r=>Number.isFinite(r.gemma_api_duration_ms)).length):null,p95DurationMs:percentile(analysisRows.map(r=>r.gemma_api_duration_ms).filter(Number.isFinite),.95),promptTokens:analysisRows.reduce((n,r)=>n+(Number(r.gemma_prompt_tokens)||0),0),outputTokens:analysisRows.reduce((n,r)=>n+(Number(r.gemma_output_tokens)||0),0),thinkingTokens:analysisRows.reduce((n,r)=>n+(Number(r.gemma_thinking_tokens)||0),0)},
    embedding:{rows:embeddingRows.length,byModelVersion:Object.entries(groups).map(([key,v])=>{const [model,version]=JSON.parse(key);return{model,version,count:v.length,failures:countBy(v,r=>r.status==="failed_embedding")};}),similarityCount:embeddingRows.filter(r=>Number.isFinite(r.similarity)).length,averageSimilarity:embeddingRows.some(r=>Number.isFinite(r.similarity))?embeddingRows.filter(r=>Number.isFinite(r.similarity)).reduce((n,r)=>n+r.similarity,0)/embeddingRows.filter(r=>Number.isFinite(r.similarity)).length:null,failureReasons:byCount(embeddingRows.filter(r=>r.status==="failed_embedding"),"error_type"),quota:null},fallback:{count:processingQueueRows.some(r=>r.processed_at)?countBy(processingQueueRows.filter(r=>r.processed_at),r=>r.terminal_status==="fallback_singleton"):null,rate:processingQueueRows.some(r=>r.processed_at)?rate(countBy(processingQueueRows.filter(r=>r.processed_at),r=>r.terminal_status==="fallback_singleton"),processingQueueRows.filter(r=>r.processed_at).length):null,denominator:processingQueueRows.filter(r=>r.processed_at).length||null,reason:processingQueueRows.some(r=>r.processed_at)?null:"unmeasured"},articleBody:observability?.articleBody?{loggedFailures:observability.articleBody.failures,failureReasons:observability.articleBody.failureReasons,success:observability.articleBody.successes,failures:observability.articleBody.failures,method:observability.articleBody.methods,readability:observability.articleBody.readability,chars:observability.articleBody.averageChars,p95Chars:observability.articleBody.p95Chars,durationMs:observability.articleBody.averageDurationMs,p95DurationMs:observability.articleBody.p95DurationMs,redirects:observability.articleBody.redirects}:{loggedFailures:bodyRows.length,failureReasons:byCount(bodyRows,"error_type"),success:null,failures:null,method:null,readability:null,chars:null,p95Chars:null,durationMs:null,p95DurationMs:null,redirects:null},
    quality:{factsSuccess:countBy(articles,r=>Number(r.fact_count)>0),factsZero:countBy(articles,r=>r.fact_count===0),mergeRate:rate(statusCount("merged"),total),threadTitleTarget:threadTitleRows.length,threadTitleSuccess:countBy(threadTitleRows,r=>r.status==="success"),threadTitleFailed:countBy(threadTitleRows,r=>r.status==="failed"),threadTitlePending:countBy(threadTitleRows,r=>r.status==="pending"),threadTitleProcessing:countBy(threadTitleRows,r=>r.status==="claimed"||r.status==="processing"),threadTitleSet:countBy(threadTitleRows,r=>Boolean(r.topics?.thread_title)),threadTitleLatestSuccessAt:maxTime(threadTitleRows.filter(r=>r.status==="success").map(r=>r.finalized_at)),threadTitleLatestFailedAt:maxTime(threadTitleRows.filter(r=>r.status==="failed").map(r=>r.finalized_at)),threadTitleFailureReasons:byCount(threadTitleRows.filter(r=>r.status==="failed"||r.failure_status),"failure_status"),exclusions:{gemma:statusCount("excluded"),missing_description:statusCount("excluded_missing_description"),missing_title:statusCount("excluded_missing_title"),invalid_article:statusCount("excluded_invalid_article"),already_processed:statusCount("already_processed")}},anomalies:anomalous.map(r=>({timestamp:r.created_at,subsystem:r.status==="failed_db"?"Supabase / DB":r.stage==="embedding"?"Embedding":"Topic / Gemma",stage:r.stage||null,errorType:r.error_type||r.status,httpStatus:r.gemma_http_status||null,durationMs:r.gemma_api_duration_ms||r.duration_ms||null}))};
}

function topicReleaseAudit(since, now, rows, titleRows, batches, observabilityRows) {
  const sinceMs = new Date(since).getTime();
  const nowMs = new Date(now).getTime();
  const prior = TOPIC_PROCESSING_RELEASES.filter(x => Date.parse(x.deployedAt) <= sinceMs).at(-1);
  const boundaries = [
    { version: prior?.version || "v83以前", at: new Date(since) },
    ...TOPIC_PROCESSING_RELEASES.filter(x => Date.parse(x.deployedAt) > sinceMs && Date.parse(x.deployedAt) < nowMs).map(x => ({ version: x.version, at: new Date(x.deployedAt) })),
    { version: "現在", at: new Date(now) },
  ];
  const windows = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = Math.max(new Date(since).getTime(), boundaries[i].at.getTime());
    const to = Math.min(new Date(now).getTime(), boundaries[i + 1].at.getTime());
    if (to <= from) continue;
    const inWindow = row => {
      const time = Date.parse(row.created_at || row.queued_at || "");
      return Number.isFinite(time) && time >= from && time < to;
    };
    const aggregate = aggregateTopics(
      rows.filter(inWindow),
      titleRows.filter(row => {
        const time = Date.parse(row.queued_at || "");
        return Number.isFinite(time) && time >= from && time < to;
      }),
      [],
      observabilityRows?.filter(inWindow) ?? null,
    );
    const titleBatches = batches.filter(inWindow);
    windows.push({
      version: boundaries[i].version,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      stage1: aggregate.gemma.stage1,
      stage2: aggregate.gemma.stage2,
      stage1Attempts: aggregate.stage1.models.reduce((n, row) => n + (Number(row.attempts) || 0), 0),
      stage1QuotaBlocked: aggregate.stage1.models.reduce((n, row) => n + (Number(row.quotaBlocked) || 0), 0),
      titleTopics: {
        success: aggregate.quality.threadTitleSuccess,
        failed: aggregate.quality.threadTitleFailed,
        pending: aggregate.quality.threadTitlePending,
      },
      titleBatchCount: titleBatches.length,
      titleApiAttempts: titleBatches.reduce((n, row) => n + (Number(row.attempts) || 1), 0),
    });
  }
  return windows;
}

async function supabaseThreadTitleRows(c, since, fetcher = fetch) {
  const base = `${c.supabaseUrl.replace(/\/$/, "")}/rest/v1/`;
  const headers = { apikey: c.serviceRole, Authorization: `Bearer ${c.serviceRole}` };
  const queue = new URL(`${base}topic_thread_title_queue`);
  queue.searchParams.set("select", "topic_id,status,queued_at,finalized_at,failure_status,claim_id,topics(thread_title,thread_title_pending)");
  queue.searchParams.set("or", `(queued_at.gte.${since.toISOString()},status.in.(pending,claimed,processing))`);
  queue.searchParams.set("order", "queued_at.desc");
  queue.searchParams.set("limit", "10000");
  const batches = new URL(`${base}topic_thread_title_batches`);
  batches.searchParams.set("select", "id,created_at,request_finished_at,success_count,failure_count,attempts,model,batch_size,duration_ms,input_tokens,output_tokens,thinking_tokens,probe,http_status,finish_reason,failure_types,quota_day_pt,used_today_at_request");
  batches.searchParams.set("created_at", `gte.${since.toISOString()}`);
  batches.searchParams.set("limit", "10000");
  const [queueResponse, batchResponse] = await Promise.all([fetcher(queue, { headers }), fetcher(batches, { headers })]);
  if (!queueResponse.ok) throw new Error(`Supabase thread title queue read / HTTP ${queueResponse.status}`);
  if (!batchResponse.ok) throw new Error(`Supabase thread title batches read / HTTP ${batchResponse.status}`);
  const rows = await queueResponse.json();
  const batchRows = await batchResponse.json();
  if (!Array.isArray(rows) || !Array.isArray(batchRows)) throw new Error("Supabase thread title read returned invalid data");
  return { rows, batches: batchRows };
}

async function supabaseTopicRows(c, since) {
  const query = new URL(`${c.supabaseUrl.replace(/\/$/, "")}/rest/v1/topic_processing_logs`);
  query.searchParams.set("select", "id,article_id,topic_id,candidate_topic_id,batch_id,created_at,status,stage,error_type,gemma_http_status,gemma_finish_reason,gemma_api_completed,gemma_api_duration_ms,gemma_prompt_tokens,gemma_output_tokens,gemma_thinking_tokens,fact_count,thread_title_status,duration_ms,embedding_model,embedding_version,similarity");
  query.searchParams.set("created_at", `gte.${since.toISOString()}`);
  query.searchParams.set("order", "created_at.desc");
  const rows = [];
  for (let offset = 0; offset <= MAX_TOPIC_LOG_ROWS; offset += TOPIC_PAGE_SIZE) {
    const page = new URL(query);
    page.searchParams.set("limit", String(Math.min(TOPIC_PAGE_SIZE, MAX_TOPIC_LOG_ROWS + 1 - offset)));
    page.searchParams.set("offset", String(offset));
    let response;
    try { response = await fetch(page, { headers: { apikey: c.serviceRole, Authorization: `Bearer ${c.serviceRole}` } }); }
    catch (error) { throw externalFailure("Supabase", "topic_processing_logs read", error); }
    if (!response.ok) throw new Error(`Supabaseへの接続に失敗しました（topic_processing_logs read / HTTP ${response.status}）。`);
    const pageRows = await response.json();
    if (!Array.isArray(pageRows)) throw new Error("SupabaseのTopicログ応答が不正です。");
    rows.push(...pageRows);
    if (rows.length > MAX_TOPIC_LOG_ROWS) throw new Error("ログ件数が安全上限を超えたため集計不可（24時間のTopicログが5,000件を超えました）。");
    if (pageRows.length < TOPIC_PAGE_SIZE) break;
  }
  return rows;
}

async function supabaseTopicObservabilityRows(c, since, fetcher = fetch) {
  const query = new URL(`${c.supabaseUrl.replace(/\/$/, "")}/rest/v1/topic_observability_logs`);
  query.searchParams.set("select", "operation,status,batch_id,article_id,model,attempt_no,model_role,timeout_retry,fallback_reason,embedding_version,duration_ms,item_count,error_type,http_status,article_body_method,article_body_readability,article_body_chars,article_body_redirected,diagnostic_details,created_at");
  query.searchParams.set("created_at", `gte.${since.toISOString()}`);
  query.searchParams.set("order", "created_at.desc");
  const rows = [];
  for (let offset = 0; offset <= MAX_TOPIC_LOG_ROWS; offset += TOPIC_PAGE_SIZE) {
    const page = new URL(query);
    page.searchParams.set("limit", String(Math.min(TOPIC_PAGE_SIZE, MAX_TOPIC_LOG_ROWS + 1 - offset)));
    page.searchParams.set("offset", String(offset));
    const response = await fetcher(page, { headers: { apikey: c.serviceRole, Authorization: `Bearer ${c.serviceRole}` } });
    if (!response.ok) throw new Error(`Supabase observability log read / HTTP ${response.status}`);
    const pageRows = await response.json();
    if (!Array.isArray(pageRows)) throw new Error("Supabase observability log response invalid");
    rows.push(...pageRows);
    if (rows.length > MAX_TOPIC_LOG_ROWS) throw new Error("Topic observability log rows exceed safety limit");
    if (pageRows.length < TOPIC_PAGE_SIZE) break;
  }
  return rows;
}

async function supabaseProcessingQueueRows(c, since) {
  const query = new URL(`${c.supabaseUrl.replace(/\/$/, "")}/rest/v1/topic_processing_queue`);
  query.searchParams.set("select", "article_id,terminal_status,processed_at,queued_at,available_at,stage2_attempt_count,claimed_at,processing_started_at,external_api_started_at");
  query.searchParams.set("or", `(processed_at.gte.${since.toISOString()},processed_at.is.null)`);
  query.searchParams.set("order", "queued_at.desc");
  query.searchParams.set("limit", String(MAX_TOPIC_LOG_ROWS + 1));
  const response = await fetch(query, { headers: { apikey: c.serviceRole, Authorization: `Bearer ${c.serviceRole}` } });
  if (!response.ok) throw new Error(`Supabase processing queue read / HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length > MAX_TOPIC_LOG_ROWS) throw new Error("processing queue read exceeded safe row limit");
  return rows;
}

function summarizeTopicProcessingQueue(rows, now) {
  const current = rows.filter((row) => !row.processed_at && !row.terminal_status);
  const pending = current.filter((row) => !row.claimed_at);
  const deferred = pending.filter((row) => Number.isFinite(Date.parse(row.available_at || "")) && Date.parse(row.available_at) > now.getTime());
  const processing = current.filter((row) => Boolean(row.claimed_at));
  const staleBefore = now.getTime() - 15 * 60 * 1000;
  const staleClaims = processing.filter((row) => !row.external_api_started_at && Date.parse(row.claimed_at) < staleBefore);
  const stuckExternalCalls = processing.filter((row) => row.external_api_started_at && Date.parse(row.external_api_started_at) < staleBefore);
  return {
    status: "ok", pending: pending.length, processing: processing.length, staleClaims: staleClaims.length,
    deferred: deferred.length, nextScheduledAt: deferred.map((row) => row.available_at).sort()[0] || null,
    staleExternalCalls: stuckExternalCalls.length,
    oldestPendingAt: pending.map((row) => row.queued_at).filter(Boolean).sort()[0] || null,
    staleClaimAt: maxTime(staleClaims.map((row) => row.claimed_at)), staleExternalAt: maxTime(stuckExternalCalls.map((row) => row.external_api_started_at)),
    staleClaimIds: staleClaims.slice(0, 20).map((row) => safeDiagnosticId(row.article_id)), staleExternalIds: stuckExternalCalls.slice(0, 20).map((row) => safeDiagnosticId(row.article_id)),
    lastExecutionAt: maxTime(rows.filter((row) => row.processed_at).map((row) => row.processed_at)),
    scheduleIntervalMinutes: null, monitorState: "監視情報不足",
  };
}
function buildProcessingMonitorEvents({ queue, newsdata, schedule, outbox, now }) {
  const events = [];
  if (queue?.deferred > 0) events.push({ feature: "Topic processing queue", errorType: "stage2_retry_scheduled", what: "Stage 2 retryを延期しています", occurredAt: queue.nextScheduledAt, stage: "stage2_deferred_retry", confirmedCause: null, identifiers: {}, retry: "queueの次回処理予定", finalResult: "次回処理予定 " + (queue.nextScheduledAt || "未記録"), retrySucceeded: true, displayDetails: { pendingCount: queue.pending, deferredCount: queue.deferred, nextScheduledAt: queue.nextScheduledAt }, developerDetails: { source: "existing topic_processing_queue.available_at" } });
  if (queue?.staleClaims > 0) events.push({ feature: "Topic processing queue", errorType: "stale_claim", what: "外部API送信前のqueue claimが15分を超過", occurredAt: queue.staleClaimAt, stage: "queue_monitor", confirmedCause: "claim lease 15分超過", identifiers: { articleIds: queue.staleClaimIds.join(", ") || null }, finalResult: "再claim可能な待機状態", displayDetails: { pendingCount: queue.pending, processingCount: queue.processing, staleClaimCount: queue.staleClaims }, developerDetails: { scheduleInterval: "未記録", externalApiStarted: false } });
  if (queue?.staleExternalCalls > 0) events.push({ feature: "Topic processing queue", errorType: "long_running_external_call", what: "外部API開始後の処理が15分を超過", occurredAt: queue.staleExternalAt, stage: "queue_monitor", confirmedCause: null, identifiers: { articleIds: queue.staleExternalIds.join(", ") || null }, finalResult: "処理状態を確認してください", displayDetails: { pendingCount: queue.pending, processingCount: queue.processing, staleExternalCalls: queue.staleExternalCalls }, developerDetails: { scheduleInterval: "未記録", leaseRecovery: "外部API開始後は自動再claim対象外" } });
  if (outbox?.staleClaimed > 0) events.push({ feature: "Vector Outbox", errorType: "stale_outbox_claim", what: "Vector Outboxのclaimが15分を超過", occurredAt: outbox.oldestStaleClaimAt, stage: "outbox_monitor", confirmedCause: "claimが15分超過", identifiers: { topicId: outbox.oldestStaleTopicId }, finalResult: "同期滞留を確認してください", displayDetails: { pendingCount: outbox.pending, processingCount: outbox.processing, staleClaimed: outbox.staleClaimed, oldestPendingWaitMinutes: outbox.oldestPendingWaitMinutes }, developerDetails: { retry: "再claim状況は未記録" } });
  const nextAt = Date.parse(schedule?.nextFetchAt || ""), observedAt = Date.parse(newsdata?.lastExecutionAt || "");
  if (!schedule?.quotaExhausted && Number.isFinite(nextAt) && now.getTime() > nextAt + 2 * 60 * 60 * 1000 && (!Number.isFinite(observedAt) || observedAt < nextAt)) {
    events.push({ feature: "NewsData定期処理", errorType: "scheduled_run_missed", what: "次回利用可能予定を2時間超えてもNewsData処理記録がありません", occurredAt: schedule.nextFetchAt, stage: "scheduled_run_monitor", confirmedCause: null, finalResult: "処理停止の可能性を検知", displayDetails: { lastExecutionAt: newsdata?.lastExecutionAt || schedule.lastFetchAt, nextFetchAt: schedule.nextFetchAt, intervalMinutes: schedule.cronIntervalMinutes }, developerDetails: { schedule: "毎時05分", scheduleSource: schedule.cronScheduleSource, observedRunAt: newsdata?.lastExecutionAt || null } });
  }
  return events;
}
async function supabaseTopicVectorOutbox(c, fetcher = fetch, now = new Date()) {
  const base = `${c.supabaseUrl.replace(/\/$/, "")}/rest/v1/topic_vector_outbox`;
  const headers = { apikey: c.serviceRole, Authorization: `Bearer ${c.serviceRole}`, Prefer: "count=exact", Range: "0-0" };
  async function countRows(filters, orderBy) {
    const query = new URL(base);
    query.searchParams.set("select", "topic_id,updated_at,claimed_at");
    query.searchParams.set("limit", "1");
    query.searchParams.set("order", orderBy);
    for (const [key, value] of Object.entries(filters)) query.searchParams.set(key, value);
    const response = await fetcher(query, { headers });
    if (!response.ok) throw externalFailure("Supabase", "topic_vector_outbox read", new Error(`HTTP ${response.status}`));
    const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
    if (!match) throw new Error("topic vector outbox count unavailable");
    const sample = await response.json();
    if (!Array.isArray(sample)) throw new Error("topic vector outbox sample invalid");
    return { count: Number(match[1]), sample: sample[0] || null };
  }
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const [pending, processing, staleClaimed] = await Promise.all([
    countRows({ claim_token: "is.null" }, "updated_at.asc"),
    countRows({ claim_token: "not.is.null" }, "claimed_at.asc"),
    countRows({ claim_token: "not.is.null", claimed_at: `lt.${staleBefore}` }, "claimed_at.asc"),
  ]);
  const oldestPendingAt = pending.sample?.updated_at || null;
  return {
    status: "ok", pending: pending.count, processing: processing.count, staleClaimed: staleClaimed.count,
    syncFailures: null, syncFailureTracking: "not_recorded", oldestPendingAt,
    oldestPendingWaitMinutes: oldestPendingAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldestPendingAt)) / 60000)) : null,
    oldestStaleClaimAt: staleClaimed.sample?.claimed_at || null,
    oldestStaleTopicId: safeDiagnosticId(staleClaimed.sample?.topic_id),
    oldestPendingTopicId: safeDiagnosticId(pending.sample?.topic_id),
  };
}
async function redisPipeline(c, commands) {
  const endpoint = `${c.redisUrl.replace(/\/$/, "")}/pipeline`;
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${c.redisToken}`, "Content-Type": "application/json" }, body: JSON.stringify(commands) });
  } catch (error) {
    throw externalFailure("Upstash", "Redis read", error);
  }
  if (!response.ok) throw new Error(`Upstashへの接続に失敗しました（Redis read / HTTP ${response.status}）。`);
  const data = await response.json();
  if (!Array.isArray(data) || data.some((item) => item.error)) throw new Error("Upstash Redis の読取結果が不正です。");
  return data.map((item) => item.result);
}

function parseJson(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function externalFailure(service, operation, error) {
  const failure = new Error(service + " request failed (" + operation + ")");
  failure.causeCode = error?.cause?.code || error?.code || null;
  failure.causeName = error?.cause?.name || error?.name || null;
  return failure;
}

function aggregateNewsData(jobs, todayStart) {
  const allRequests = jobs.flatMap((job) => Array.isArray(job.requests) ? job.requests.map((request) => ({ job, request })) : []);
  const in24h = jobs.filter((job) => Date.parse(job.run_started_at) >= Date.now() - 24 * 60 * 60 * 1000);
  const success = jobs.filter((job) => job.successful_requests > 0 && !job.stopped_by_error);
  const newItems = allRequests.reduce((n, item) => n + (Number(item.request.new_items) || 0), 0);
  const todayRequests = allRequests.filter((item) => Date.parse(item.request.started_at) >= todayStart.getTime());
  const diagnosticEvents = allRequests.filter((item) => item.request.status === "error" || item.request.error_type || item.job.stopped_by_error && item.job.error_request_index === item.request.request_index).map(({ job, request }) => ({
    timestamp: request.started_at || job.run_finished_at || job.run_started_at,
    errorType: request.error_type || job.error_type || "api_error",
    httpStatus: request.error_status ?? job.error_status ?? null,
    runId: job.run_id || null, requestMode: request.request_mode || null, stage: "fetch",
    what: "NewsData.io requestで失敗（" + (request.error_type || job.error_type || "原因未記録") + "）",
    finalResult: request.status || (job.stopped_by_error ? "error" : null),
    developerDetails: { requestIndex: request.request_index ?? null, networkCategory: request.network_category || null, networkCause: request.network_cause || null, networkCauseName: request.network_cause_name || null, schedulerMode: request.scheduler_mode || job.scheduler_mode || null },
  }));
  return {
    todayRequests: todayRequests.length, fetched24h: in24h.reduce((n, job) => n + (Number(job.raw_fetched) || 0), 0), newItems,
    alreadyKnown: allRequests.reduce((n, item) => n + (Number(item.request.already_known_items) || 0), 0),
    newRate: rate(newItems, newItems + allRequests.reduce((n, item) => n + (Number(item.request.already_known_items) || 0), 0)), newPerRequest: rate(newItems, allRequests.length),
    apiErrors: countBy(jobs, (job) => Boolean(job.stopped_by_error)), http429: countBy(allRequests, (item) => item.request.error_status === 429),
    http5xx: countBy(allRequests, (item) => item.request.error_status >= 500 && item.request.error_status <= 599),
    lastSuccessAt: maxTime(success.map((job) => job.run_finished_at)), lastExecutionAt: maxTime(jobs.map((job) => job.run_finished_at || job.run_started_at)),
    diagnosticEvents,
    anomalies: jobs.filter((job) => job.stopped_by_error).sort((a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at)).map((job) => ({ timestamp: job.run_finished_at || job.run_started_at, subsystem: "NewsData", stage: "fetch", errorType: job.error_type || "api_error", httpStatus: job.error_status || null, durationMs: job.elapsed_ms || null })),
  };
}
function safeDiagnosticId(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  return "sha256:" + crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
function releaseVersionAt(timestamp) {
  const value = Date.parse(timestamp || "");
  if (!Number.isFinite(value)) return null;
  const release = TOPIC_PROCESSING_RELEASES.filter((item) => Date.parse(item.deployedAt) <= value).at(-1);
  return release?.version || (value < Date.parse(TOPIC_PROCESSING_RELEASES[0]?.deployedAt || "") ? "v83以前" : null);
}

function aggregateDashboardDiagnostics(input = []) {
  const events = Array.isArray(input) ? input.map((row) => row.feature ? row : ({
    feature: row.subsystem || "処理", errorType: row.errorType || "未記録",
    what: row.errorType ? "エラー種別: " + row.errorType : "エラー記録があります",
    occurredAt: row.timestamp || null, stage: row.stage || null, confirmedCause: row.errorType || null,
    identifiers: {}, httpStatus: row.httpStatus ?? null, retry: null, finalResult: null, count: 1,
    developerDetails: { subsystem: row.subsystem || null, stage: row.stage || null, errorType: row.errorType || null, httpStatus: row.httpStatus ?? null, durationMs: row.durationMs ?? null },
  })) : [];
  const currentVersion = TOPIC_PROCESSING_RELEASES.at(-1)?.version;
  const signatures = new Set(events.filter((event) => event.deploymentVersion === currentVersion).map((event) => [event.feature, event.stage, event.errorType].join("|")));
  for (const event of events) {
    if (event.retrySucceeded) event.classification = "経過観察";
    else if (event.deploymentVersion && event.deploymentVersion !== currentVersion && !signatures.has([event.feature, event.stage, event.errorType].join("|"))) event.classification = "過去の問題";
    else event.classification = "要対応";
  }
  const groups = new Map();
  for (const event of events) {
    const group = groups.get(event.feature) || { feature: event.feature, events: [], errorTypes: new Set(), errorCount: 0 };
    group.events.push(event); group.errorTypes.add(event.errorType || "未記録");
    group.errorCount += Number.isFinite(Number(event.count)) ? Number(event.count) : 1;
    groups.set(event.feature, group);
  }
  return [...groups.values()].map((group) => {
    group.events.sort((a, b) => Date.parse(b.occurredAt || "") - Date.parse(a.occurredAt || ""));
    const classification = group.events.some((event) => event.classification === "要対応") ? "要対応" : group.events.some((event) => event.classification === "経過観察") ? "経過観察" : "過去の問題";
    return { feature: group.feature, errorTypes: [...group.errorTypes], errorCount: group.errorCount, lastOccurredAt: group.events[0]?.occurredAt || null,
      currentState: classification === "要対応" ? "未解決のエラー記録あり" : classification === "経過観察" ? "一時失敗またはretry成功を記録" : "旧版の問題。現行版での再発は未確認",
      classification, events: group.events };
  }).sort((a, b) => Date.parse(b.lastOccurredAt || "") - Date.parse(a.lastOccurredAt || ""));
}
function buildDashboardDiagnosticEvents({ topicRows = [], observabilityRows = [], newsdataEvents = [], titleBatches = [], titleRows = [], monitoringEvents = [] } = {}) {
  const events = [];
  const stage1Rows = observabilityRows.filter((row) => row.operation === "stage1_attempt");
  const hasLaterSuccess = (row) => Boolean(row.batch_id && stage1Rows.some((later) => later.batch_id === row.batch_id && later.status === "success" && Date.parse(later.created_at) >= Date.parse(row.created_at)));
  const recordedBatches = new Set(observabilityRows.filter((row) => ["stage1_attempt", "stage2_attempt"].includes(row.operation)).map((row) => row.operation + ":" + (row.batch_id || "")));
  const versionedFeatures = new Set(["記事本文取得", "Stage 1", "Stage 2 / Gemma 4 26B", "Upstash Vector検索", "Vector Outbox", "タイトル生成", "Embedding", "Topic / DB保存", "Topic処理", "Topic processing queue"]);
  const add = (event) => events.push({ count: 1, identifiers: {}, httpStatus: null, retry: null, finalResult: null, confirmedCause: null, ...event, deploymentVersion: event.deploymentVersion ?? (versionedFeatures.has(event.feature) ? releaseVersionAt(event.occurredAt) : null) });

  for (const row of topicRows) {
    if (!/^failed_/.test(row.status || "") && !row.error_type) continue;
    if (row.stage === "gemma_stage1" && recordedBatches.has("stage1_attempt:" + (row.batch_id || ""))) continue;
    if (row.stage === "gemma_stage2" && recordedBatches.has("stage2_attempt:" + (row.batch_id || ""))) continue;
    const feature = row.status === "failed_embedding" || row.stage === "embedding" ? "Embedding" : row.status === "failed_search" || row.stage === "topic_search" ? "Upstash Vector検索" : row.status === "failed_db" ? "Topic / DB保存" : "Topic処理";
    add({ feature, errorType: row.error_type || row.status || "未記録", what: (row.stage || "処理") + "で失敗を記録", occurredAt: row.created_at || null, stage: row.stage || null, confirmedCause: row.error_type || null,
      identifiers: { logId: safeDiagnosticId(row.id), articleId: safeDiagnosticId(row.article_id), topicId: safeDiagnosticId(row.topic_id || row.candidate_topic_id), batchId: safeDiagnosticId(row.batch_id) },
      httpStatus: row.gemma_http_status ?? null, finalResult: row.status || null,
      developerDetails: { status: row.status || null, durationMs: row.gemma_api_duration_ms ?? row.duration_ms ?? null, embeddingModel: row.embedding_model || null, embeddingVersion: row.embedding_version || null } });
  }

  for (const row of observabilityRows) {
    if (row.status !== "failure") continue;
    const details = row.diagnostic_details && typeof row.diagnostic_details === "object" ? row.diagnostic_details : {};
    const quota = details.quota && typeof details.quota === "object" ? details.quota : null;
    const feature = row.operation === "article_body" ? "記事本文取得" : row.operation === "stage1_attempt" ? "Stage 1" : row.operation === "stage2_attempt" ? "Stage 2 / Gemma 4 26B" : row.operation === "vector_search" ? "Upstash Vector検索" : row.operation === "outbox_sync" ? "Vector Outbox" : "Topic処理";
    const stage2Recovered = row.operation === "stage2_attempt" && row.status === "failure" && details.finalResult === "success";
    const stage2Deferred = row.operation === "stage2_attempt" && details.finalResult === "deferred";
    add({ feature, errorType: row.error_type || "未記録", what: row.operation === "article_body" ? "記事本文取得に失敗（" + (row.error_type || "原因未記録") + "）" : row.operation + "で失敗",
      occurredAt: row.created_at || null, stage: row.operation, confirmedCause: row.error_type || null,
      identifiers: { articleId: safeDiagnosticId(row.article_id), batchId: safeDiagnosticId(row.batch_id) }, httpStatus: row.http_status ?? null,
      retry: row.operation === "stage1_attempt" ? (row.timeout_retry === true ? "timeout retry試行" : "retry未記録") : details.retryCount == null ? null : details.retryCount + "回",
      retrySucceeded: (row.operation === "stage1_attempt" && hasLaterSuccess(row)) || stage2Recovered || stage2Deferred,
      finalResult: stage2Deferred ? "延期・次回処理予定 " + (details.scheduledAt || "未記録") : stage2Recovered ? "retry後成功・最終HTTP " + (details.finalHttpStatus ?? "不明") : row.operation === "stage2_attempt" && details.finalResult === "success" ? "成功・最終HTTP " + (details.finalHttpStatus ?? "不明") : "失敗を記録",
      displayDetails: { provider: details.provider, model: details.model || row.model, quotaScope: quota?.scope, quotaReason: quota?.reason, quotaAxis: quota?.axis, quotaWindow: quota?.window, quotaLimit: quota?.limit, quotaUsed: quota?.used, quotaRequested: quota?.requested, quotaReserved: quota?.reserved, quotaNextAvailableAt: quota?.nextAvailableAt,
        apiSendState: details.apiSendState, transportErrorType: details.transportErrorType, domain: details.domain, finalDomain: details.finalDomain, redirected: row.article_body_redirected,
        domParse: details.domParse, readability: row.article_body_readability, readabilityFailure: details.readabilityFailure, exceptionType: details.exceptionType, bodyChars: row.article_body_chars,
        finalExclusionReason: details.finalExclusionReason, finishReason: details.finishReason, sseReadCompleted: details.sseReadCompleted, sseCompletionConfirmed: details.sseCompletionConfirmed,
        jsonParseResult: details.jsonParseResult, commentValidationReason: details.commentValidationReason, affectedArticleCount: details.affectedArticleCount,
        retryCount: details.retryCount, retryAfterMs: details.retryAfterMs, retryWaitMs: details.retryWaitMs, firstHttpError: details.firstHttpError ? "HTTP " + details.firstHttpError.status + (details.firstHttpError.errorType ? " " + details.firstHttpError.errorType : "") : null,
        finalHttpStatus: details.finalHttpStatus, quotaRetryStopped: details.quotaRetryStopped, scheduledAt: details.scheduledAt, rateLimitType: details.rateLimitType },
      developerDetails: { errorType: row.error_type || null, operation: row.operation, durationMs: row.duration_ms ?? null, itemCount: row.item_count ?? null, attemptNo: row.attempt_no ?? null, modelRole: row.model_role ?? null, details } });
  }

  for (const batch of titleBatches) {
    const retries = Math.max(0, (Number(batch.attempts) || 1) - 1);
    if (!(Number(batch.failure_count) > 0 || Number(batch.http_status) >= 400 || retries > 0)) continue;
    const topicIds = titleRows.filter((row) => row.claim_id && row.claim_id === batch.id).map((row) => row.topic_id).filter(Boolean).slice(0, 20);
    const failureCount = Number(batch.failure_count) || 0;
    add({ feature: "タイトル生成", errorType: Object.keys(batch.failure_types || {})[0] || (batch.http_status ? "http_" + batch.http_status : retries ? "retry_succeeded" : "title_failure"),
      what: failureCount > 0 ? "タイトル生成batchで" + failureCount + "件が失敗" : retries ? "タイトル生成でretryを記録" : "タイトル生成APIで失敗",
      occurredAt: batch.request_finished_at || batch.created_at || null, stage: "thread_title_batch", confirmedCause: Object.keys(batch.failure_types || {})[0] || null,
      identifiers: { batchId: safeDiagnosticId(batch.id), topicIds: topicIds.map(safeDiagnosticId).join(", ") || null }, httpStatus: batch.http_status ?? null,
      retry: retries ? retries + "回（全attempt " + batch.attempts + "回）" : "retry記録なし", retrySucceeded: retries > 0 && failureCount === 0,
      finalResult: failureCount > 0 ? failureCount + "件失敗" : "batch成功", count: Math.max(1, failureCount || (retries > 0 ? 1 : 0)),
      displayDetails: { model: batch.model, targetCount: batch.batch_size, topicCount: Number(batch.success_count || 0) + failureCount, retryAttempts: retries, quotaAxis: batch.quota_day_pt ? "日次quota" : null, quotaUsed: batch.used_today_at_request },
      developerDetails: { failureTypes: batch.failure_types || null, finishReason: batch.finish_reason || null, attempts: batch.attempts ?? null } });
  }

  for (const item of newsdataEvents) add({ feature: "NewsData", errorType: item.errorType || "未記録", what: item.what || "NewsData取得で失敗", occurredAt: item.timestamp || null,
    stage: item.stage || "fetch", confirmedCause: item.errorType || null, identifiers: { runId: safeDiagnosticId(item.runId), requestMode: item.requestMode || null },
    httpStatus: item.httpStatus ?? null, retry: item.retry ?? null, finalResult: item.finalResult || "失敗", displayDetails: { provider: "NewsData.io", transportErrorType: item.transportErrorType || null }, developerDetails: item.developerDetails || {} });
  for (const event of monitoringEvents) add(event);
  return events;
}
async function redisDashboard(c, now) {
  const nowMs = now.getTime();
  const todayStart = jstTodayStart(now);
  const jobsSince = new Date(Math.min(todayStart.getTime(), nowMs - 24 * 60 * 60 * 1000));
  const [jobIds, stateRaw, activeUrls] = await redisPipeline(c, [
    ["ZRANGEBYSCORE", "newsdata:jobs", jobsSince.getTime(), "+inf"], ["GET", "newsdata:v2:state"], ["ZRANGEBYSCORE", "rss:active", Math.floor(nowMs / 1000) - RSS_ACTIVE_WINDOW_SECONDS, "+inf"],
  ]);
  const jobKeys = jobIds.map((jobId) => `newsdata:job:${jobId}`);
  const jobsRaw = jobKeys.length ? (await redisPipeline(c, [["MGET", ...jobKeys]]))[0] : [];
  const metaKeys = activeUrls.map((url) => `rss:meta:${url}`);
  const metasRaw = metaKeys.length ? (await redisPipeline(c, [["MGET", ...metaKeys]]))[0] : [];
  const jobs = (jobsRaw || []).map((raw) => parseJson(raw)).filter(Boolean);
  const metas = (metasRaw || []).map((raw) => parseJson(raw)).filter(Boolean);
  const rssUpdated = metas.map((meta) => meta.updated_at).filter(Boolean);
  const newsdata = aggregateNewsData(jobs, todayStart);
  const schedulerState = parseJson(stateRaw);
  const asIso = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value)).toISOString() : null;
  const nextByMode = { normal: asIso(schedulerState?.next_normal_fetch_at), tech: asIso(schedulerState?.next_tech_fetch_at), subculture: asIso(schedulerState?.next_subculture_fetch_at) };
  const nextTimes = Object.values(nextByMode).filter(Boolean).map(Date.parse);
  newsdata.nextFetchAt = nextTimes.length ? new Date(Math.min(...nextTimes)).toISOString() : null;
  newsdata.cronIntervalMinutes = schedulerState ? 60 : null;
  newsdata.monitorState = schedulerState?.quota_exhausted_at ? "quota待機" : schedulerState && newsdata.nextFetchAt ? "監視中" : "監視情報不足";
  return { newsdata, rss: { activeFeeds: activeUrls.length, lastSuccessAt: maxTime(rssUpdated), staleFeeds: null, staleCriteria: "判定基準なし", monitorState: "監視情報不足" },
    redisLastSuccessAt: maxTime([...rssUpdated, ...jobs.map((j) => j.run_finished_at)]), schedulerStatePresent: Boolean(schedulerState),
    newsdataSchedule: { lastFetchAt: asIso(schedulerState?.last_fetch_at), nextFetchAt: nextTimes.length ? new Date(Math.min(...nextTimes)).toISOString() : null, nextByMode, cronIntervalMinutes: 60, cronScheduleSource: "supabase/sql/newsdata_cron.sql", quotaExhausted: Boolean(schedulerState?.quota_exhausted_at) } };
}

function safeFailure(error) { const m=String(error?.message||""); const h=m.match(/HTTP (\d{3})/); return {type:error?.cause?.name||error?.causeName||error?.name||"Error",code:error?.cause?.code||error?.causeCode||error?.code||null,httpStatus:h?Number(h[1]):null}; }

async function supabaseEmbeddingQuota(c){const url=new URL(c.supabaseUrl.replace(/\/$/,"")+"/rest/v1/topic_embedding_quota_state");url.searchParams.set("select","embedding_model,quota_day_pt,used_today,quota_exhausted_at,reset_probe_started_at,first_success_after_reset,updated_at");url.searchParams.set("limit","10");const r=await fetch(url,{headers:{apikey:c.serviceRole,Authorization:"Bearer "+c.serviceRole}});if(!r.ok)throw new Error("Supabase quota read / HTTP "+r.status);const rows=await r.json();if(!Array.isArray(rows))throw new Error("quota response invalid");return{status:"ok",models:rows.map(x=>({model:x.embedding_model,quotaDayPt:x.quota_day_pt,usedToday:x.used_today,exhausted:Boolean(x.quota_exhausted_at),resetProbeStartedAt:x.reset_probe_started_at,firstSuccessAfterReset:x.first_success_after_reset,updatedAt:x.updated_at}))};}
async function dashboardData(){const c=config(),now=new Date(),since=new Date(now.getTime()-86400000),connections={supabase:{status:c.supabaseUrl&&c.serviceRole?"pending":"not_configured"},redis:{status:c.redisUrl&&c.redisToken?"pending":"not_configured"}};const results=await Promise.allSettled([c.supabaseUrl&&c.serviceRole?supabaseTopicRows(c,since):Promise.reject(new Error("missing_config")),c.supabaseUrl&&c.serviceRole?supabaseThreadTitleRows(c,since):Promise.reject(new Error("missing_config")),c.supabaseUrl&&c.serviceRole?supabaseEmbeddingQuota(c):Promise.reject(new Error("missing_config")),c.redisUrl&&c.redisToken?redisDashboard(c,now):Promise.reject(new Error("missing_config")),c.supabaseUrl&&c.serviceRole?supabaseProcessingQueueRows(c,since):Promise.reject(new Error("missing_config")),c.supabaseUrl&&c.serviceRole?supabaseTopicVectorOutbox(c,fetch,now):Promise.reject(new Error("missing_config")),c.supabaseUrl&&c.serviceRole?supabaseTopicObservabilityRows(c,since):Promise.reject(new Error("missing_config"))]);const [tr,qr,er,rr,pr,or,vr]=results,topicRows=tr.status==="fulfilled"?tr.value:[],titles=qr.status==="fulfilled"?qr.value:{rows:[],batches:[]},queueRows=pr.status==="fulfilled"?pr.value:[],topicAvailable=tr.status==="fulfilled";connections.supabase.status=topicAvailable&&qr.status==="fulfilled"&&er.status==="fulfilled"&&or.status==="fulfilled"&&vr.status==="fulfilled"?"ok":topicAvailable||qr.status==="fulfilled"||er.status==="fulfilled"||or.status==="fulfilled"||vr.status==="fulfilled"?"partial":"error";connections.supabase.error=tr.status==="rejected"?safeFailure(tr.reason):or.status==="rejected"?safeFailure(or.reason):vr.status==="rejected"?safeFailure(vr.reason):null;const recentTitleRows=titles.rows.filter(row=>Date.parse(row.queued_at)>=since.getTime());const topic=aggregateTopics(topicRows,recentTitleRows,queueRows,vr.status==="fulfilled"?vr.value:null);topic.processingMonitor=summarizeTopicProcessingQueue(queueRows,now);topic.availability=topicAvailable?"ok":"unavailable";const openTitleRows=titles.rows.filter(row=>["pending","claimed","processing"].includes(row.status));topic.quality.threadTitleMonitor={pending:openTitleRows.filter(row=>row.status==="pending").length,processing:openTitleRows.filter(row=>["claimed","processing"].includes(row.status)).length,oldestPendingAt:openTitleRows.filter(row=>row.status==="pending").map(row=>row.queued_at).filter(Boolean).sort()[0]||null,intervalMinutes:null,status:openTitleRows.length?"監視情報不足":"対象なし"};topic.quality.threadTitleBatchCount=titles.batches.length;topic.quality.threadTitleApiAttempts=titles.batches.reduce((n,x)=>n+(Number(x.attempts)||1),0);topic.quality.threadTitleRetryAttempts=titles.batches.reduce((n,x)=>n+Math.max(0,(Number(x.attempts)||1)-1),0);topic.quality.threadTitleLatestBatchSuccessAt=maxTime(titles.batches.filter(x=>Number(x.success_count)>0).map(x=>x.request_finished_at));topic.quality.threadTitleLatestBatchFailedAt=maxTime(titles.batches.filter(x=>Number(x.failure_count)>0).map(x=>x.request_finished_at));topic.quality.threadTitleTokens={input:titles.batches.reduce((n,x)=>n+(Number(x.input_tokens)||0),0),output:titles.batches.reduce((n,x)=>n+(Number(x.output_tokens)||0),0),thinking:titles.batches.reduce((n,x)=>n+(Number(x.thinking_tokens)||0),0)};topic.quality.threadTitleBatchDurationMs=titles.batches.map(x=>x.duration_ms).filter(Number.isFinite);topic.quality.threadTitleQuota=titles.batches.map(x=>({quotaDayPt:x.quota_day_pt,usedTodayAtRequest:x.used_today_at_request,probe:x.probe,httpStatus:x.http_status,attempts:Number(x.attempts)||1,model:x.model,createdAt:x.created_at}));const quotaGroups=new Map();for(const x of topic.quality.threadTitleQuota){const k=JSON.stringify([x.model||null,x.quotaDayPt||null]);const q=quotaGroups.get(k)||{model:x.model||null,quotaDayPt:x.quotaDayPt||null,latestUsedToday:null,latestAt:null,httpStatusCounts:{},probeCount:0};if(x.httpStatus!=null)q.httpStatusCounts[x.httpStatus]=(q.httpStatusCounts[x.httpStatus]||0)+1;if(x.probe)q.probeCount++;if(x.usedTodayAtRequest!=null&&(!q.latestAt||Date.parse(x.createdAt)>Date.parse(q.latestAt))){q.latestAt=x.createdAt;q.latestUsedToday=x.usedTodayAtRequest;}quotaGroups.set(k,q);}topic.quality.threadTitleQuotaSummary=[...quotaGroups.values()];topic.quality.threadTitleBatchFailureReasons=Object.fromEntries([...new Set(titles.batches.flatMap(x=>x.failure_types&&typeof x.failure_types==="object"?Object.keys(x.failure_types):[]))].map(k=>[k,titles.batches.reduce((n,x)=>n+(Number(x.failure_types?.[k])||0),0)]));topic.releaseAudit=topicReleaseAudit(since,now,topicRows,titles.rows,titles.batches,vr.status==="fulfilled"?vr.value:null);topic.embedding.quota=er.status==="fulfilled"?er.value:{status:"unavailable",models:[]};const redis=rr.status==="fulfilled"?rr.value:null;connections.redis.status=redis?"ok":"error";connections.redis.error=rr.status==="rejected"?safeFailure(rr.reason):null;const newsdata=redis?.newsdata??null,rss=redis?.rss??null,anomalies=[...(topicAvailable?topic.anomalies:[]),...(newsdata?.anomalies??[])].sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).slice(0,15),diagnosticEvents=buildDashboardDiagnosticEvents({topicRows:topicAvailable?topicRows:[],observabilityRows:vr.status==="fulfilled"?vr.value:[],newsdataEvents:newsdata?.diagnosticEvents??[],titleRows:titles.rows,titleBatches:titles.batches,monitoringEvents:buildProcessingMonitorEvents({queue:topic.processingMonitor,newsdata,schedule:redis?.newsdataSchedule,outbox:or.status==="fulfilled"?or.value:null,now})}),diagnostics=aggregateDashboardDiagnostics(diagnosticEvents),attention=Boolean(topic.outcomes.failed_db.count||topic.gemma.http429||topic.gemma.http5xx||(newsdata&&(newsdata.http429||newsdata.http5xx)))||diagnostics.some(group=>group.classification==="要対応");return{generatedAt:now.toISOString(),period:{since:since.toISOString(),todayStart:jstTodayStart(now).toISOString(),description:"\u904e\u53bb24\u6642\u9593\u3002\u8a18\u4e8b\u7d50\u679c\u306farticle_id\u5225\u306e\u6700\u7d42\u72b6\u614b\u3001AI\u51e6\u7406\u306fStage\u8a66\u884c\u30ed\u30b0\u5358\u4f4d\u3001\u30b9\u30ec\u30c3\u30c9\u4f5c\u6210\u5f85\u3061\u306fTopic queue\u5358\u4f4d\u3002"},connections,overall:{status:!topicAvailable&&!redis?"unavailable":attention?"attention":"normal"},topic,topicVectorOutbox:or.status==="fulfilled"?{...or.value,...topic.topicOutbox,observationStatus:vr.status==="fulfilled"?"ok":"unavailable",observationError:vr.status==="rejected"?safeFailure(vr.reason):null}:{status:"unavailable",pending:null,processing:null,staleClaimed:null,syncFailures:null,syncFailureTracking:"unavailable",readError:safeFailure(or.reason)},newsdata,rss,infrastructure:{failedDb:topic.outcomes.failed_db.count,lastNormalDbAt:topic.lastNormalAt,cronEstimate:redis?(redis.schedulerStatePresent?"\u30cb\u30e5\u30fc\u30b9\u53ce\u96c6\u306e\u5b9a\u671f\u51e6\u7406: \u72b6\u614b\u8a18\u9332\u3042\u308a":"\u30cb\u30e5\u30fc\u30b9\u53ce\u96c6\u306e\u5b9a\u671f\u51e6\u7406: \u672a\u78ba\u8a8d"):"\u672a\u53d6\u5f97",redisLastSuccessAt:redis?.redisLastSuccessAt??null,links:c.links},anomalies,diagnostics};}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
function reply(res, status, body, type = "application/json; charset=utf-8") { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(body); }
function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(`${ROOT}${path.sep}`) || !CONTENT_TYPES[path.extname(file)] || !fs.existsSync(file)) return reply(res, 404, "Not found", "text/plain; charset=utf-8");
  reply(res, 200, fs.readFileSync(file), CONTENT_TYPES[path.extname(file)]);
}
function createServer() { return http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method !== "GET") return reply(res, 405, JSON.stringify({ error: "method_not_allowed" }));
  if (url.pathname === "/health") {
    const c = config();
    return reply(res, 200, JSON.stringify({ ok: true, configurationReady: Boolean(c.supabaseUrl && c.serviceRole && c.redisUrl && c.redisToken) }));
  }
  if (url.pathname === "/api/dashboard") { try { return reply(res, 200, JSON.stringify(await dashboardData())); } catch (error) { return reply(res, 503, JSON.stringify({ error: error instanceof Error ? error.message : "ダッシュボードの集計に失敗しました。" })); } }
  if (url.pathname === "/api/topic-pregen") return reply(res, 200, JSON.stringify(await topicPregenStatus()));
  serveStatic(res, url.pathname);
}); }
if (require.main === module) createServer().listen(PORT, HOST, () => console.log(`AI速 Operations: http://${HOST}:${PORT}`));
module.exports = { createServer, aggregateTopics, aggregateTopicObservability, aggregateDashboardDiagnostics, buildDashboardDiagnosticEvents, aggregateNewsData, topicReleaseAudit, jstTodayStart, percentile, supabaseTopicRows, supabaseTopicObservabilityRows, supabaseThreadTitleRows, supabaseProcessingQueueRows, summarizeTopicProcessingQueue, buildProcessingMonitorEvents, supabaseTopicVectorOutbox, dashboardData, topicPregenStatus, safeTopicPregenState };
