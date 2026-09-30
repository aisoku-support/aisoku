import { withSupabase } from "jsr:@supabase/server@1.7.0";

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
  now?: () => Date;
};

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: corsHeaders });

function normalizedHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname || parsed.username || parsed.password
    ) return null;
    return value.trim();
  } catch {
    return null;
  }
}

export function createEnsureRssFeedHandler(
  dependencies: Dependencies = {},
) {
  const config = {
    auth: "publishable" as const,
    cors: "disabled" as const,
    ...(dependencies.env ? { env: dependencies.env } : {}),
  };
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? (() => new Date());

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
      const input = body as Record<string, unknown>;
      const url = normalizedHttpUrl(input.url);
      if (
        !url ||
        (input.source_name != null && typeof input.source_name !== "string") ||
        (input.mark_active !== undefined &&
          typeof input.mark_active !== "boolean")
      ) {
        return json({ error: "invalid_request" }, 400);
      }

      const redisUrl = dependencies.upstash?.url ??
        Deno.env.get("UPSTASH_REDIS_REST_URL");
      const redisToken = dependencies.upstash?.token ??
        Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
      if (!redisUrl || !redisToken) {
        console.error("[EnsureRss] configuration missing");
        return json({ error: "rss_registration_failed" }, 500);
      }

      try {
        const sourceName =
          typeof input.source_name === "string" && input.source_name.trim()
            ? input.source_name.trim()
            : null;
        const timestamp = now();
        const updatedAt = timestamp.toISOString();
        const nowUnix = Math.floor(timestamp.getTime() / 1000);
        const metaKey = `rss:meta:${url}`;
        const getResponse = await fetcher(redisUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${redisToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(["GET", metaKey]),
        });

        let existingMeta: Record<string, unknown> = {};
        if (getResponse.ok) {
          const data = await getResponse.json() as { result?: unknown };
          if (typeof data.result === "string") {
            try {
              const parsed: unknown = JSON.parse(data.result);
              if (
                parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ) {
                existingMeta = parsed as Record<string, unknown>;
              }
            } catch {
              // Invalid metadata is replaced with a clean record.
            }
          }
        }

        const updatedMeta = {
          ...existingMeta,
          url,
          source_name: sourceName || existingMeta.source_name || null,
          created_at: existingMeta.created_at || updatedAt,
          updated_at: updatedAt,
        };
        const pipelineUrl = redisUrl.endsWith("/")
          ? `${redisUrl}pipeline`
          : `${redisUrl}/pipeline`;
        const commands: unknown[][] = [
          ["SADD", "rss:urls", url],
          ["SET", metaKey, JSON.stringify(updatedMeta)],
        ];
        if (input.mark_active !== false) {
          commands.push(["ZADD", "rss:active", nowUnix, url]);
        }
        const response = await fetcher(pipelineUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${redisToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(commands),
        });
        if (!response.ok) {
          console.error("[EnsureRss] Upstash pipeline failed", {
            status: response.status,
          });
          return json({ error: "rss_registration_failed" }, 500);
        }
        return json({ success: true });
      } catch (error) {
        console.error("[EnsureRss] request failed", {
          type: error instanceof Error ? error.name : "unknown",
        });
        return json({ error: "rss_registration_failed" }, 500);
      }
    },
  );

  return (request: Request) =>
    request.method === "OPTIONS"
      ? Promise.resolve(new Response("ok", { headers: corsHeaders }))
      : authenticatedHandler(request);
}
