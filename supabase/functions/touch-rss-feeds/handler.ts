import { withSupabase } from "jsr:@supabase/server@1.7.0";

const MAX_FEEDS_PER_TOUCH = 100;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Dependencies = {
  env?: { url: string; publishableKeys: Record<string, string> };
  upstash?: { url: string; token: string };
  fetcher?: typeof fetch;
  now?: () => number;
};

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: corsHeaders });

export function createTouchRssFeedsHandler(dependencies: Dependencies = {}) {
  const config = {
    auth: "publishable" as const,
    cors: "disabled" as const,
    ...(dependencies.env ? { env: dependencies.env } : {}),
  };
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  const authenticatedHandler = withSupabase(
    config,
    async (request: Request) => {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "invalid_request" }, 400);
      }
      const urls = (body as Record<string, unknown>).urls;
      if (!Array.isArray(urls)) {
        return json(
          { error: "URLs are required" },
          400,
        );
      }

      const normalizedUrls = [...new Set(urls.map((url) => String(url).trim()))]
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
          } catch {
            return false;
          }
        });
      if (normalizedUrls.length > MAX_FEEDS_PER_TOUCH) {
        return json({ error: "Too many URLs" }, 400);
      }
      if (normalizedUrls.length === 0) {
        return json({ success: true, touched: 0 });
      }

      const redisUrl = dependencies.upstash?.url ??
        Deno.env.get("UPSTASH_REDIS_REST_URL");
      const redisToken = dependencies.upstash?.token ??
        Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
      if (!redisUrl || !redisToken) {
        console.error("[TouchRss] configuration missing");
        return json({ error: "rss_touch_failed" }, 500);
      }

      try {
        const pipelineUrl = redisUrl.endsWith("/")
          ? `${redisUrl}pipeline`
          : `${redisUrl}/pipeline`;
        const membershipResponse = await fetcher(pipelineUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${redisToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            normalizedUrls.map((url) => ["SISMEMBER", "rss:urls", url]),
          ),
        });
        if (!membershipResponse.ok) {
          throw new Error("Failed to validate RSS registrations");
        }
        const membershipResults = await membershipResponse.json();
        if (!Array.isArray(membershipResults)) {
          throw new Error("Invalid RSS registration response");
        }

        const registeredUrls = normalizedUrls.filter(
          (_, index) => Number(membershipResults[index]?.result) === 1,
        );
        if (registeredUrls.length > 0) {
          const zaddCommand: (string | number)[] = ["ZADD", "rss:active"];
          for (const url of registeredUrls) zaddCommand.push(now(), url);
          const touchResponse = await fetcher(redisUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${redisToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(zaddCommand),
          });
          if (!touchResponse.ok) throw new Error("Failed to touch RSS feeds");
          const touchResult = await touchResponse.json() as { error?: unknown };
          if (touchResult.error) throw new Error("RSS touch command failed");
        }

        return json({
          success: true,
          touched: registeredUrls.length,
          ignored: normalizedUrls.length - registeredUrls.length,
        });
      } catch (error) {
        console.error("[TouchRss] request failed", {
          type: error instanceof Error ? error.name : "unknown",
        });
        return json({ error: "rss_touch_failed" }, 500);
      }
    },
  );

  return (request: Request) =>
    request.method === "OPTIONS"
      ? Promise.resolve(new Response("ok", { headers: corsHeaders }))
      : authenticatedHandler(request);
}
