import type { Config } from "./config.ts";
import { FetchError, type RawArticle } from "./api.ts";
export type Article = {
  article_id: string;
  title: string;
  description: string | null;
  url: string;
  normalized_url: string;
  source_name: string;
  published_at: string;
  image_url: string | null;
  newsdata_categories: string[];
  app_categories: string[];
  fetched_at: string;
};
export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) || url.username || url.password
  ) throw new FetchError("response_format");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}
export function normalize(raw: RawArticle, cfg: Config, now: string): Article {
  if (
    typeof raw.article_id !== "string" || !raw.article_id ||
    typeof raw.link !== "string" ||
    typeof raw.title !== "string" || !Array.isArray(raw.category) ||
    raw.category.some((c) => typeof c !== "string") ||
    typeof raw.pubDate !== "string"
  ) throw new FetchError("response_format");
  const date = new Date(
    raw.pubDate.match(/Z$|[+-]\d\d:\d\d$/)
      ? raw.pubDate
      : raw.pubDate.replace(" ", "T") + "Z",
  );
  if (!Number.isFinite(date.getTime())) throw new FetchError("response_format");
  let url: string;
  try {
    url = normalizeUrl(raw.link);
  } catch {
    throw new FetchError("response_format");
  }
  const categories = [...new Set(raw.category as string[])];
  return {
    article_id: raw.article_id,
    title: raw.title,
    url,
    normalized_url: url,
    description: typeof raw.description === "string" ? raw.description : null,
    source_name: typeof raw.source_name === "string"
      ? raw.source_name
      : String(raw.source_id ?? ""),
    published_at: date.toISOString(),
    image_url: typeof raw.image_url === "string" ? raw.image_url : null,
    newsdata_categories: categories,
    app_categories: [
      ...new Set(categories.map((c) => cfg.categoryMap[c]).filter(Boolean)),
    ],
    fetched_at: now,
  };
}
// IDまたはURLで結合。橋渡し重複も同一グループへまとめ、全カテゴリを維持。
export function deduplicate(items: Article[]): Article[][] {
  const groups: Article[][] = [];
  for (const item of items) {
    const matches = groups.filter((g) =>
      g.some((a) =>
        a.article_id === item.article_id ||
        a.normalized_url === item.normalized_url
      )
    );
    const group = [item, ...matches.flat()];
    for (const match of matches) groups.splice(groups.indexOf(match), 1);
    groups.push(group);
  }
  return groups;
}
export function mergeArticles(items: Article[]): Article {
  return {
    ...items[0],
    newsdata_categories: [
      ...new Set(items.flatMap((a) => a.newsdata_categories)),
    ],
    app_categories: [...new Set(items.flatMap((a) => a.app_categories))],
  };
}
