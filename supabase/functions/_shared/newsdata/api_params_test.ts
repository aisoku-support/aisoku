import { createApi } from "./api.ts";
import { config } from "./config.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("API Parameter Generation - normal", async () => {
  let capturedUrl: URL | null = null;
  const mockTransport = (async (url: string | URL | Request) => {
    capturedUrl = new URL(url instanceof Request ? url.url : url);
    return {
      ok: true,
      json: async () => ({ status: "success", results: [] }),
    } as Response;
  }) as typeof fetch;

  const api = createApi("test-key", config, mockTransport);
  await api(null, "normal");

  const params = capturedUrl!.searchParams;
  equal(params.get("apikey"), "test-key");
  equal(params.get("language"), "ja");
  equal(params.get("removeduplicate"), "1");
  equal(params.get("excludedomain"), config.excludedDomains);
  equal(params.has("q"), false);
  equal(params.has("qInTitle"), false);
  equal(params.has("prioritydomain"), false);
  equal(params.has("sort"), false);
});

Deno.test("API Parameter Generation - subculture", async () => {
  let capturedUrl: URL | null = null;
  const mockTransport = (async (url: string | URL | Request) => {
    capturedUrl = new URL(url instanceof Request ? url.url : url);
    return {
      ok: true,
      json: async () => ({ status: "success", results: [] }),
    } as Response;
  }) as typeof fetch;

  const api = createApi("test-key", config, mockTransport);
  await api(null, "subculture");

  const params = capturedUrl!.searchParams;
  equal(params.get("apikey"), "test-key");
  equal(params.get("q"), config.subcultureSearch);
  equal(params.get("removeduplicate"), "1");
  equal(params.has("excludedomain"), false);
  equal(params.has("qInTitle"), false);
});

Deno.test("API Parameter Generation - tech", async () => {
  let capturedUrl: URL | null = null;
  const mockTransport = (async (url: string | URL | Request) => {
    capturedUrl = new URL(url instanceof Request ? url.url : url);
    return {
      ok: true,
      json: async () => ({ status: "success", results: [] }),
    } as Response;
  }) as typeof fetch;

  const api = createApi("test-key", config, mockTransport);
  await api(null, "tech");

  const params = capturedUrl!.searchParams;
  equal(params.get("apikey"), "test-key");
  equal(params.get("qInTitle"), config.techSearch);
  equal(params.get("removeduplicate"), "1");
  equal(params.has("excludedomain"), false);
  equal(params.has("q"), false);
});
