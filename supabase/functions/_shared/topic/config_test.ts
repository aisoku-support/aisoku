import { strictEqual } from "node:assert/strict";
import { topicConfig, withTopicProcessingAuth } from "./config.ts";

Deno.test("topic worker rejects missing and invalid secrets before handler work", async () => {
  let dbQueueClaims = 0;
  let upstashRequests = 0;
  let aiRequests = 0;
  const handler = withTopicProcessingAuth(
    () => "expected-secret",
    async () => {
      dbQueueClaims++;
      upstashRequests++;
      aiRequests++;
      return new Response("processed");
    },
  );

  for (
    const headers of [
      new Headers(),
      new Headers({ [topicConfig.authHeader]: "invalid-secret" }),
    ]
  ) {
    const response = await handler(
      new Request("https://worker.invalid", {
        method: "POST",
        headers,
      }),
    );
    strictEqual(response.status, 401);
  }

  strictEqual(dbQueueClaims, 0);
  strictEqual(upstashRequests, 0);
  strictEqual(aiRequests, 0);
});

Deno.test("topic worker accepts the configured secret and enters its handler", async () => {
  let handlerCalls = 0;
  const handler = withTopicProcessingAuth(
    () => "expected-secret",
    async () => {
      handlerCalls++;
      return new Response("handled");
    },
  );
  const response = await handler(
    new Request("https://worker.invalid", {
      method: "POST",
      headers: { [topicConfig.authHeader]: "expected-secret" },
    }),
  );

  strictEqual(response.status, 200);
  strictEqual(handlerCalls, 1);
});
