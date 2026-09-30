import type { SupabaseConfig } from "./queue.ts";
import { TOPIC_CATEGORIES } from "./gemma_parser.ts";

export const topicListCacheKey = "news:topics";
const perCategoryLimit = 10;

export async function recordTopicCompletionForCache(
  config: SupabaseConfig,
): Promise<boolean> {
  const response = await fetch(
    `${config.url}/rest/v1/rpc/record_topic_completion_for_cache`,
    {
      method: "POST",
      headers: {
        ...headers(config),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(`topic_cache_counter_failed:${response.status}`);
  }
  return await response.json() as boolean;
}

export type TopicRow = {
  id: string;
  category: string;
  representative_title: string;
  thread_title: string | null;
  representative_description: string | null;
  representative_url: string;
  representative_source: string | null;
  representative_published_at: string | null;
  created_at?: string;
  first_seen_at?: string;
  facts?: string[];
  subject?: string;
  event?: string;
  creation_mode?: string;
};

export type TopicListItem = {
  topic_id: string;
  category: string;
  title: string;
  description: string;
  url: string;
  source_name: string;
  published_at: string;
  created_at?: string;
  first_seen_at?: string;
  thread_title?: string | null;
  representative_title?: string;
  subject?: string;
  event?: string;
  facts?: string[];
  creation_mode?: string;
};

const headers = (config: SupabaseConfig) => ({
  Authorization: `Bearer ${config.serviceRoleKey}`,
  apikey: config.serviceRoleKey,
});

async function loadTopics(config: SupabaseConfig): Promise<TopicRow[]> {
  const rows = await Promise.all(TOPIC_CATEGORIES.slice(0, 5).map(async (category) => {
    const response = await fetch(
      `${config.url}/rest/v1/topics?category=eq.${encodeURIComponent(category)}&thread_title_pending=eq.false&facts=not.is.null&select=id,category,thread_title,representative_title,representative_description,representative_url,representative_source,representative_published_at,created_at,first_seen_at,subject,event,facts,creation_mode&order=created_at.desc`,
      {
        headers: {
          ...headers(config),
          Range: `0-${perCategoryLimit - 1}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`topic_cache_load_failed:${response.status}`);
    }
    return await response.json() as TopicRow[];
  }));
  return rows.flat().sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? "")
  );
}

export function toTopicListItems(topics: TopicRow[]): TopicListItem[] {
  return topics
    .filter((topic) => topic.representative_published_at !== null && (topic.facts?.length ?? 0) >= 1)
    .map((topic) => ({
      topic_id: topic.id,
      category: topic.category,
      title: topic.thread_title ?? topic.representative_title,
      description: topic.representative_description ?? "",
      url: topic.representative_url,
      source_name: topic.representative_source ?? "",
      published_at: topic.representative_published_at!,
      created_at: topic.created_at,
      first_seen_at: topic.first_seen_at,
      thread_title: topic.thread_title,
      representative_title: topic.representative_title,
      subject: topic.subject,
      event: topic.event,
      facts: topic.facts,
      creation_mode: topic.creation_mode,
    }));
}

export async function publishTopicListCache(
  config: SupabaseConfig,
  redisUrl: string,
  redisToken: string,
): Promise<number> {
  const topics = toTopicListItems(await loadTopics(config));
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      "SET",
      topicListCacheKey,
      JSON.stringify({ generated_at: new Date().toISOString(), topics }),
    ]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`topic_cache_write_failed:${response.status}`);
  }
  const body = await response.json() as { error?: unknown };
  if (body.error) throw new Error("topic_cache_write_failed");
  return topics.length;
}
