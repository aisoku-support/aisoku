import { topicConfig } from "../_shared/topic/config.ts";
import { runGemmaThreadTitleTest } from "../_shared/topic/gemma_thread_title_test.ts";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("TOPIC_PROCESSING_SECRET");
  if (!secret || request.headers.get(topicConfig.authHeader) !== secret) {
    return response({ error: "unauthorized" }, 401);
  }
  try {
    const body = await request.json();
    const articleIds = body?.article_ids;
    if (!Array.isArray(articleIds) || articleIds.length === 0 || articleIds.length > 10 || articleIds.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) {
      return response({ error: "article_ids must contain 1-10 valid article_id values" }, 400);
    }
    const results = await runGemmaThreadTitleTest(articleIds, 10_000);
    return response({ results });
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "test_failed" }, 500);
  }
});
