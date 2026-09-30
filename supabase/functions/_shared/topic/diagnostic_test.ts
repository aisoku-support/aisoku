import { safeReadJson } from "./queue.ts";
import { parseUpstashBody } from "./article_store.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertEquals failed: ${JSON.stringify(actual)} !== ${
        JSON.stringify(expected)
      }`,
    );
  }
}

Deno.test("safeReadJson handles empty body (mandatory)", async () => {
  const response = new Response("", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    await safeReadJson(response, "TestOp", { requireBody: true });
    throw new Error("Should have failed");
  } catch (e) {
    const error = e as Error;
    if (
      !error.message.includes("empty response") ||
      !error.message.includes("status=200") ||
      !error.message.includes("body_length=0")
    ) {
      throw new Error(`Wrong error message: ${error.message}`);
    }
  }
});

Deno.test("safeReadJson handles 204 No Content (optional body)", async () => {
  const response = new Response(null, {
    status: 204,
    headers: { "Content-Type": "application/json" },
  });
  const result = await safeReadJson(response, "TestOp", { requireBody: false });
  assertEquals(result, undefined);
});

Deno.test("safeReadJson handles 200 empty body (optional body)", async () => {
  const response = new Response("", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const result = await safeReadJson(response, "TestOp", { requireBody: false });
  assertEquals(result, undefined);
});

Deno.test("safeReadJson handles 200 with normal JSON", async () => {
  const response = new Response('{"ok":true}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const result = await safeReadJson<{ ok: boolean }>(response, "TestOp");
  assertEquals(result, { ok: true });
});

Deno.test("safeReadJson handles truncated/malformed JSON", async () => {
  const response = new Response('{"a": 1', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    await safeReadJson(response, "TestOp");
    throw new Error("Should have failed");
  } catch (e) {
    const error = e as Error;
    if (
      !error.message.includes("malformed JSON") ||
      !error.message.includes("status=200") ||
      !error.message.includes("body_length=7")
    ) {
      throw new Error(`Wrong error message: ${error.message}`);
    }
  }
});

Deno.test("safeReadJson handles HTTP error with diagnostics", async () => {
  const response = new Response("Error occurred", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
  try {
    await safeReadJson(response, "TestOp", { requireBody: false });
    throw new Error("Should have failed");
  } catch (e) {
    const error = e as Error;
    if (
      !error.message.includes("HTTP failure") ||
      !error.message.includes("status=500") ||
      !error.message.includes("content_type=text/plain")
    ) {
      throw new Error(`Wrong error message: ${error.message}`);
    }
  }
});

Deno.test("parseUpstashBody handles diagnostics correctly", () => {
  const body = '{"result":["ok"]}';
  const result = parseUpstashBody("MGET", body, 200, "application/json");
  assertEquals(result, ["ok"]);

  try {
    parseUpstashBody("MGET", "", 200, "application/json");
    throw new Error("Should have failed");
  } catch (e) {
    const error = e as Error;
    if (
      !error.message.includes("MGET") ||
      !error.message.includes("empty response") ||
      !error.message.includes("body_length=0")
    ) {
      throw new Error(`Wrong error message: ${error.message}`);
    }
  }

  try {
    parseUpstashBody("MGET", "{invalid}", 200, "application/json");
    throw new Error("Should have failed");
  } catch (e) {
    const error = e as Error;
    if (
      !error.message.includes("MGET") ||
      !error.message.includes("malformed response") ||
      !error.message.includes("body_length=9")
    ) {
      throw new Error(`Wrong error message: ${error.message}`);
    }
  }
});
