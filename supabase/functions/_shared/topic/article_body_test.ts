import { strictEqual } from "node:assert";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.56";
import { cleanArticleText, extractArticleBody } from "./article_body.ts";

const articleUrl = "https://news.example.com/story/42";
const html = (content: string) =>
  `<!doctype html><html><head><title>fixture</title></head><body><article><h1>Fixture</h1>${content}</article></body></html>`;
const response = (body: string, url = articleUrl, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => body,
  body: null,
});
const parser = (text: string | null) => () => ({
  parse: () => text === null ? null : { textContent: text.trim() },
});

Deno.test("header failure followed by body failure uses only two requests", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    if (calls === 1) throw new TypeError("connection lost");
    return {
      ...response(""),
      text: async () => {
        throw new TypeError("body lost");
      },
    };
  }, parser("should not be used"));
  strictEqual(calls, 2);
  strictEqual(result.ok, false);
});

Deno.test("body retry checks redirect before extracting a listing page", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    if (calls === 1) {
      return {
        ...response(""),
        text: async () => {
          throw new TypeError("body lost");
        },
      };
    }
    return response("listing", "https://news.example.com/");
  }, parser("should not be used"));
  strictEqual(calls, 2);
  strictEqual(result.ok, false);
  if (!result.ok) strictEqual(result.reason, "redirect_to_listing");
});
Deno.test("HTML fetch and Readability extract body with exactly one fetch", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    return response(html("<p>A full fixture article body for extraction.</p>"));
  }, parser("A full fixture article body for extraction."));
  strictEqual(calls, 1);
  strictEqual(result.ok, true);
  strictEqual(result.extractionMethod, "readability");
  strictEqual(result.durationMs >= 0, true);
  strictEqual(result.httpStatus, 200);
  strictEqual(result.diagnostics?.domain, "news.example.com");
  strictEqual(result.diagnostics?.finalDomain, "news.example.com");
  strictEqual(result.diagnostics?.domParse, "success");
  strictEqual(
    result.chars,
    Array.from("A full fixture article body for extraction.").length,
  );
});

Deno.test("failed HTML fetch is an article exclusion after bounded retry", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    throw new Error("offline");
  }, parser(null));
  strictEqual(calls, 2);
  strictEqual(result.ok, false);
  if (!result.ok) strictEqual(result.reason, "fetch_failed");
});

Deno.test("retries one transient fetch failure and never exceeds the retry limit", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    if (calls < 3) throw new TypeError("temporary network failure");
    return response(html("<p>Recovered fixture body.</p>"));
  }, parser("Recovered fixture body."));
  strictEqual(calls, 2);
  strictEqual(result.ok, false);
  if (!result.ok) strictEqual(result.reason, "fetch_failed");

  calls = 0;
  const recovered = await extractArticleBody(articleUrl, async () => {
    calls++;
    if (calls === 1) throw new TypeError("temporary network failure");
    return response(html("<p>Recovered fixture body.</p>"));
  }, parser("Recovered fixture body."));
  strictEqual(calls, 2);
  strictEqual(recovered.ok, true);
});

Deno.test("HTTP client errors are classified and not retried", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    return { ...response("", articleUrl, 404), status: 404 };
  });
  strictEqual(calls, 1);
  strictEqual(result.ok, false);
  if (!result.ok) {
    strictEqual(result.reason, "http_error");
    strictEqual(result.httpStatus, 404);
    strictEqual(result.extractionMethod, "none");
    strictEqual(result.readability, "not_run");
  }
});

Deno.test("HTTP 5xx retries once, then stops at the limit", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    return { ...response("server error", articleUrl, 503), status: 503 };
  });
  strictEqual(calls, 2);
  strictEqual(result.ok, false);
  if (!result.ok) strictEqual(result.reason, "http_error");
});

Deno.test("timeout is classified separately and retried once", async () => {
  let calls = 0;
  const result = await extractArticleBody(articleUrl, async () => {
    calls++;
    throw new DOMException("timed out", "TimeoutError");
  });
  strictEqual(calls, 2);
  strictEqual(result.ok, false);
  if (!result.ok) strictEqual(result.reason, "timeout");
});

Deno.test("Readability parse failure and empty body are excluded", async () => {
  const parseFailure = await extractArticleBody(
    articleUrl,
    async () => response(""),
    parser(null),
  );
  strictEqual(parseFailure.ok, false);
  if (!parseFailure.ok) {
    strictEqual(parseFailure.reason, "readability_failed");
    strictEqual(parseFailure.httpStatus, 200);
    strictEqual(parseFailure.diagnostics?.readabilityFailure, "null_result");
  }
  const emptyBody = await extractArticleBody(
    articleUrl,
    async () => response(html("<p></p>")),
    parser(" "),
  );
  strictEqual(emptyBody.ok, false);
  if (!emptyBody.ok) {
    strictEqual(emptyBody.reason, "empty_body");
    strictEqual(emptyBody.httpStatus, 200);
    strictEqual(emptyBody.chars, 0);
    strictEqual(emptyBody.diagnostics?.readabilityFailure, null);
  }
});

Deno.test("DOM setup and cleanup failures are distinct from Readability failures", async () => {
  const domSetupFailure = await extractArticleBody(
    articleUrl,
    async () => response(html("<p>Fixture content.</p>")),
    () => {
      throw new Error("DOM setup failed");
    },
  );
  strictEqual(domSetupFailure.ok, false);
  if (!domSetupFailure.ok) {
    strictEqual(domSetupFailure.reason, "dom_parse_failed");
    strictEqual(domSetupFailure.diagnostics?.domParse, "failed");
  }

  const readabilityException = await extractArticleBody(
    articleUrl,
    async () => response(html("<p>Fixture content.</p>")),
    () => ({
      parse: () => {
        throw new Error("Readability failed");
      },
    }),
  );
  strictEqual(readabilityException.ok, false);
  if (!readabilityException.ok) {
    strictEqual(readabilityException.reason, "readability_failed");
    strictEqual(readabilityException.diagnostics?.readabilityFailure, "exception");
    strictEqual(readabilityException.diagnostics?.exceptionType, "Error");
  }

  const cleanupFailure = await extractArticleBody(
    articleUrl,
    async () => response(html("<p>Fixture content.</p>")),
    () => ({ parse: () => ({ content: "<p>Fixture content.</p>" }) }),
    () => {
      throw new Error("DOM cleanup parse failed");
    },
  );
  strictEqual(cleanupFailure.ok, false);
  if (!cleanupFailure.ok) {
    strictEqual(cleanupFailure.reason, "dom_parse_failed");
    strictEqual(cleanupFailure.readability, "success");
    strictEqual(cleanupFailure.diagnostics?.domParse, "failed");
  }
});

Deno.test("body diagnostics keep only source domains and count bounded retries", async () => {
  const sensitiveUrl = "https://user:password@news.example.com/story?token=private-value";
  let calls = 0;
  const result = await extractArticleBody(
    sensitiveUrl,
    async () => {
      calls++;
      return calls === 1
        ? response("", "https://redirect.example.net/story?key=private-value", 503)
        : response(html("<p>Article text stays private.</p>"), "https://redirect.example.net/story?key=private-value");
    },
    parser("Article text stays private."),
  );
  strictEqual(result.ok, true);
  strictEqual(calls, 2);
  strictEqual(result.diagnostics?.domain, "news.example.com");
  strictEqual(result.diagnostics?.finalDomain, "redirect.example.net");
  strictEqual(result.diagnostics?.retryCount, 1);
  const rendered = JSON.stringify(result.diagnostics);
  strictEqual(rendered.includes("password"), false);
  strictEqual(rendered.includes("private-value"), false);
  strictEqual(rendered.includes("https://"), false);
});

Deno.test("pinned deno-dom DOMParser works with vendored Readability and cleanup", async () => {
  const paragraphs = Array.from(
    { length: 32 },
    (_, i) =>
      `<p>Article paragraph ${
        i + 1
      }: This saved fixture contains enough real article text for Mozilla Readability to select the main article body and for the existing cleaner to process it safely.</p>`,
  ).join("");
  const savedHtml =
    `<!doctype html><html><head><title>Saved fixture article</title></head><body><main><article><h1>Fixture article</h1>${paragraphs}</article></main></body></html>`;
  const document = new DOMParser().parseFromString(savedHtml, "text/html");
  strictEqual(document.querySelector("article") !== null, true);

  const result = await extractArticleBody(
    articleUrl,
    async () => response(savedHtml),
  );
  strictEqual(result.ok, true);
  if (result.ok) {
    strictEqual(result.chars > 500, true);
    strictEqual(result.body.includes("Article paragraph 32"), true);
  }
});

Deno.test("a single character body is successful", async () => {
  const result = await extractArticleBody(
    articleUrl,
    async () => response(html("<p>one-character-valid-body</p>")),
    parser("x"),
  );
  strictEqual(result.ok, true);
  if (result.ok) strictEqual(result.chars > 0, true);
});

Deno.test("normal redirects are allowed and listing redirects are rejected", async () => {
  const normal = await extractArticleBody(
    articleUrl,
    async () =>
      response(
        html("<p>Redirected article body remains valid.</p>"),
        "https://www.news.example.com/story/42-new",
      ),
    parser("Redirected article body remains valid."),
  );
  strictEqual(normal.ok, true);
  if (normal.ok) strictEqual(normal.redirected, true);
  const listing = await extractArticleBody(
    articleUrl,
    async () =>
      response(
        html("<p>Top listing item one item two</p>"),
        "https://news.example.com/",
      ),
    parser(""),
  );
  strictEqual(listing.ok, false);
  if (!listing.ok) strictEqual(listing.reason, "redirect_to_listing");
});

Deno.test("safe clean removes sponsored block only", () => {
  const cleaned = cleanArticleText(
    '<p>normal article text stays here</p><div><a rel="sponsored">ad card</a></div><p>later article text stays here</p>',
    fixtureParser,
  );
  strictEqual(cleaned.includes("ad card"), false);
  strictEqual(cleaned.includes("normal article text"), true);
  strictEqual(cleaned.includes("later article text"), true);
});
const fixtureParser = (content: string) => {
  let inner = content;
  const links = Array.from(
    content.matchAll(/<a\b[^>]*rel="sponsored"[^>]*>.*?<\/a>/gi),
  );
  const blocks = links.map((match) => {
    const start = match.index ?? 0;
    const opening = inner.lastIndexOf("<div", start);
    const close = inner.indexOf("</div>", start);
    const end = close >= 0 ? close + 6 : start + match[0].length;
    const element: any = {
      parentElement: null,
      tagName: "DIV",
      textContent: "広告商品",
      querySelectorAll: (selector: string) =>
        selector === "a" ? [{ textContent: "広告商品" }] : [],
      remove: () => {
        inner = inner.slice(0, opening >= 0 ? opening : start) +
          inner.slice(end);
      },
    };
    return element;
  });
  const body: any = {
    parentElement: null,
    tagName: "BODY",
    get innerHTML() {
      return inner;
    },
    set innerHTML(value: string) {
      inner = value;
    },
    querySelectorAll: (selector: string) =>
      selector === "[rel~='sponsored']" ? blocks : [],
    get textContent() {
      return inner.replace(/<[^>]*>/g, "");
    },
  };
  return { body };
};

Deno.test("extractor diagnostics contain no source text", async () => {
  const secretFixture = "PRIVATE_BODY_SENTINEL";
  let logged = "";
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logged += args.join(" ");
  try {
    const result = await extractArticleBody(
      articleUrl,
      async () =>
        response(
          html(`<p>${secretFixture} has an article body for privacy.</p>`),
        ),
      parser(secretFixture),
    );
    console.log(
      JSON.stringify({
        ok: result.ok,
        chars: result.ok ? result.chars : result.chars,
      }),
    );
  } finally {
    console.log = originalLog;
  }
  strictEqual(logged.includes(secretFixture), false);
});
