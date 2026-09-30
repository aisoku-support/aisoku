import { deepEqual, equal } from "node:assert/strict";
import {
  alternateLinks,
  createDiscoverer,
  DiscoveryResult,
  getHttpErrorInfo,
  getReasonCode,
  isBlockedIp,
  normalizeUrl,
} from "./discover.ts";

const rss =
  `<rss><channel><title>RSS title</title><item><title>A</title><link>/a</link></item></channel></rss>`;
const atom =
  `<feed><title>Atom title</title><entry><title>A</title><link href="/a"/></entry></feed>`;
const rdf =
  `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>RDF title</title></channel><item><title>A</title><link>/a</link></item></rdf:RDF>`;

function response(text: string, status = 200, headers: HeadersInit = {}) {
  return new Response(text, { status, headers });
}

function streamResponse(
  chunks: Array<string | Uint8Array>,
  stats: { reads: number; cancelled: boolean },
) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        stats.reads++;
        if (index === chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[index++];
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      },
      cancel() {
        stats.cancelled = true;
      },
    }, { highWaterMark: 0 }),
  );
}

function discoverWith(routes: Record<string, () => Response>) {
  return createDiscoverer({
    fetch: async (url) => routes[url]?.() ?? response("", 404),
    resolveDns: async () => ["93.184.216.34"],
  });
}

async function rejectsDiscovery(
  url: string,
  resolveDns: (host: string, type: "A" | "AAAA") => Promise<string[]> =
    async () => ["93.184.216.34"],
) {
  const discover = createDiscoverer({
    fetch: async () => response(""),
    resolveDns,
  });
  try {
    await discover(url);
    throw new Error("expected rejection");
  } catch (error) {
    if ((error as Error).message === "expected rejection") throw error;
  }
}

async function checkCandidatesLength(
  promise: Promise<DiscoveryResult>,
  expected: number,
) {
  const result = await promise;
  equal(result.candidates.length, expected);
}

Deno.test("getReasonCode maps error messages to reason codes", () => {
  equal(getReasonCode("unsupported URL"), "url_rejected");
  equal(getReasonCode("blocked host"), "url_rejected");
  equal(getReasonCode("blocked DNS result"), "dns_rejected");
  equal(getReasonCode("discovery timeout"), "discovery_deadline");
  equal(getReasonCode("response too large"), "response_too_large");
  equal(getReasonCode("fetch timeout"), "fetch_timeout");
  equal(getReasonCode("redirect loop"), "redirect_loop");
  equal(getReasonCode("invalid redirect"), "redirect_rejected");
  equal(getReasonCode("too many redirects"), "too_many_redirects");
  equal(getReasonCode("HTTP 403 stage:article"), "http_error");
  equal(getReasonCode("unknown error"), "fetch_failed");
});

Deno.test("getHttpErrorInfo extracts status and stage from error message", () => {
  deepEqual(getHttpErrorInfo("HTTP 403 stage:article"), {
    http_status: 403,
    http_stage: "article",
  });
  deepEqual(getHttpErrorInfo("HTTP 404 stage:homepage"), {
    http_status: 404,
    http_stage: "homepage",
  });
  deepEqual(getHttpErrorInfo("other error"), {
    http_status: undefined,
    http_stage: undefined,
  });
});

Deno.test("guide page is discovered via anchor tags with various criteria", async () => {
  const rssRes = () => response(rss);
  const guideRes = () =>
    response('<a href="/feed.xml">Actual Feed</a>', 200, {
      "content-type": "text/html",
    });

  const routes: Record<string, () => Response> = {
    // 1. href contains rss
    "https://example.com/article": () =>
      response('<a href="/rss-guide.html">RSS Guide</a>'),
    "https://example.com/rss-guide.html": guideRes,
    "https://example.com/feed.xml": rssRes,
    "https://example.com/": () => response(""),
  };
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    1,
  );

  // 2. href contains feed
  routes["https://example.com/article"] = () =>
    response('<a href="/the-feed-page">Feed</a>');
  routes["https://example.com/the-feed-page"] = guideRes;
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    1,
  );

  // 3. text contains RSS
  routes["https://example.com/article"] = () =>
    response('<a href="/page1">Check our RSS</a>');
  routes["https://example.com/page1"] = guideRes;
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    1,
  );

  // 4. img alt contains フィード
  routes["https://example.com/article"] = () =>
    response('<a href="/page2"><img alt="RSSフィード" src="x"></a>');
  routes["https://example.com/page2"] = guideRes;
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    1,
  );

  // 5. img title contains RSS
  routes["https://example.com/article"] = () =>
    response('<a href="/page3"><img title="Subscribe RSS" src="x"></a>');
  routes["https://example.com/page3"] = guideRes;
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    1,
  );

  // 6. Protocol-relative URL
  routes["https://example.com/article"] = () =>
    response('<a href="//other.com/rss">RSS</a>');
  routes["https://other.com/rss"] = rssRes;
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    1,
  );

  // 7. Unrelated link ignored
  const unrelatedRoutes: Record<string, () => Response> = {
    "https://example.org/article": () =>
      response('<a href="/about">About Us</a>'),
    "https://example.org/": () => response(""),
  };
  await checkCandidatesLength(
    discoverWith(unrelatedRoutes)("https://example.org/article"),
    0,
  );
});

Deno.test("guide page exploration is limited to 1 level", async () => {
  const routes: Record<string, () => Response> = {
    "https://example.com/article": () => response('<a href="/guide1">RSS</a>'),
    "https://example.com/guide1": () =>
      response('<a href="/guide2">More RSS</a>', 200, {
        "content-type": "text/html",
      }),
    "https://example.com/guide2": () =>
      response('<a href="/feed.xml">Final Feed</a>', 200, {
        "content-type": "text/html",
      }),
    "https://example.com/feed.xml": () => response(rss),
    "https://example.com/": () => response(""),
  };
  await checkCandidatesLength(
    discoverWith(routes)("https://example.com/article"),
    0,
  );
});

Deno.test("ASCII.jp scenario: dead alternate, valid anchor guide", async () => {
  const routes: Record<string, () => Response> = {
    "https://ascii.jp/news/1": () =>
      response(`
      <link rel="alternate" type="application/rss+xml" href="http://ascii.jp/dead/rss.xml">
      <a href="https://ascii.jp/info/about_rss.html"><img alt="RSSフィード" src="x"></a>
    `),
    "http://ascii.jp/dead/rss.xml": () => response("", 404),
    "https://ascii.jp/info/about_rss.html": () =>
      response('<a href="/rss.xml">Feed</a>', 200, {
        "content-type": "text/html",
      }),
    "https://ascii.jp/rss.xml": () => response(rss),
    "https://ascii.jp/": () => response(""),
  };
  await checkCandidatesLength(
    discoverWith(routes)("https://ascii.jp/news/1"),
    1,
  );
});

Deno.test("HTML alternate link candidates resolve and normalize", () => {
  deepEqual(
    alternateLinks(
      '<link rel="alternate" type="application/rss+xml" href="/feed#x">',
      "https://example.com/a",
    ),
    ["https://example.com/feed#x"],
  );
  equal(
    normalizeUrl("HTTPS://Example.COM:443/feed#part"),
    "https://example.com/feed",
  );
});

Deno.test("RSS, Atom and RDF feeds are validated", async () => {
  for (const [path, xml] of Object.entries({ rss, atom, rdf })) {
    const routes: Record<string, () => Response> = {
      "https://example.com/article": () =>
        response(
          `<link rel="alternate" type="application/rss+xml" href="/${path}">`,
        ),
      "https://example.com/": () => response(""),
    };
    routes[`https://example.com/${path}`] = () => response(xml);
    const discover = discoverWith(routes);
    await checkCandidatesLength(discover("https://example.com/article"), 1);
  }
});

Deno.test("an HTML RSS guide is explored once and resolves relative feed links", async () => {
  const discover = discoverWith({
    "https://example.com/article": () =>
      response(
        '<link rel="alternate" type="application/rss+xml" href="/guide">',
      ),
    "https://example.com/guide": () =>
      response(
        '<link rel="alternate" type="application/rss+xml" href="feeds/rss.xml">',
        200,
        { "content-type": "text/html" },
      ),
    "https://example.com/feeds/rss.xml": () => response(rss),
  });

  const result = await discover("https://example.com/article");
  deepEqual(result.candidates, [{
    url: "https://example.com/feeds/rss.xml",
    title: "RSS title",
  }]);
});

Deno.test("an HTML RSS guide extracts RSS-like ordinary anchors only", async () => {
  const discover = discoverWith({
    "https://example.com/article": () =>
      response(
        '<link rel="alternate" type="application/rss+xml" href="/guide">',
      ),
    "https://example.com/guide": () =>
      response(
        `
      <a href="//example.com/rss-main">RSS</a>
      <a href="/feeds/news">News Feed</a>
      <a href="/jp.xml">フィード</a>
      <p>RSS is mentioned in body text only</p>
      <a href="/about">About</a>
    `,
        200,
        { "content-type": "text/html" },
      ),
    "https://example.com/rss-main": () => response(rss),
    "https://example.com/feeds/news": () => response(atom),
    "https://example.com/jp.xml": () => response(rdf),
    "https://example.com/about": () => response(rss),
  });

  const result = await discover("https://example.com/article");
  equal(result.candidates.length, 3);
  equal(result.candidates.some((value) => value.url.endsWith("/about")), false);
});

Deno.test("an HTML RSS guide can yield multiple feeds but never follows a second guide", async () => {
  const calls: string[] = [];
  const discover = createDiscoverer({
    fetch: async (url) => {
      calls.push(url);
      if (url === "https://example.com/article") {
        return response(
          '<link rel="alternate" type="application/rss+xml" href="/guide">',
        );
      }
      if (url === "https://example.com/guide") {
        return response(
          '<link rel="alternate" type="application/rss+xml" href="/rss"><link rel="alternate" type="application/atom+xml" href="/atom"><link rel="alternate" type="application/atom+xml" href="/second-guide">',
          200,
          { "content-type": "text/html" },
        );
      }
      if (url === "https://example.com/rss") return response(rss);
      if (url === "https://example.com/atom") return response(atom);
      if (url === "https://example.com/second-guide") {
        return response(
          '<link rel="alternate" type="application/rss+xml" href="/must-not-fetch">',
          200,
          { "content-type": "text/html" },
        );
      }
      return response("");
    },
    resolveDns: async () => ["93.184.216.34"],
  });

  await checkCandidatesLength(discover("https://example.com/article"), 2);
  equal(calls.includes("https://example.com/must-not-fetch"), false);
});

Deno.test("RSS guide links respect the candidate limit", async () => {
  const feedLinks = Array.from(
    { length: 20 },
    (_, index) =>
      `<link rel="alternate" type="application/rss+xml" href="/feed-${index}">`,
  ).join("");
  const discover = createDiscoverer({
    fetch: async (url) => {
      if (url === "https://example.com/article") {
        return response(
          '<link rel="alternate" type="application/rss+xml" href="/guide">',
        );
      }
      if (url === "https://example.com/guide") {
        return response(feedLinks, 200, { "content-type": "text/html" });
      }
      return response(rss);
    },
    resolveDns: async () => ["93.184.216.34"],
  });

  const result = await discover("https://example.com/article");
  equal(result.candidates.length, 11);
});

Deno.test("zero candidates, duplicate candidates, top-page discovery and conventional paths", async () => {
  const fromTop = discoverWith({
    "https://example.com/article": () => response(""),
    "https://example.com/": () =>
      response(
        '<link rel="alternate" type="application/atom+xml" href="/atom"><link rel="alternate" type="application/atom+xml" href="/atom#same">',
      ),
    "https://example.com/atom": () => response(atom),
  });
  await checkCandidatesLength(fromTop("https://example.com/article"), 1);
  const fallback = discoverWith({
    "https://example.com/article": () => response(""),
    "https://example.com/": () => response(""),
    "https://example.com/feed": () => response(rss),
  });
  await checkCandidatesLength(fallback("https://example.com/article"), 1);
  const none = discoverWith({
    "https://example.com/article": () => response(""),
    "https://example.com/": () => response(""),
  });
  await checkCandidatesLength(none("https://example.com/article"), 0);
});

Deno.test("redirect is followed and HTTP errors are excluded", async () => {
  const discover = discoverWith({
    "https://example.com/article": () =>
      response("", 302, { location: "/moved" }),
    "https://example.com/moved": () =>
      response(
        '<link rel="alternate" type="application/rss+xml" href="/feed">',
      ),
    "https://example.com/": () => response(""),
    "https://example.com/feed": () => response(rss),
  });
  await checkCandidatesLength(discover("https://example.com/article"), 1);
});

Deno.test("article 4xx and 5xx continue once to the homepage", async () => {
  for (const status of [403, 404, 500]) {
    const calls: string[] = [];
    const discover = createDiscoverer({
      fetch: async (url) => {
        calls.push(url);
        if (url === "https://example.com/news/123") return response("", status);
        return response("");
      },
      resolveDns: async () => ["93.184.216.34"],
    });

    await checkCandidatesLength(discover("https://example.com/news/123"), 0);
    equal(
      calls.filter((url) => url === "https://example.com/news/123").length,
      1,
    );
    equal(calls.includes("https://example.com/"), true);
  }
});

Deno.test("article 403 finds an alternate feed from the homepage", async () => {
  const discover = discoverWith({
    "https://example.com/news/123": () => response("", 403),
    "https://example.com/": () =>
      response(
        '<link rel="alternate" type="application/rss+xml" href="/feed">',
      ),
    "https://example.com/feed": () => response(rss),
  });

  await checkCandidatesLength(discover("https://example.com/news/123"), 1);
});

Deno.test("article HTTP failures continue through homepage and common paths", async () => {
  const fromFeed = discoverWith({
    "https://example.com/news/123": () => response("", 403),
    "https://example.com/": () => response("", 403),
    "https://example.com/feed": () => response(rss),
  });
  await checkCandidatesLength(fromFeed("https://example.com/news/123"), 1);

  const fromNextPath = discoverWith({
    "https://example.com/news/123": () => response("", 403),
    "https://example.com/": () => response("", 404),
    "https://example.com/feed": () => response("", 404),
    "https://example.com/rss": () => response(atom),
  });
  await checkCandidatesLength(fromNextPath("https://example.com/news/123"), 1);
});

Deno.test("article 403 exhausts fallback paths without retrying the article", async () => {
  const calls: string[] = [];
  const discover = createDiscoverer({
    fetch: async (url) => {
      calls.push(url);
      return response("", url === "https://example.com/news/123" ? 403 : 404);
    },
    resolveDns: async () => ["93.184.216.34"],
  });

  await checkCandidatesLength(discover("https://example.com/news/123"), 0);
  equal(
    calls.filter((url) => url === "https://example.com/news/123").length,
    1,
  );
  deepEqual(calls, [
    "https://example.com/news/123",
    "https://example.com/",
    "https://example.com/feed",
    "https://example.com/rss",
    "https://example.com/rss.xml",
    "https://example.com/feed.xml",
    "https://example.com/atom.xml",
  ]);
});

Deno.test("article DNS and SSRF rejections do not enter fallback discovery", async () => {
  let dnsFetches = 0;
  const dnsRejected = createDiscoverer({
    fetch: async () => {
      dnsFetches++;
      return response("");
    },
    resolveDns: async () => ["127.0.0.1"],
  });
  await rejectsPromise(
    dnsRejected("https://example.com/news/123"),
    "blocked DNS result",
  );
  equal(dnsFetches, 0);

  let ssrfFetches = 0;
  const ssrfRejected = createDiscoverer({
    fetch: async () => {
      ssrfFetches++;
      return response("");
    },
    resolveDns: async () => ["93.184.216.34"],
  });
  await rejectsPromise(
    ssrfRejected("http://127.0.0.1/news/123"),
    "blocked host",
  );
  equal(ssrfFetches, 0);
});

Deno.test("relative redirect loops stop safely", async () => {
  const discover = discoverWith({
    "https://example.com/a": () => response("", 302, { location: "/b" }),
    "https://example.com/b": () => response("", 302, { location: "/a" }),
  });
  try {
    await discover("https://example.com/a");
    throw new Error("expected rejection");
  } catch (error) {
    equal(
      ["redirect loop", "too many redirects"].includes(
        (error as Error).message,
      ),
      true,
    );
  }
});

Deno.test("redirect destination is DNS-checked and private destinations are rejected", async () => {
  const discover = createDiscoverer({
    fetch: async (url) =>
      url === "https://example.com/article"
        ? response("", 302, { location: "https://internal.example/feed" })
        : response(rss),
    resolveDns: async (host) =>
      host === "internal.example" ? ["127.0.0.1"] : ["93.184.216.34"],
  });
  await Promise.resolve();
  try {
    await discover("https://example.com/article");
    throw new Error("expected rejection");
  } catch (error) {
    equal((error as Error).message, "blocked DNS result");
  }
});

Deno.test("per-request timeout aborts a stalled fetch", async () => {
  const discover = createDiscoverer({
    fetch: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
        )
      ),
    resolveDns: async () => ["93.184.216.34"],
    requestTimeoutMs: 1,
  });
  try {
    await discover("https://example.com/article");
    throw new Error("expected timeout");
  } catch (error) {
    equal((error as Error).message, "aborted");
  }
});

Deno.test("whole deadline also covers DNS lookup", async () => {
  const discover = createDiscoverer({
    fetch: async () => response(""),
    resolveDns: async () => await new Promise<string[]>(() => {}),
    discoveryTimeoutMs: 1,
  });
  await rejectsPromise(
    discover("https://example.com/article"),
    "discovery timeout",
  );
});

Deno.test("HTML discovery reads past 512KB and keeps feed validation limited", async () => {
  const articleStats = { reads: 0, cancelled: false };
  const discover = createDiscoverer({
    fetch: async (url) => {
      if (url === "https://example.com/article") {
        return streamResponse([
          "<head>" + "x".repeat(512 * 1024),
          '<link rel="alternate" type="application/rss+xml" href="/feed"></head>',
        ], articleStats);
      }
      if (url === "https://example.com/feed") return response(rss);
      return response("");
    },
    resolveDns: async () => ["93.184.216.34"],
  });
  await checkCandidatesLength(discover("https://example.com/article"), 1);
  equal(articleStats.reads >= 2, true);

  const feedTooLarge = createDiscoverer({
    fetch: async (url) =>
      url === "https://example.com/article"
        ? response(
          '<link rel="alternate" type="application/rss+xml" href="/feed">',
        )
        : new Response(new Uint8Array(512 * 1024 + 1)),
    resolveDns: async () => ["93.184.216.34"],
  });
  await checkCandidatesLength(feedTooLarge("https://example.com/article"), 0);
});

Deno.test("HTML stream handles split tags, UTF-8 and continues through body", async () => {
  const stats = { reads: 0, cancelled: false };
  const emoji = new TextEncoder().encode("あ");
  const discover = createDiscoverer({
    fetch: async (url) => {
      if (url === "https://example.com/article") {
        return streamResponse([
          "<head>" + "x".repeat(512 * 1024 - 20) + '<link rel="alter',
          new Uint8Array([
            ...new TextEncoder().encode(
              'nate" type="application/rss+xml" href="/feed">',
            ),
            ...emoji.slice(0, 2),
          ]),
          new Uint8Array([
            ...emoji.slice(2),
            ...new TextEncoder().encode("</HEAD>"),
          ]),
          "unused but read",
        ], stats);
      }
      if (url === "https://example.com/feed") return response(rss);
      return response("");
    },
    resolveDns: async () => ["93.184.216.34"],
  });
  await checkCandidatesLength(discover("https://example.com/article"), 1);
  equal(stats.reads >= 4, true);
});

Deno.test("HTML stream stops at the 4MB total-read limit without retaining the body", async () => {
  const stats = { reads: 0, cancelled: false };
  const megabyte = new Uint8Array(1024 * 1024);
  const discover = createDiscoverer({
    fetch: async (url) =>
      url === "https://example.com/article"
        ? streamResponse([
          megabyte,
          megabyte,
          megabyte,
          megabyte,
          megabyte,
          megabyte,
        ], stats)
        : response(""),
    resolveDns: async () => ["93.184.216.34"],
  });
  try {
    await discover("https://example.com/article");
  } catch (error) {
    equal((error as Error).message, "response too large");
  }
  equal(stats.reads >= 5, true);
  equal(stats.cancelled, true);
});

Deno.test("HTML body reads are covered by the discovery deadline", async () => {
  const discover = createDiscoverer({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: async () => await new Promise<void>(() => {}),
        }),
      ),
    resolveDns: async () => ["93.184.216.34"],
    discoveryTimeoutMs: 1,
  });
  await rejectsPromise(
    discover("https://example.com/article"),
    "discovery timeout",
  );
});

async function rejectsPromise(promise: Promise<unknown>, message: string) {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    equal((error as Error).message, message);
  }
}

Deno.test("SSRF address families and unsupported schemes are rejected", () => {
  for (
    const value of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]
  ) equal(isBlockedIp(value), true);
  equal(normalizeUrl("file:///etc/passwd"), null);
});

Deno.test("URL parser output is validated and unsafe URL forms are rejected", async () => {
  equal(normalizeUrl("http://user:pass@example.com/"), null);
  equal(normalizeUrl("http://example.com:22/"), null);
  equal(normalizeUrl("HTTPS://EXAMPLE.COM./a"), "https://example.com/a");
  await rejectsDiscovery("http://localhost./");
  await rejectsDiscovery("http://sub.localhost/");
  await rejectsDiscovery("http://%6cocalhost/");
  await rejectsDiscovery("http://example.com@127.0.0.1/");
  await rejectsDiscovery("http://2130706433/");
  await rejectsDiscovery("http://[::ffff:127.0.0.1]/");
});

Deno.test("mixed public and private DNS answers fail closed", async () => {
  await rejectsDiscovery(
    "https://example.com/",
    async () => ["93.184.216.34", "10.0.0.1"],
  );
});
