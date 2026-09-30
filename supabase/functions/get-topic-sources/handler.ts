import { withSupabase } from "jsr:@supabase/server@1.7.0";
import { createUpstashClient } from "../_shared/topic/article_store.ts";
import { loadTopicSourceArticles } from "../_shared/topic/source_store.ts";
import {
  type SupabaseConfig,
  supabaseConfigFromEnv,
} from "../_shared/topic/queue.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const dbHeaders = (config: SupabaseConfig) => ({
  Authorization: `Bearer ${config.serviceRoleKey}`,
  apikey: config.serviceRoleKey,
});

type PublicTopic = { id: string; facts: unknown };
type TopicArticleRow = { article_id: string };
type Dependencies = {
  env?: { url: string; publishableKeys: Record<string, string> };
  fetcher?: typeof fetch;
};

function isPublicTopic(row: PublicTopic | undefined) {
  return Array.isArray(row?.facts) && row.facts.length >= 1;
}

async function loadPublicTopic(
  config: SupabaseConfig,
  topicId: string,
  fetcher: typeof fetch,
): Promise<PublicTopic | undefined> {
  const response = await fetcher(
    `${config.url}/rest/v1/topics?id=eq.${encodeURIComponent(topicId)}` +
      "&thread_title_pending=eq.false&representative_published_at=not.is.null&select=id,facts",
    { headers: dbHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(`public_topic_load_failed:${response.status}`);
  }
  const rows = await response.json() as PublicTopic[];
  return rows[0];
}

async function loadTopicArticleIds(
  config: SupabaseConfig,
  topicId: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher(
    `${config.url}/rest/v1/topic_articles?topic_id=eq.${
      encodeURIComponent(topicId)
    }&select=article_id&order=created_at.asc`,
    { headers: dbHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(`topic_articles_load_failed:${response.status}`);
  }
  const rows = await response.json() as TopicArticleRow[];
  return [
    ...new Set(
      rows.map((row) => row.article_id).filter((id) =>
        typeof id === "string" && id !== ""
      ),
    ),
  ];
}

const topicIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createGetTopicSourcesHandler(
  dependencies: Dependencies = {},
) {
  const config = {
    auth: "publishable" as const,
    cors: "disabled" as const,
    ...(dependencies.env ? { env: dependencies.env } : {}),
  };
  const fetcher = dependencies.fetcher ?? fetch;

  const authenticatedHandler = withSupabase(
    config,
    async (request: Request) => {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }

      let topicId: unknown;
      try {
        ({ topic_id: topicId } = await request.json());
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (typeof topicId !== "string" || !topicIdPattern.test(topicId)) {
        return json({ error: "invalid_request" }, 400);
      }

      try {
        const supabase = supabaseConfigFromEnv();
        if (!isPublicTopic(await loadPublicTopic(supabase, topicId, fetcher))) {
          return json({ articles: [] });
        }
        const articleIds = await loadTopicArticleIds(
          supabase,
          topicId,
          fetcher,
        );
        const redisUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
        const redisToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
        if (!redisUrl || !redisToken) {
          throw new Error("upstash_configuration_missing");
        }
        return json({
          articles: await loadTopicSourceArticles(
            createUpstashClient(redisUrl, redisToken),
            articleIds,
          ),
        });
      } catch (error) {
        console.error("[TopicSources] request failed", {
          type: error instanceof Error ? error.name : "unknown",
        });
        return json({ error: "source_lookup_failed" }, 500);
      }
    },
  );

  return (request: Request) =>
    request.method === "OPTIONS"
      ? Promise.resolve(new Response("ok", { headers: corsHeaders }))
      : authenticatedHandler(request);
}
