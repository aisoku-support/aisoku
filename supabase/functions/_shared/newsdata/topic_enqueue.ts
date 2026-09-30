export type TopicEnqueueResult = {
  topic_enqueued: number;
  topic_enqueue_failed: number;
};

export async function enqueueTopicArticles(
  articleIds: string[],
  fetcher = fetch,
): Promise<number> {
  if (articleIds.length === 0) return 0;
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Topic enqueue configuration missing");
  const response = await fetcher(`${url}/rest/v1/rpc/enqueue_topic_articles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_article_ids: articleIds }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Topic enqueue HTTP ${response.status}`);
  const count = await response.json();
  if (!Number.isInteger(count) || count < 0 || count > articleIds.length) {
    throw new Error("Invalid Topic enqueue response");
  }
  return count;
}

export async function enqueueNewArticlesSafely(
  articleIds: string[],
  enqueue = enqueueTopicArticles,
): Promise<TopicEnqueueResult> {
  if (articleIds.length === 0) {
    return { topic_enqueued: 0, topic_enqueue_failed: 0 };
  }
  try {
    return {
      topic_enqueued: await enqueue(articleIds),
      topic_enqueue_failed: 0,
    };
  } catch {
    return { topic_enqueued: 0, topic_enqueue_failed: articleIds.length };
  }
}
