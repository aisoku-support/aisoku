import { strictEqual } from "node:assert";
import { detectCommentDominatedBody } from "./comment_structure_filter.ts";

const ARTICLE_DIR = new URL(
  "../../../../tools/model_benchmark/dataset/articles/",
  import.meta.url,
);

async function loadBenchmarkArticle(id: string) {
  const article = JSON.parse(
    await Deno.readTextFile(new URL(`${id}.json`, ARTICLE_DIR)),
  );
  return article as {
    title: string;
    body?: string;
    cleaned_body?: string;
    extracted_body?: string;
  };
}

async function benchmarkBody(id: string): Promise<string> {
  const article = await loadBenchmarkArticle(id);
  return article.body ?? article.cleaned_body ?? article.extracted_body ?? "";
}

Deno.test("article-053 is excluded by repeated post headers", async () => {
  const result = detectCommentDominatedBody(await benchmarkBody("article-053"));
  strictEqual(result.excluded, true);
  strictEqual(result.postCandidates, 82);
  strictEqual(result.repeatedHeaders, 82);
});

Deno.test("stored normal benchmark articles are adopted", async () => {
  for (let number = 24; number <= 43; number++) {
    const result = detectCommentDominatedBody(
      await benchmarkBody(`article-${String(number).padStart(3, "0")}`),
    );
    strictEqual(result.excluded, false, `article-${number}`);
  }
  for (const id of ["article-044", "article-049"]) {
    strictEqual(
      detectCommentDominatedBody(await benchmarkBody(id)).excluded,
      false,
      id,
    );
  }
});

Deno.test("article-053 remains excluded after whitespace removal", async () => {
  const body = (await benchmarkBody("article-053")).replace(/\s+/gu, "");
  const result = detectCommentDominatedBody(body);
  strictEqual(result.excluded, true);
  strictEqual(result.postCandidates, 82);
  strictEqual(result.repeatedHeaders, 82);
});

Deno.test("frequent iPhone mentions are not post headers", () => {
  const body = Array.from(
    { length: 80 },
    (_, index) =>
      `iPhoneの新機能を紹介します。iPhone ${index}の写真性能も解説します。`,
  ).join("");
  strictEqual(detectCommentDominatedBody(body).excluded, false);
});

Deno.test("a few quoted comments do not exclude a normal article", async () => {
  for (const id of ["article-026", "article-044", "article-049"]) {
    strictEqual(
      detectCommentDominatedBody(await benchmarkBody(id)).excluded,
      false,
      id,
    );
  }
  const fewComments = [
    "本文です。1：投稿者 ： 2026/09/25 12:30 ID：abcdefgh コメント本文",
    "2：別の人 ： 2026/09/25 12:31 ID：ijklmnop 引用された反応",
    "記事の説明に戻ります。",
  ].join(" ");
  strictEqual(detectCommentDominatedBody(fewComments).excluded, false);
});

Deno.test("empty, malformed and timestamp-like input fail open", () => {
  for (const input of ["", " ", null, undefined, 12, {}, false]) {
    strictEqual(detectCommentDominatedBody(input).excluded, false);
  }
  strictEqual(
    detectCommentDominatedBody("10:30に発表、11:45に更新された記事です。")
      .excluded,
    false,
  );
});
