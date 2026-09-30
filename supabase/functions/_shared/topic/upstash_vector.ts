import type { SupabaseConfig } from "./queue.ts";
import { safeReadJson } from "./queue.ts";
import {
  safeTopicOperationErrorType,
  safeTopicOperationHttpStatus,
  saveTopicObservabilityRows,
} from "./log.ts";

export const TOPIC_VECTOR_NAMESPACE = "topic-openai-v1";
export const TOPIC_VECTOR_VERSION = "openai/text-embedding-3-small:1536:v1";
export const TOPIC_VECTOR_THRESHOLD = 0.88;
export const TOPIC_VECTOR_BATCH_SIZE = 100;

export type TopicVectorRecord = {
  topic_id: string;
  topic_text: string;
  subject: string;
  event: string;
  category: string;
  last_seen_at: string;
};

function vectorHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function upsertTopicVectorBatch(
  url: string,
  token: string,
  records: TopicVectorRecord[],
  fetcher = fetch,
) {
  if (!records.length) return;
  const payload = records.map((r) => ({
    id: r.topic_id,
    data: r.topic_text,
    metadata: {
      topic_id: r.topic_id,
      subject: r.subject,
      event: r.event,
      category: r.category,
      last_seen_at_ms: Date.parse(r.last_seen_at),
    },
  }));
  const response = await fetcher(
    `${url.replace(/\/$/, "")}/upsert-data/${TOPIC_VECTOR_NAMESPACE}`,
    {
      method: "POST",
      headers: vectorHeaders(token),
      body: JSON.stringify(payload),
    },
  );
  await safeReadJson<{ result: string }>(
    response,
    "Upstash Topic vector upsert",
  );
}

export async function queryTopicVector(
  url: string,
  token: string,
  topicText: string,
  cutoff: number,
  fetcher = fetch,
  category?: string,
) {
  const categoryClause = category === undefined
    ? ""
    : ` AND category = '${category.replaceAll("'", "\\'")}'`;
  const response = await fetcher(
    `${url.replace(/\/$/, "")}/query-data/${TOPIC_VECTOR_NAMESPACE}`,
    {
      method: "POST",
      headers: vectorHeaders(token),
      body: JSON.stringify({
        data: topicText,
        topK: 1,
        includeMetadata: true,
        filter: `last_seen_at_ms >= ${cutoff}${categoryClause}`,
      }),
    },
  );
  const body = await safeReadJson<
    {
      result?: Array<
        {
          id: string;
          score: number;
          metadata?: {
            topic_id?: string;
            subject?: string;
            event?: string;
            category?: string;
            last_seen_at_ms?: number;
          };
        }
      >;
    }
  >(response, "Upstash Topic vector query");
  const match = body.result?.[0];
  if (
    !match || match.metadata?.category === undefined ||
    match.metadata.topic_id !== match.id
  ) return null;
  return {
    topic_id: match.id,
    subject: match.metadata.subject ?? "",
    event: match.metadata.event ?? "",
    similarity: match.score,
    category: match.metadata.category,
    embedding_model: TOPIC_VECTOR_VERSION as typeof TOPIC_VECTOR_VERSION,
    last_seen_at: new Date(match.metadata.last_seen_at_ms ?? 0).toISOString(),
  };
}

export async function queryTopicVectorWithLog(
  config: SupabaseConfig,
  url: string,
  token: string,
  topicText: string,
  cutoff: number,
  category: string,
  batchId: string,
  articleId: string,
  embeddingVersion: string,
  fetcher = fetch,
) {
  const startedAt = Date.now();
  try {
    const candidate = await queryTopicVector(
      url,
      token,
      topicText,
      cutoff,
      fetcher,
      category,
    );
    await saveTopicObservabilityRows(config, [{
      operation: "vector_search",
      status: "success",
      batch_id: batchId,
      article_id: articleId,
      embedding_version: embeddingVersion,
      duration_ms: Date.now() - startedAt,
      item_count: candidate ? 1 : 0,
    }], fetcher);
    return candidate;
  } catch (error) {
    await saveTopicObservabilityRows(config, [{
      operation: "vector_search",
      status: "failure",
      batch_id: batchId,
      article_id: articleId,
      embedding_version: embeddingVersion,
      duration_ms: Date.now() - startedAt,
      error_type: safeTopicOperationErrorType(error),
      http_status: safeTopicOperationHttpStatus(error),
    }], fetcher);
    throw error;
  }
}

export async function syncTopicVectorOutbox(
  config: SupabaseConfig,
  url: string,
  token: string,
  fetcher = fetch,
) {
  const startedAt = Date.now();
  const headers = {
    Authorization: `Bearer ${config.serviceRoleKey}`,
    apikey: config.serviceRoleKey,
    "Content-Type": "application/json",
  };
  let rows: Array<TopicVectorRecord & { claim_token: string }> = [];
  try {
    const claimResponse = await fetcher(
      `${config.url}/rest/v1/rpc/claim_topic_vector_outbox`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ p_limit: TOPIC_VECTOR_BATCH_SIZE }),
      },
    );
    rows = await safeReadJson<
      Array<TopicVectorRecord & { claim_token: string }>
    >(claimResponse, "Topic vector outbox claim");
    if (!rows.length) return 0;
    await upsertTopicVectorBatch(url, token, rows, fetcher);
    const ack = await fetcher(
      `${config.url}/rest/v1/rpc/ack_topic_vector_outbox`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ p_claim_token: rows[0].claim_token }),
      },
    );
    await safeReadJson(ack, "Topic vector outbox ack", { requireBody: false });
    await saveTopicObservabilityRows(config, [{
      operation: "outbox_sync",
      status: "success",
      embedding_version: TOPIC_VECTOR_VERSION,
      item_count: rows.length,
      duration_ms: Date.now() - startedAt,
    }], fetcher);
    return rows.length;
  } catch (error) {
    if (rows.length) {
      await fetcher(`${config.url}/rest/v1/rpc/release_topic_vector_outbox`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_claim_token: rows[0].claim_token }),
      }).catch(() => undefined);
    }
    await saveTopicObservabilityRows(config, [{
      operation: "outbox_sync",
      status: "failure",
      embedding_version: TOPIC_VECTOR_VERSION,
      item_count: rows.length,
      duration_ms: Date.now() - startedAt,
      error_type: safeTopicOperationErrorType(error),
      http_status: safeTopicOperationHttpStatus(error),
    }], fetcher);
    throw error;
  }
}
