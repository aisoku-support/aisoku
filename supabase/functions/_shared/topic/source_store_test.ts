import { articleStorageKey } from "./article_store.ts";
import { loadTopicSourceArticles } from "./source_store.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("source lookup uses one MGET and omits expired or invalid records", async () => {
  const calls: string[][] = [];
  const articles = await loadTopicSourceArticles({
    mget: async (keys) => {
      calls.push(keys);
      return [
        JSON.stringify({
          title: "First source",
          url: "https://example.com/first",
          source_name: "Example",
          published_at: "2026-09-18T00:00:00.000Z",
          description: "not returned",
        }),
        null,
        JSON.stringify({ title: "Missing URL" }),
      ];
    },
  }, ["a1", "a2", "a3"]);

  assertEquals(calls, [[
    await articleStorageKey("a1"),
    await articleStorageKey("a2"),
    await articleStorageKey("a3"),
  ]]);
  assertEquals(articles, [{
    article_id: "a1",
    title: "First source",
    url: "https://example.com/first",
    source_name: "Example",
    published_at: "2026-09-18T00:00:00.000Z",
  }]);
});

Deno.test("source lookup accepts all records missing without an error", async () => {
  const articles = await loadTopicSourceArticles({
    mget: async () => [null, null],
  }, ["a1", "a2"]);
  assertEquals(articles, []);
});
