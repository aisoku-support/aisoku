import { articleStorageKey, type RedisClient } from "./article_store.ts";

export type TopicSourceArticle = {
  article_id: string;
  title: string;
  url: string;
  source_name: string;
  published_at: string;
};

function parseSourceArticle(
  articleId: string,
  raw: string | null,
): TopicSourceArticle | null {
  if (!raw || raw.trim() === "") return null;
  try {
    const article = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof article.title !== "string" || article.title.trim() === "" ||
      typeof article.url !== "string" || article.url.trim() === "" ||
      typeof article.published_at !== "string" ||
      article.published_at.trim() === ""
    ) return null;
    return {
      article_id: articleId,
      title: article.title,
      url: article.url,
      source_name: typeof article.source_name === "string"
        ? article.source_name
        : "",
      published_at: article.published_at,
    };
  } catch {
    return null;
  }
}

export async function loadTopicSourceArticles(
  redis: RedisClient,
  articleIds: string[],
): Promise<TopicSourceArticle[]> {
  if (articleIds.length === 0) return [];
  const keys = await Promise.all(articleIds.map(articleStorageKey));
  // Source lookups intentionally issue one MGET for every linked article.
  const values = await redis.mget(keys);
  return articleIds.flatMap((articleId, index) => {
    const article = parseSourceArticle(articleId, values[index] ?? null);
    return article ? [article] : [];
  });
}
