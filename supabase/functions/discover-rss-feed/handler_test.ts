import { strictEqual } from "node:assert";
import { createDiscoverRssFeedHandler } from "./handler.ts";

const testKey = "test-only-publishable-key";
const env = {
  url: "https://test-project.supabase.co",
  publishableKeys: { default: testKey },
};

function request(
  headers: HeadersInit = {},
  body: unknown = { url: "https://example.com/article" },
) {
  return new Request(
    "https://test-project.supabase.co/functions/v1/discover-rss-feed",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      body: JSON.stringify(body),
    },
  );
}

Deno.test("rejects a request without an API key", async () => {
  const handler = createDiscoverRssFeedHandler({ env });
  const response = await handler(request());
  strictEqual(response.status, 401);
});

Deno.test("rejects an invalid API key", async () => {
  const handler = createDiscoverRssFeedHandler({ env });
  const response = await handler(request({ apikey: "invalid-test-key" }));
  strictEqual(response.status, 401);
});

Deno.test("does not accept a service-role-like bearer credential", async () => {
  const handler = createDiscoverRssFeedHandler({ env });
  const response = await handler(
    request({}, { authorization: "Bearer test-service-role-key" }),
  );
  strictEqual(response.status, 401);
});

Deno.test("rejects missing URL without invoking external discovery", async () => {
  let discoverCalls = 0;
  const handler = createDiscoverRssFeedHandler({
    env,
    discover: async () => {
      discoverCalls++;
      return { candidates: [], diagnostics: {} as never };
    },
  });
  const response = await handler(request({ apikey: testKey }, {}));
  strictEqual(response.status, 400);
  strictEqual(discoverCalls, 0);
});

Deno.test("valid publishable key reaches injected discovery without network", async () => {
  let discoverCalls = 0;
  const handler = createDiscoverRssFeedHandler({
    env,
    discover: async () => {
      discoverCalls++;
      return {
        candidates: [{ url: "https://example.com/feed.xml", title: "Example" }],
        diagnostics: {} as never,
      };
    },
  });
  const response = await handler(request({ apikey: testKey }));
  strictEqual(response.status, 200);
  strictEqual(discoverCalls, 1);
});
