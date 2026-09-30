import type { ArticleLoadResult } from "./types.ts";
import { validateTopicArticle } from "./types.ts";
import { keys } from "../newsdata/config.ts";

export type RedisClient = {
  mget(keys: string[]): Promise<Array<string | null>>;
};

export function parseUpstashResponse(body: unknown): Array<string | null> {
  if (!body || typeof body !== "object") {
    throw new Error("Upstash response shape invalid");
  }
  const result = (body as Record<string, unknown>).result;
  if ((body as Record<string, unknown>).error || !Array.isArray(result)) {
    throw new Error("Upstash command failure");
  }
  return result as Array<string | null>;
}

export function parseUpstashBody(
  operation: string,
  bodyText: string,
  status: number,
  contentType: string,
): Array<string | null> {
  const bodyLength = bodyText.length;
  if (bodyLength === 0) {
    throw new Error(
      `Upstash ${operation} empty response status=${status} content_type=${
        contentType || "missing"
      } body_length=0`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Upstash ${operation} malformed response status=${status} content_type=${
        contentType || "missing"
      } body_length=${bodyLength}`,
    );
  }
  return parseUpstashResponse(body);
}

export function createUpstashClient(url: string, token: string): RedisClient {
  return {
    async mget(keys: string[]) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["MGET", ...keys]),
        signal: AbortSignal.timeout(10000),
      });
      return parseUpstashBody(
        "MGET",
        await response.text(),
        response.status,
        response.headers.get("content-type") ?? "",
      );
    },
  };
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// NewsData article records are stored under the deterministic canonical ID
// produced by the writer.  Keep source lookups on the same key contract.
export async function articleStorageKey(articleId: string) {
  return keys.article(await digest(`id:${articleId}`));
}

export async function identityAliasKey(articleId: string) {
  return keys.identity(await digest(`id:${articleId}`));
}

export async function loadClaimedArticles(
  redis: RedisClient,
  articleIds: string[],
): Promise<ArticleLoadResult[]> {
  if (articleIds.length === 0) return [];

  // Newly saved NewsData articles use digest("id:" + article_id) as their
  // canonical ID. Read that deterministic key first and only resolve an
  // identity alias for legacy/non-standard queue entries that are missing.
  const directKeys = await Promise.all(
    articleIds.map(articleStorageKey),
  );
  const directValues = await redis.mget(directKeys);
  const rawValues = [...directValues];
  const fallbackIndexes = articleIds.flatMap((articleId, index) =>
    directValues[index] === null ? [index] : []
  );

  if (fallbackIndexes.length > 0) {
    const fallbackIds = fallbackIndexes.map((index) => articleIds[index]);
    const aliasKeys = await Promise.all(fallbackIds.map(identityAliasKey));

    let canonicalIds: Array<string | null>;
    try {
      canonicalIds = await redis.mget(aliasKeys);
    } catch (e) {
      throw new Error(
        `loading_identity_aliases: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      );
    }

    const uniqueCanonicalIds = [
      ...new Set(
        canonicalIds.filter((id): id is string =>
          typeof id === "string" && id !== ""
        ),
      ),
    ];

    if (uniqueCanonicalIds.length > 0) {
      let canonicalValues: Array<string | null>;
      try {
        canonicalValues = await redis.mget(
          uniqueCanonicalIds.map(keys.article),
        );
      } catch (e) {
        throw new Error(
          `loading_canonical_articles: ${
            e instanceof Error ? e.message : "unknown"
          }`,
        );
      }
      const valuesByCanonical = new Map(
        uniqueCanonicalIds.map((
          id,
          index,
        ) => [id, canonicalValues[index] ?? null]),
      );
      canonicalIds.forEach((canonicalId, index) => {
        const queueIndex = fallbackIndexes[index];
        if (canonicalId) {
          rawValues[queueIndex] = valuesByCanonical.get(canonicalId) ?? null;
        }
      });
    }
  }

  return articleIds.map((articleId, index) => {
    const raw = rawValues[index];
    if (raw === null) return { articleId, errorType: "article_not_found" };
    try {
      if (!raw || raw.trim() === "") {
        return { articleId, errorType: "invalid_article" };
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.title !== "string" || parsed.title.trim() === "") {
        return { articleId, errorType: "missing_title" };
      }
      const article = validateTopicArticle(parsed, articleId);
      return article
        ? { articleId, article }
        : { articleId, errorType: "invalid_article" };
    } catch {
      return { articleId, errorType: "invalid_article" };
    }
  });
}
