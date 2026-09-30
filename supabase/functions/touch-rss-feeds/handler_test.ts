import { strictEqual } from "node:assert";
import { createTouchRssFeedsHandler } from "./handler.ts";

const testKey = "test-only-publishable-key";
const env = {
  url: "https://test-project.supabase.co",
  publishableKeys: { default: testKey },
};
const upstash = {
  url: "https://test-upstash.example",
  token: "test-only-token",
};

function request(headers: HeadersInit = {}, body: unknown = { urls: [] }) {
  return new Request(
    "https://test-project.supabase.co/functions/v1/touch-rss-feeds",
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
  const handler = createTouchRssFeedsHandler({ env, upstash });
  const response = await handler(request());
  strictEqual(response.status, 401);
});

Deno.test("rejects an invalid API key", async () => {
  const handler = createTouchRssFeedsHandler({ env, upstash });
  const response = await handler(request({ apikey: "invalid-test-key" }));
  strictEqual(response.status, 401);
});

Deno.test("does not accept a service-role-like bearer credential", async () => {
  const handler = createTouchRssFeedsHandler({ env, upstash });
  const response = await handler(
    request({ authorization: "Bearer test-service-role-key" }),
  );
  strictEqual(response.status, 401);
});

Deno.test("empty and invalid URL lists do not access Upstash", async () => {
  let calls = 0;
  const handler = createTouchRssFeedsHandler({
    env,
    upstash,
    fetcher: async () => {
      calls++;
      throw new Error("unexpected fetch");
    },
  });
  const empty = await handler(request({ apikey: testKey }, { urls: [] }));
  const invalid = await handler(
    request({ apikey: testKey }, { urls: ["file:///etc/passwd"] }),
  );
  strictEqual(empty.status, 200);
  strictEqual(invalid.status, 200);
  strictEqual(calls, 0);
});

Deno.test("valid key checks membership and touches only registered URLs using mocks", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const handler = createTouchRssFeedsHandler({
    env,
    upstash,
    now: () => 1_000,
    fetcher: async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      if (calls.length === 1) {
        return Response.json([{ result: 1 }, { result: 0 }]);
      }
      return Response.json({ result: 1 });
    },
  });
  const response = await handler(request({ apikey: testKey }, {
    urls: ["https://example.com/a.xml", "https://example.com/b.xml"],
  }));
  strictEqual(response.status, 200);
  strictEqual(calls.length, 2);
  strictEqual(JSON.parse(calls[0].body)[0][0], "SISMEMBER");
  strictEqual(JSON.parse(calls[1].body)[0], "ZADD");
  strictEqual(
    JSON.parse(calls[1].body).includes("https://example.com/b.xml"),
    false,
  );
});
