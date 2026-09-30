import {
  identityAliasKey,
  loadClaimedArticles,
  parseUpstashBody,
  parseUpstashResponse,
} from "./article_store.ts";
import { deferQueueArticle } from "./queue.ts";
import { validateTopicArticle } from "./types.ts";
import { isAuthorized, topicConfig } from "./config.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertEquals failed: ${JSON.stringify(actual)} !== ${
        JSON.stringify(expected)
      }`,
    );
  }
}

function assertNull(value: unknown) {
  if (value !== null) {
    throw new Error(`assertNull failed: ${JSON.stringify(value)}`);
  }
}

Deno.test("validates the NewsData article shape without retaining extra fields", () => {
  const article = validateTopicArticle({
    article_id: "a1",
    title: "title",
    description: null,
    newsdata_categories: ["technology"],
    app_categories: ["IT・ガジェット"],
    secret: "must not escape",
  }, "a1");
  assertEquals(article?.article_id, "a1");
  assertEquals(article?.description, null);
  assertEquals(Object.prototype.hasOwnProperty.call(article, "secret"), false);
  assertNull(validateTopicArticle({ article_id: "a1", title: "" }, "a1"));
});

Deno.test("direct article MGET loads current articles without identity MGET", async () => {
  const calls: string[][] = [];
  const result = await loadClaimedArticles({
    mget: async (keys) => {
      calls.push(keys);
      return [
        JSON.stringify({
          article_id: "a1",
          title: "ok",
          description: "description",
        }),
        JSON.stringify({
          article_id: "a2",
          title: "ok",
          description: "description",
        }),
      ];
    },
  }, ["a1", "a2"]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].length, 2);
  assertEquals(result[0].articleId, "a1");
  assertEquals(result[1].articleId, "a2");
});

Deno.test("description-less article remains eligible for Readability rescue", async () => {
  const result = await loadClaimedArticles({
    mget: async () => [JSON.stringify({
      article_id: "a1",
      title: "valid title",
      description: null,
      url: "https://example.com/article",
    })],
  }, ["a1"]);
  assertEquals("article" in result[0], true);
  if ("article" in result[0]) assertEquals(result[0].article.description, null);
});

Deno.test("direct miss falls back to identity and canonical MGET", async () => {
  const calls: string[][] = [];
  const result = await loadClaimedArticles({
    mget: async (keys) => {
      calls.push(keys);
      if (calls.length === 1) return [null, null];
      if (calls.length === 2) return ["canonical-a1", null];
      return [
        JSON.stringify({
          article_id: "a1",
          title: "ok",
          description: "description",
        }),
      ];
    },
  }, ["a1", "a2"]);
  assertEquals(calls.length, 3);
  assertEquals(calls[1], [
    await identityAliasKey("a1"),
    await identityAliasKey("a2"),
  ]);
  assertEquals(result[0].articleId, "a1");
  assertEquals(result[1], { articleId: "a2", errorType: "article_not_found" });
});

Deno.test("Upstash malformed JSON is reported without exposing the response", () => {
  for (const body of ["", "not-json"]) {
    let message = "";
    try {
      parseUpstashBody("MGET", body, 200, "application/json");
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown";
    }
    if (
      !message.includes("status=200") || !message.includes("body_length=") ||
      !message.includes("MGET")
    ) {
      throw new Error(`diagnostic omitted safe response metadata: ${message}`);
    }
    if (message.includes(body) && body !== "") {
      throw new Error("response body leaked into diagnostic");
    }
  }
  if (
    parseUpstashBody(
      "MGET",
      JSON.stringify({ result: ["canonical-a1", null] }),
      200,
      "application/json",
    ).length !== 2
  ) {
    throw new Error("valid Upstash response was rejected");
  }
  if (parseUpstashResponse({ result: ["canonical-a1", null] }).length !== 2) {
    throw new Error("valid Upstash response was rejected");
  }
});

Deno.test("topic worker auth requires the dedicated header and secret", () => {
  const request = new Request("https://example.invalid", {
    headers: { [topicConfig.authHeader]: "correct" },
  });
  if (isAuthorized(request, undefined)) {
    throw new Error("missing secret was accepted");
  }
  if (isAuthorized(request, "wrong")) {
    throw new Error("wrong secret was accepted");
  }
  if (!isAuthorized(request, "correct")) {
    throw new Error("correct secret was rejected");
  }
});

Deno.test("deferred Stage 2 request releases its claim with compare-and-set count", async () => {
  let requestedUrl = "";
  let requestBody: Record<string, unknown> = {};
  const availableAt = "2026-09-29T10:00:00.000Z";
  const result = await deferQueueArticle(
    { url: "https://supabase.example", serviceRoleKey: "test-key" },
    "claim-1",
    "article/1",
    availableAt,
    1,
    2,
    async (input, init) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json([{
        article_id: "article/1",
        stage2_attempt_count: 2,
        available_at: availableAt,
      }]);
    },
  );
  const parsed = new URL(requestedUrl);
  assertEquals(parsed.searchParams.get("claim_id"), "eq.claim-1");
  assertEquals(parsed.searchParams.get("stage2_attempt_count"), "eq.1");
  assertEquals(parsed.searchParams.get("processed_at"), "is.null");
  assertEquals(parsed.searchParams.get("terminal_status"), "is.null");
  assertEquals(requestBody.available_at, availableAt);
  assertEquals(requestBody.stage2_attempt_count, 2);
  assertEquals(requestBody.claim_id, null);
  assertEquals(requestBody.external_api_started_at, null);
  assertEquals(result.available_at, availableAt);
});

Deno.test("deferred Stage 2 request rejects a lost claim instead of releasing another worker", async () => {
  let calls = 0;
  let rejected = false;
  try {
    await deferQueueArticle(
      { url: "https://supabase.example", serviceRoleKey: "test-key" },
      "stale-claim",
      "article-1",
      "2026-09-29T10:00:00.000Z",
      1,
      2,
      async () => {
        calls++;
        return Response.json([]);
      },
    );
  } catch (error) {
    rejected = error instanceof Error &&
      error.message === "Topic queue defer lost its claim";
  }
  assertEquals(calls, 1);
  assertEquals(rejected, true);
});
