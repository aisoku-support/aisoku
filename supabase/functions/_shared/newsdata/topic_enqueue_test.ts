import { deepStrictEqual, strictEqual } from "node:assert";
import {
  enqueueNewArticlesSafely,
  enqueueTopicArticles,
} from "./topic_enqueue.ts";

Deno.test("new article IDs are sent in one batch request", async () => {
  const oldUrl = Deno.env.get("SUPABASE_URL");
  const oldKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://example.invalid");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  let calls = 0;
  try {
    const inserted = await enqueueTopicArticles(
      ["new-1", "new-2"],
      async (_url, init) => {
        calls++;
        deepStrictEqual(JSON.parse(String(init?.body)), {
          p_article_ids: ["new-1", "new-2"],
        });
        return Response.json(2);
      },
    );
    strictEqual(inserted, 2);
    strictEqual(calls, 1);
  } finally {
    oldUrl == null
      ? Deno.env.delete("SUPABASE_URL")
      : Deno.env.set("SUPABASE_URL", oldUrl);
    oldKey == null
      ? Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY")
      : Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", oldKey);
  }
});

Deno.test("already-known empty IDs do not enqueue", async () => {
  let calls = 0;
  deepStrictEqual(
    await enqueueNewArticlesSafely([], async () => {
      calls++;
      return 0;
    }),
    { topic_enqueued: 0, topic_enqueue_failed: 0 },
  );
  strictEqual(calls, 0);
});

Deno.test("enqueue failure preserves NewsData success and reports count", async () => {
  const result = await enqueueNewArticlesSafely(
    ["new-1", "new-2"],
    async () => {
      throw new Error("fixture failure");
    },
  );
  deepStrictEqual(result, { topic_enqueued: 0, topic_enqueue_failed: 2 });
});

Deno.test("normal tech and subculture use the same enqueue helper", async () => {
  for (const _mode of ["normal", "tech", "subculture"]) {
    const result = await enqueueNewArticlesSafely(
      [`new-${_mode}`],
      async (ids) => ids.length,
    );
    deepStrictEqual(result, { topic_enqueued: 1, topic_enqueue_failed: 0 });
  }
});
