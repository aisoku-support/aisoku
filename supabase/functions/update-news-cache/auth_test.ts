import { strictEqual } from "node:assert/strict";
import { NEWS_CACHE_JOB_AUTH_HEADER, withNewsCacheJobAuth } from "./auth.ts";

Deno.test("RSS cache job rejects missing configuration and invalid headers before work", async () => {
  let upstashRequests = 0;
  let rssRequests = 0;
  const handler = withNewsCacheJobAuth(
    () => "configured-secret",
    async () => {
      upstashRequests++;
      rssRequests++;
      return new Response("processed");
    },
  );
  const unconfiguredHandler = withNewsCacheJobAuth(
    () => undefined,
    async () => {
      upstashRequests++;
      rssRequests++;
      return new Response("processed");
    },
  );

  const requests = [
    await handler(new Request("https://job.invalid", { method: "POST" })),
    await handler(
      new Request("https://job.invalid", {
        method: "POST",
        headers: { [NEWS_CACHE_JOB_AUTH_HEADER]: "invalid-secret" },
      }),
    ),
    await unconfiguredHandler(
      new Request("https://job.invalid", {
        method: "POST",
        headers: { [NEWS_CACHE_JOB_AUTH_HEADER]: "configured-secret" },
      }),
    ),
  ];

  for (const response of requests) strictEqual(response.status, 401);
  strictEqual(upstashRequests, 0);
  strictEqual(rssRequests, 0);
});

Deno.test("RSS cache job accepts its configured secret and enters the mock handler", async () => {
  let handlerCalls = 0;
  const handler = withNewsCacheJobAuth(
    () => "configured-secret",
    async () => {
      handlerCalls++;
      return new Response("handled");
    },
  );
  const response = await handler(
    new Request("https://job.invalid", {
      method: "POST",
      headers: { [NEWS_CACHE_JOB_AUTH_HEADER]: "configured-secret" },
    }),
  );

  strictEqual(response.status, 200);
  strictEqual(handlerCalls, 1);
});
