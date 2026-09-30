import { topicConfig } from "./config.ts";
import type { SupabaseConfig } from "./queue.ts";
import { generateThreadTitles, type ThreadTitleInput } from "./thread_title.ts";

const headers = (c: SupabaseConfig) => ({
  Authorization: `Bearer ${c.serviceRoleKey}`,
  apikey: c.serviceRoleKey,
  "Content-Type": "application/json",
});
type Claimed = ThreadTitleInput & {
  topic_id: string;
  probe: boolean;
  quota_day_pt: string;
  used_today: number;
};

type RetryReservation = {
  allowed: boolean;
  reason: string;
  used_today: number;
  wait_ms: number;
};

async function rpc<T>(
  c: SupabaseConfig,
  name: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const r = await fetcher(`${c.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(c),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`thread_title_${name}:${r.status}`);
  const responseText = await r.text();
  return responseText.length === 0
    ? undefined as T
    : JSON.parse(responseText) as T;
}

export type TopicPregenNotificationResult = {
  status:
    | "not_configured"
    | "no_candidate"
    | "notified"
    | "rejected"
    | "candidate_lookup_failed"
    | "unavailable";
  httpStatus?: number;
};

export async function notifyTopicPregen(
  config: SupabaseConfig,
  topicIds: string[],
  endpoint: string | undefined,
  secret: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<TopicPregenNotificationResult> {
  if (!endpoint || !secret) return { status: "not_configured" };
  if (topicIds.length === 0) return { status: "no_candidate" };
  let rows: Array<{
    topic_id: string;
    title: string;
    facts: string[];
    news_url: string;
  }>;
  try {
    rows = await rpc<
      Array<{
        topic_id: string;
        title: string;
        facts: string[];
        news_url: string;
      }>
    >(
      config,
      "get_topic_pregen_inputs",
      { p_topic_ids: topicIds },
      fetcher,
    );
    let result: TopicPregenNotificationResult = { status: "no_candidate" };
    for (const row of rows) {
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic_id: row.topic_id,
            title: row.title,
            facts: row.facts,
          }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          console.warn("[TopicPregen] notification rejected", {
            status: response.status,
          });
          result = { status: "rejected", httpStatus: response.status };
        } else {
          result = { status: "notified", httpStatus: response.status };
        }
      } catch (error) {
        console.warn("[TopicPregen] notification unavailable", {
          type: error instanceof Error ? error.name : "unknown",
        });
        result = { status: "unavailable" };
      }
    }
    return result;
  } catch (error) {
    console.warn("[TopicPregen] notification candidate lookup failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return { status: "candidate_lookup_failed" };
  }
}

export function successfulTitleTopicIds(
  results: Array<{ id: string; status: string }>,
) {
  return results.filter((result) => result.status === "success")
    .map((result) => result.id);
}

export async function notifySuccessfulTopicTitles(
  config: SupabaseConfig,
  results: Array<{ id: string; status: string }>,
  endpoint: string | undefined,
  secret: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<TopicPregenNotificationResult> {
  const successfulTopicIds = successfulTitleTopicIds(results);
  if (successfulTopicIds.length === 0) return { status: "no_candidate" };
  return await notifyTopicPregen(
    config,
    successfulTopicIds,
    endpoint,
    secret,
    fetcher,
  );
}

export async function processThreadTitleBatch(
  config: SupabaseConfig,
  apiKey: string,
  options: {
    notifyPregen?: boolean;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const random = options.random ?? Math.random;
  const batchStarted = Date.now();
  const claimId = crypto.randomUUID();
  const claimed = await rpc<Claimed[]>(
    config,
    "claim_topic_thread_title_batch",
    { p_claim_id: claimId, p_limit: topicConfig.threadTitleBatchSize },
  );
  if (claimed.length !== topicConfig.threadTitleBatchSize) return false;
  const stateResponse = await fetch(
    `${config.url}/rest/v1/topic_thread_title_quota_state?singleton=eq.true&select=last_request_started_at`,
    { headers: headers(config) },
  );
  const state = stateResponse.ok
    ? (await stateResponse.json() as Array<
      { last_request_started_at: string | null }
    >)[0]
    : null;
  const elapsed = state?.last_request_started_at
    ? Date.now() - Date.parse(state.last_request_started_at)
    : Infinity;
  if (elapsed < topicConfig.threadTitleMinStartIntervalMs) {
    await sleep(topicConfig.threadTitleMinStartIntervalMs - elapsed);
  }
  const requestStartedAt = new Date().toISOString();
  const generated = [await generateThreadTitles(
    claimed.map((x) => ({
      id: x.topic_id,
      subject: x.subject,
      event: x.event,
    })),
    apiKey,
  )];
  let retryUsedToday: number | null = null;
  let retrySkippedReason: string | null = null;
  if (
    generated[0].httpStatus === 503 &&
    topicConfig.threadTitleMaxRetries > 0 &&
    !claimed[0].probe
  ) {
    const retryAfterMs = generated[0].retryAfterMs;
    if (
      retryAfterMs != null &&
      retryAfterMs > topicConfig.threadTitleMaxRetryAfterMs
    ) {
      retrySkippedReason = "retry_after_exceeds_budget";
    } else {
      const delayMs = Math.max(
        topicConfig.threadTitleMinStartIntervalMs,
        retryAfterMs ?? 0,
        1_000 + Math.floor(random() * 501),
      );
      await sleep(delayMs);
      let reservation = await rpc<RetryReservation[]>(
        config,
        "reserve_topic_thread_title_retry",
        { p_claim_id: claimId },
      );
      let reserved = reservation[0] ?? null;
      if (reserved?.reason === "request_interval") {
        await sleep(Math.max(0, reserved.wait_ms));
        reservation = await rpc<RetryReservation[]>(
          config,
          "reserve_topic_thread_title_retry",
          { p_claim_id: claimId },
        );
        reserved = reservation[0] ?? null;
      }
      if (reserved?.allowed) {
        retryUsedToday = reserved.used_today;
        await sleep(topicConfig.threadTitleMinStartIntervalMs);
        generated.push(await generateThreadTitles(
          claimed.map((x) => ({
            id: x.topic_id,
            subject: x.subject,
            event: x.event,
          })),
          apiKey,
        ));
      } else {
        retrySkippedReason = reserved?.reason || "retry_reservation_failed";
      }
    }
  }
  const finalGeneration = generated[generated.length - 1];
  const results = finalGeneration.results;
  const apiAttempts = generated.length;
  const retryStatuses = generated.slice(0, -1).map((x) => x.httpStatus);
  const summedUsage = (key: string) => generated.reduce((sum, attempt) => {
    const value = Number(attempt.usageMetadata?.[key]);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0) || null;
  const requestFinishedAt = new Date().toISOString();
  try {
    const failureTypes = results.reduce((m, x) => {
      if (x.status !== "success") m[x.status] = (m[x.status] ?? 0) + 1;
      if (x.lengthExceeded) {
        m.title_length_exceeded = (m.title_length_exceeded ?? 0) + 1;
      }
      return m;
    }, {} as Record<string, number>);
    if (retryStatuses.includes(503)) failureTypes.http_503_retries = 1;
    if (retrySkippedReason) {
      failureTypes[`http_503_${retrySkippedReason}`] = 1;
    }
    await fetch(`${config.url}/rest/v1/topic_thread_title_batches`, {
      method: "POST",
      headers: { ...headers(config), Prefer: "return=minimal" },
      body: JSON.stringify({
        id: claimId,
        claim_id: claimId,
        model: topicConfig.threadTitleModel,
        thinking_level: topicConfig.threadTitleThinkingLevel,
        batch_size: claimed.length,
        request_started_at: requestStartedAt,
        request_finished_at: requestFinishedAt,
        quota_day_pt: claimed[0].quota_day_pt,
        probe: claimed[0].probe,
        http_status: finalGeneration.httpStatus,
        finish_reason: finalGeneration.finishReason,
        attempts: apiAttempts,
        input_tokens: summedUsage("promptTokenCount"),
        output_tokens: summedUsage("candidatesTokenCount"),
        thinking_tokens: summedUsage("thoughtsTokenCount"),
        success_count: results.filter((x) => x.status === "success").length,
        failure_count: results.filter((x) => x.status !== "success").length,
        failure_types: failureTypes,
        used_today_at_request: retryUsedToday ?? claimed[0].used_today,
        duration_ms: Date.now() - batchStarted,
      }),
    });
  } catch { /* audit logging must not fail title finalization */ }
  await rpc(config, "finalize_topic_thread_title_batch", {
    p_claim_id: claimId,
    p_results: results.map((x) => ({
      id: x.id,
      title: x.title,
      status: x.status,
    })),
    p_probe: claimed[0].probe,
    p_http_status: finalGeneration.httpStatus,
    p_duration_ms: Date.now() - batchStarted,
  });
  if (options.notifyPregen !== false) {
    const notification = await notifySuccessfulTopicTitles(
      config,
      results,
      Deno.env.get("TOPIC_PREGEN_URL"),
      Deno.env.get("TOPIC_PREGEN_NOTIFICATION_SECRET"),
    );
    if (notification.status !== "no_candidate") {
      console.log("[TopicPregen] notification outcome", {
        status: notification.status,
        httpStatus: notification.httpStatus ?? null,
      });
    }
  }
  return true;
}
