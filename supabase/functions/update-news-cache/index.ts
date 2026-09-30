import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type NewsItem, parseRss } from "./rss_parser.ts";
import { withNewsCacheJobAuth } from "./auth.ts";

const MAX_NEWS_PER_FEED = 30;
const RSS_TIMEOUT_MS = 15000;

// 巡回制限設定
const MAX_FEEDS_PER_RUN = 30; // 1回の実行で処理する最大RSS数
const CONCURRENCY = 10; // 同時実行数
const ACTIVE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

// Upstash Redis configuration
const UPSTASH_REDIS_REST_URL = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
const UPSTASH_REDIS_REST_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!;

async function fetchFeed(
  feedUrl: string,
): Promise<{
  sourceName: string | null;
  items: NewsItem[];
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, RSS_TIMEOUT_MS);

  try {
    const response = await fetch(feedUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; news-app-rss-cache/1.0)",
        "Accept":
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const xml = await response.text();
    const result = parseRss(xml, feedUrl);
    return { sourceName: result.sourceName, items: result.items };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[RSS][ERROR] url=${feedUrl} error=${message}`);
    return { sourceName: null, items: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveToUpstash(
  feedUrl: string,
  items: NewsItem[],
  sourceName: string | null,
  existingMeta: any,
): Promise<number> {
  if (!items.length) return 0;

  // 1. 正規化：published_at降順 -> URL重複除去 -> 先頭最大30件
  const sorted = [...items].sort((a, b) => {
    const dateA = a.published_at ? new Date(a.published_at).getTime() : 0;
    const dateB = b.published_at ? new Date(b.published_at).getTime() : 0;
    return dateB - dateA;
  });

  const unique: NewsItem[] = [];
  const seenUrls = new Set();
  for (const item of sorted) {
    if (!seenUrls.has(item.url)) {
      unique.push(item);
      seenUrls.add(item.url);
    }
  }

  const top30 = unique.slice(0, MAX_NEWS_PER_FEED).map((item) => ({
    title: item.title,
    url: item.url,
    time: item.time,
    published_at: item.published_at,
    feed_url: feedUrl,
    source_name: sourceName ?? existingMeta?.source_name ?? "ニュース",
  }));

  const key = `news:feed:${feedUrl}`;
  const now = new Date().toISOString();

  // メタデータのマージ (既存フィールドを確実に保護)
  const updatedMeta = {
    ...existingMeta,
    url: feedUrl,
    source_name: sourceName || existingMeta?.source_name || null,
    updated_at: now,
  };

  const pipelineUrl = UPSTASH_REDIS_REST_URL.endsWith("/")
    ? `${UPSTASH_REDIS_REST_URL}pipeline`
    : `${UPSTASH_REDIS_REST_URL}/pipeline`;

  const response = await fetch(pipelineUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["SET", key, JSON.stringify(top30), "EX", 604800],
      ["SET", `rss:meta:${feedUrl}`, JSON.stringify(updatedMeta)],
    ]),
  });

  if (!response.ok) {
    throw new Error(
      `Upstash Pipeline failed: ${response.status} - ${await response.text()}`,
    );
  }

  return top30.length;
}

async function updateFeed(
  feedUrl: string,
  existingMeta: any,
): Promise<{
  url: string;
  cached: number;
  error?: string;
}> {
  try {
    const result = await fetchFeed(feedUrl);
    if (result.error) return { url: feedUrl, cached: 0, error: result.error };
    const cachedCount = await saveToUpstash(
      feedUrl,
      result.items,
      result.sourceName,
      existingMeta,
    );
    return { url: feedUrl, cached: cachedCount };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[UpstashMirror] ERROR for feed ${feedUrl}: ${message}`);
    return { url: feedUrl, cached: 0, error: message };
  }
}

async function handleNewsCacheRequest(request: Request) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    console.log(
      "========== update-news-cache START (Safe Sequential Batching) ==========",
    );

    // 1. 直近7日以内に利用されたユーザーRSSだけを巡回対象にする
    const activeCutoff = Math.floor(Date.now() / 1000) - ACTIVE_WINDOW_SECONDS;
    const pipelineUrl = UPSTASH_REDIS_REST_URL.endsWith("/")
      ? `${UPSTASH_REDIS_REST_URL}pipeline`
      : `${UPSTASH_REDIS_REST_URL}/pipeline`;
    const urlsResponse = await fetch(pipelineUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["ZRANGEBYSCORE", "rss:active", activeCutoff, "+inf"],
      ]),
    });
    if (!urlsResponse.ok) throw new Error("Upstash target query failed");
    const targetResults = await urlsResponse.json();
    if (!Array.isArray(targetResults) || targetResults.length < 1) {
      throw new Error("Upstash target query returned an invalid response");
    }
    if (targetResults[0]?.error) {
      throw new Error(
        `Upstash target query error: ${
          targetResults[0]?.error
        }`,
      );
    }
    const activeUrls = (targetResults[0]?.result ?? []) as string[];
    const allUrls = [...new Set(activeUrls)].sort();

    if (allUrls.length === 0) {
      return new Response(JSON.stringify({ message: "No RSS URLs" }), {
        status: 200,
      });
    }

    // 2. 巡回カーソルを取得
    const cursorResponse = await fetch(UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["GET", "rss:update:cursor"]),
    });
    let currentCursor = 0;
    if (cursorResponse.ok) {
      const { result } = await cursorResponse.json();
      currentCursor = parseInt(result ?? "0", 10);
    }

    // カーソル位置のバリデーション（削除等で範囲外になった場合）
    if (!Number.isFinite(currentCursor) || currentCursor < 0 || currentCursor >= allUrls.length) {
      currentCursor = 0;
    }

    // 3. 今回の対象 RSS を切り出し
    const targetUrls = allUrls.slice(
      currentCursor,
      currentCursor + MAX_FEEDS_PER_RUN,
    );

    // 4. 対象 RSS の既存メタ情報を一括取得 (MGET)
    const metaKeys = targetUrls.map((url) => `rss:meta:${url}`);
    const metaResponse = await fetch(UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["MGET", ...metaKeys]),
    });

    let metas: any[] = [];
    if (metaResponse.ok) {
      const { result } = await metaResponse.json();
      metas = (result ?? []).map((
        r: string | null,
      ) => (r ? JSON.parse(r) : {}));
    } else {
      metas = targetUrls.map(() => ({}));
    }

    console.log(
      `[RSS] Process scope: ${currentCursor} to ${
        currentCursor + targetUrls.length
      } ` +
        `(Active: ${activeUrls.length}, Total: ${allUrls.length})`,
    );

    // 5. 並行度を制限しながらバッチ実行 (CONCURRENCY)
    const results = [];
    for (let i = 0; i < targetUrls.length; i += CONCURRENCY) {
      const batchUrls = targetUrls.slice(i, i + CONCURRENCY);
      const batchMetas = metas.slice(i, i + CONCURRENCY);

      console.log(`[RSS] Executing batch: ${i} to ${i + batchUrls.length}`);

      const batchResults = await Promise.all(
        batchUrls.map((url, idx) => updateFeed(url, batchMetas[idx])),
      );
      results.push(...batchResults);
    }

    // 6. カーソルを更新
    const nextCursor = (currentCursor + targetUrls.length) % allUrls.length;
    await fetch(UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", "rss:update:cursor", nextCursor.toString()]),
    });

    const successCount = results.filter((r) => !r.error).length;
    const failedCount = results.filter((r) => !!r.error).length;
    const totalCached = results.reduce((sum, r) => sum + r.cached, 0);

    const responseBody = {
      success: true,
      totalFeeds: allUrls.length,
      activeFeeds: activeUrls.length,
      activeWindowSeconds: ACTIVE_WINDOW_SECONDS,
      processedFeeds: targetUrls.length,
      succeeded: successCount,
      failed: failedCount,
      cached: totalCached,
      cursorStart: currentCursor,
      cursorNext: nextCursor,
      results,
    };

    console.log(`========== update-news-cache END ==========`);
    return new Response(JSON.stringify(responseBody), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("update-news-cache failed:", message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
}

Deno.serve(withNewsCacheJobAuth(
  () => Deno.env.get("NEWS_CACHE_JOB_SECRET"),
  handleNewsCacheRequest,
));
