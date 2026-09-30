import { strictEqual } from "node:assert";
import { createGetTopicSourcesHandler } from "./handler.ts";

const testKey = "test-only-publishable-key";
const env = {
  url: "https://test-project.supabase.co",
  publishableKeys: { default: testKey },
};

function request(headers: HeadersInit = {}, topicId = "not-a-uuid") {
  return new Request(
    "https://test-project.supabase.co/functions/v1/get-topic-sources",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      body: JSON.stringify({ topic_id: topicId }),
    },
  );
}

Deno.test("rejects a request without an API key", async () => {
  const handler = createGetTopicSourcesHandler({ env });
  const response = await handler(request());
  strictEqual(response.status, 401);
});

Deno.test("allows an unauthenticated CORS preflight", async () => {
  const handler = createGetTopicSourcesHandler({ env });
  const response = await handler(
    new Request(
      "https://test-project.supabase.co/functions/v1/get-topic-sources",
      { method: "OPTIONS" },
    ),
  );
  strictEqual(response.status, 200);
});

Deno.test("rejects an invalid API key", async () => {
  const handler = createGetTopicSourcesHandler({ env });
  const response = await handler(request({ apikey: "invalid-test-key" }));
  strictEqual(response.status, 401);
});

Deno.test("does not accept a service-role-like bearer credential", async () => {
  const handler = createGetTopicSourcesHandler({ env });
  const response = await handler(
    request({ authorization: "Bearer test-service-role-key" }),
  );
  strictEqual(response.status, 401);
});

Deno.test("rejects a malformed topic ID before any external read", async () => {
  let fetchCalls = 0;
  const handler = createGetTopicSourcesHandler({
    env,
    fetcher: async () => {
      fetchCalls++;
      throw new Error("unexpected fetch");
    },
  });
  const response = await handler(request({ apikey: testKey }));
  strictEqual(response.status, 400);
  strictEqual(fetchCalls, 0);
});
