import { deepStrictEqual } from "node:assert";
import { toTopicListItems } from "./topic_cache.ts";

Deno.test("topic cache uses immutable representative fields and category", () => {
  const result = toTopicListItems([
    {
      id: "topic-1",
      thread_title: null,
      category: "トレンド",
      representative_title: "代表タイトル",
      representative_description: null,
      representative_url: "https://example.com/article",
      representative_source: null,
      representative_published_at: "2026-09-12T00:00:00Z",
      facts: ["fact"],
    },
    {
      id: "missing-date",
      thread_title: null,
      category: "マネー",
      representative_title: "除外される",
      representative_description: "x",
      representative_url: "https://example.com/missing",
      representative_source: "Example",
      representative_published_at: null,
      facts: [],
    },
  ]);
  deepStrictEqual(result, [
    {
      topic_id: "topic-1",
      category: "トレンド",
      title: "代表タイトル",
      description: "",
      url: "https://example.com/article",
      source_name: "",
      published_at: "2026-09-12T00:00:00Z",
      created_at: undefined,
      first_seen_at: undefined,
      thread_title: null,
      representative_title: "代表タイトル",
      subject: undefined,
      event: undefined,
      facts: ["fact"],
      creation_mode: undefined,
    },
  ]);
});

Deno.test("topic cache prefers thread title and falls back for legacy Topic", () => {
  const titles = toTopicListItems([
    {
      id: "new",
      category: "category",
      thread_title: "board title",
      representative_title: "representative",
      representative_description: null,
      representative_url: "https://example.com/new",
      representative_source: null,
      representative_published_at: "2026-09-12T00:00:00Z",
      facts: ["fact"],
    },
    {
      id: "legacy",
      category: "category",
      thread_title: null,
      representative_title: "representative",
      representative_description: null,
      representative_url: "https://example.com/legacy",
      representative_source: null,
      representative_published_at: "2026-09-11T00:00:00Z",
      facts: ["fact"],
    },
  ]).map((item) => item.title);
  deepStrictEqual(titles, ["board title", "representative"]);
});
