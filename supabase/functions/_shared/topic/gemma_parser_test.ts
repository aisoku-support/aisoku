import {
  deepStrictEqual,
  ok as assert,
  strictEqual as assertEquals,
} from "node:assert";
import {
  normalizeThreadTitle,
  parseGemmaResponse,
  parseGemmaFactsResponse,
  detectGemmaRepetition,
  TOPIC_CATEGORIES,
} from "./gemma_parser.ts";

const ids = Array.from(
  { length: 5 },
  (_, i) => `long-newsdata-id-${i}-abcdefghijklmnopqrstuvwxyz`,
);
const row = (index: number, category: string = TOPIC_CATEGORIES[0]) => ({
  index,
  subject: "subject",
  event: "event",
  category,
  facts: ["具体的な情報"],
  thread_title: "board title",
});

Deno.test("five indexes map one-to-one to long input article ids", () => {
  const parsed = parseGemmaResponse(
    JSON.stringify([0, 1, 2, 3, 4].map((i) => row(i))),
    ids,
  );
  assertEquals(parsed.results.length, 5);
  assertEquals(parsed.failures.length, 0);
  deepStrictEqual(parsed.results.map((r) => r.article_id), ids);
});
Deno.test("excluded can be mixed with five valid indexed results", () => {
  const parsed = parseGemmaResponse(
    JSON.stringify(
      [0, 1, 2, 3, 4].map((i) =>
        row(i, i === 2 ? TOPIC_CATEGORIES[5] : TOPIC_CATEGORIES[0])
      ),
    ),
    ids,
  );
  assertEquals(parsed.results.length, 5);
  assertEquals(parsed.results[2].category, TOPIC_CATEGORIES[5]);
  deepStrictEqual(parsed.results[2].facts, []);
  assertEquals(parsed.results[2].subject, "");
});
Deno.test("facts preserve strings without a count or length cap", () => {
  const facts = ["  事実A  ", "a".repeat(200)];
  const parsed = parseGemmaResponse(JSON.stringify([{ ...row(0), facts }]), [ids[0]]);
  deepStrictEqual(parsed.results[0].facts, facts);
});
Deno.test("Gemma repetition collapse is rejected while normal prose passes", () => {
  for (const value of [
    "_thought".repeat(10), "-訳".repeat(10), "績".repeat(30),
    "<tr></tr>".repeat(10), '"'.repeat(40), "1".repeat(40),
    "_parsing".repeat(10), "age".repeat(15),
  ]) {
    assert(detectGemmaRepetition(value));
  }
  for (const value of ["_ly_".repeat(20), "<em></em>".repeat(12), "/11".repeat(20), "学歴社会の変容-".repeat(8), '"subject": '.repeat(12), "_0_".repeat(20)]) {
    assert(detectGemmaRepetition(value));
  }
  assertEquals(detectGemmaRepetition("これは200文字程度の正常な文章です。固有名詞の東京が数回登場し、記事の背景と出来事を自然に説明しています。東京で発表された内容について関係者が説明し、今後の対応を検討するとしています。"), null);
});

Deno.test("response-level repetition is classified before JSON parsing", () => {
  const parsed = parseGemmaResponse(`{ "articles": [${'"_parsing"'.repeat(80)}] }`, [ids[0]]);
  assertEquals(parsed.results.length, 0);
  assertEquals(parsed.failures[0].errorType, "repetition_loop");
});

Deno.test("malformed Stage 2 response with a long repeated phrase is repetition_loop", () => {
  const parsed = parseGemmaFactsResponse(
    `{"articles":[{"index":0,"facts":[thought_process_is_not_a_context_`.concat(
      "thought_process_is_not_a_context_".repeat(20),
    ),
    [ids[0]],
  );
  assertEquals(parsed.failures[0].errorType, "repetition_loop");
});

Deno.test("empty Stage 2 plain text produces empty facts", () => {
  const parsed = parseGemmaFactsResponse(" \n\n ", [ids[0]]);
  assertEquals(parsed.failures.length, 0);
  deepStrictEqual(parsed.results, [{ article_id: ids[0], facts: [] }]);
});

Deno.test("Stage 2 plain text splits and trims one fact per line", () => {
  const parsed = parseGemmaFactsResponse(
    "  fact A  \n\n  fact B ",
    [ids[0]],
  );
  assertEquals(parsed.failures.length, 0);
  deepStrictEqual(parsed.results, [{ article_id: ids[0], facts: ["fact A", "fact B"] }]);
});

Deno.test("normal JSON with limited repetition is accepted", () => {
  const parsed = parseGemmaResponse(JSON.stringify([{
    ...row(0), subject: "通常のニュース", event: "同じ単語 同じ単語 同じ単語",
    facts: ["facts内に似た表現があります", "facts内に似た表現があります"],
  }]), [ids[0]]);
  assertEquals(parsed.failures.length, 0);
  assertEquals(parsed.results.length, 1);
});
Deno.test("repetition failure is returned after normal validation", () => {
  const parsed = parseGemmaResponse(JSON.stringify([{ ...row(0), facts: ["にぎやかに-".repeat(6)] }]), [ids[0]]);
  assertEquals(parsed.results.length, 0);
  assert(parsed.failures.some((f) => f.errorType === "repetition_loop" && f.reason));
});
Deno.test("missing index is reported for the corresponding article", () => {
  const parsed = parseGemmaResponse(
    JSON.stringify([row(0), row(1), row(3), row(4)]),
    ids,
  );
  assert(
    parsed.failures.some((f) =>
      f.articleId === ids[2] && f.errorType === "missing_article_result"
    ),
  );
});
Deno.test("duplicate index is reported and its result is rejected", () => {
  const parsed = parseGemmaResponse(
    JSON.stringify([row(0), row(0), row(1), row(2), row(3), row(4)]),
    ids,
  );
  assert(
    parsed.failures.some((f) =>
      f.articleId === ids[0] && f.errorType === "duplicate_article_result"
    ),
  );
  assertEquals(parsed.results.length, 4);
});
Deno.test("out-of-range index is rejected", () => {
  const parsed = parseGemmaResponse(
    JSON.stringify([row(0), row(1), row(2), row(3), row(4), row(5)]),
    ids,
  );
  assert(parsed.failures.some((f) => f.errorType === "index_out_of_range"));
});
Deno.test("invalid Topic fields fail classification", () => {
  const parsed = parseGemmaResponse(
    JSON.stringify([
      { ...row(0), subject: "a".repeat(41), thread_title: "表示タイトル" },
      { ...row(1), event: "a".repeat(51), thread_title: "別の表示タイトル" },
      {
        ...row(2),
        category: "invalid",
        thread_title: "カテゴリ失敗のタイトル",
      },
    ]),
    ids.slice(0, 3),
  );
  assertEquals(parsed.results.length, 0);
  assert(parsed.failures.some((f) => f.errorType === "subject_too_long"));
  assert(parsed.failures.some((f) => f.errorType === "event_too_long"));
  assert(parsed.failures.some((f) => f.errorType === "invalid_category"));
});

Deno.test("Stage 1 repetition is classified before subject and event length failures", () => {
  const cases = [
    { subject: "abcde".repeat(8), event: "event", expected: "repetition_loop" },
    { subject: "subject", event: "abcde".repeat(10), expected: "repetition_loop" },
    { subject: "abcde".repeat(9), event: "event", expected: "repetition_loop" },
    { subject: "subject", event: "abcde".repeat(11), expected: "repetition_loop" },
    { subject: "abcdefghijklmnopqrstuvwxyz0123456789ABCDE", event: "event", expected: "subject_too_long" },
    { subject: "subject", event: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNO", expected: "event_too_long" },
  ];

  for (const testCase of cases) {
    const parsed = parseGemmaResponse(
      JSON.stringify([{ ...row(0), ...testCase }]),
      [ids[0]],
    );
    assertEquals(parsed.results.length, 0);
    assertEquals(parsed.failures[0].errorType, testCase.expected);
  }
});
Deno.test("thread title removes only an absent trailing identifier", () => {
  assertEquals(normalizeThreadTitle("Topic abc-123", "source", null), "Topic");
  assertEquals(
    normalizeThreadTitle("www.example.com", "source", null),
    "www.example.com",
  );
  assertEquals(
    normalizeThreadTitle("Topic abc-123", "source abc-123", null),
    "Topic abc-123",
  );
  assertEquals(normalizeThreadTitle("a".repeat(51), "source", null), null);
});

Deno.test("trailing identifier removal happens before the title length check", () => {
  assertEquals(
    normalizeThreadTitle("a".repeat(47) + " abc-123", "source", null),
    "a".repeat(47),
  );
});
