export type QueueItem = {
  article_id: string;
  queued_at: string;
  claimed_at: string | null;
  claim_id: string | null;
  worker_id: string | null;
  processing_started_at: string | null;
  external_api_started_at: string | null;
  processed_at: string | null;
  terminal_status: string | null;
  created_at: string;
  available_at?: string | null;
  stage2_attempt_count?: number;
};

export type TopicArticle = {
  article_id: string;
  title: string;
  description: string | null;
  cleaned_body?: string;
  url: string | null;
  normalized_url: string | null;
  source_name: string | null;
  published_at: string | null;
  newsdata_categories: string[];
  app_categories: string[];
  fetched_at: string | null;
};

export type ArticleLoadResult =
  | { articleId: string; article: TopicArticle }
  | {
    articleId: string;
    errorType:
      | "article_not_found"
      | "missing_title"
      | "missing_description"
      | "invalid_article";
  };

export function validateTopicArticle(
  value: unknown,
  expectedId: string,
): TopicArticle | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    item.article_id !== expectedId || typeof item.title !== "string" ||
    item.title.trim() === ""
  ) {
    return null;
  }
  const list = (key: string) =>
    Array.isArray(item[key])
      ? item[key].filter((v): v is string => typeof v === "string")
      : [];
  return {
    article_id: expectedId,
    title: item.title,
    description:
      item.description === null || typeof item.description === "string"
        ? item.description
        : null,
    url: typeof item.url === "string" ? item.url : null,
    normalized_url: typeof item.normalized_url === "string"
      ? item.normalized_url
      : null,
    source_name: typeof item.source_name === "string" ? item.source_name : null,
    published_at: typeof item.published_at === "string"
      ? item.published_at
      : null,
    newsdata_categories: list("newsdata_categories"),
    app_categories: list("app_categories"),
    fetched_at: typeof item.fetched_at === "string" ? item.fetched_at : null,
  };
}
