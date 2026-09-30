import { strictEqual } from "node:assert";
import { createEnsureRssFeedHandler } from "./handler.ts";

const testKey = "test-only-publishable-key";
const env = {
  url: "https://test-project.supabase.co",
  publishableKeys: { default: testKey },
};
const upstash = {
  url: "https://test-upstash.example",
  token: "test-only-token",
};

function request(
  headers: HeadersInit = {},
  body: unknown = { url: "https://example.com/feed.xml" },
) {
  return new Request(
    "https://test-project.supabase.co/functions/v1/ensure-rss-feed",
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
  const handler = createEnsureRssFeedHandler({ env, upstash });
  const response = await handler(request());
  strictEqual(response.status, 401);
});

Deno.test("rejects an invalid API key", async () => {
  const handler = createEnsureRssFeedHandler({ env, upstash });
  const response = await handler(request({ apikey: "invalid-test-key" }));
  strictEqual(response.status, 401);
});

Deno.test("does not accept a service-role-like bearer credential", async () => {
  const handler = createEnsureRssFeedHandler({ env, upstash });
  const response = await handler(
    request({ authorization: "Bearer test-service-role-key" }),
  );
  strictEqual(response.status, 401);
});

Deno.test("rejects invalid feed input without Upstash access", async () => {
  let calls = 0;
  const handler = createEnsureRssFeedHandler({
    env,
    upstash,
    fetcher: async () => {
      calls++;
      throw new Error("unexpected fetch");
    },
  });
  const response = await handler(
    request({ apikey: testKey }, { url: "file:///etc/passwd" }),
  );
  strictEqual(response.status, 400);
  strictEqual(calls, 0);
});

Deno.test("valid publishable key uses mocked Upstash GET and pipeline", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const handler = createEnsureRssFeedHandler({
    env,
    upstash,
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    fetcher: async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      if (calls.length === 1) return Response.json({ result: null });
      return new Response("ok", { status: 200 });
    },
  });
  const response = await handler(request({ apikey: testKey }));
  strictEqual(response.status, 200);
  strictEqual(calls.length, 2);
  strictEqual(calls[0].url, upstash.url);
  strictEqual(calls[1].url, `${upstash.url}/pipeline`);
  const commands = JSON.parse(calls[1].body);
  strictEqual(commands[0][0], "SADD");
  strictEqual(commands[1][0], "SET");
  strictEqual(commands[2][0], "ZADD");
});
