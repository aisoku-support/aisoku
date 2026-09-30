import { withSupabase } from "jsr:@supabase/server@1.7.0";
import {
  createDiscoverer,
  type DiscoveryDiagnostics,
  type FeedCandidate,
  getHttpErrorInfo,
  getReasonCode,
} from "./discover.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DiscoveryResult = {
  candidates: FeedCandidate[];
  diagnostics: DiscoveryDiagnostics;
};
type Dependencies = {
  env?: { url: string; publishableKeys: Record<string, string> };
  discover?: (url: string) => Promise<DiscoveryResult>;
};

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: corsHeaders });

export function createDiscoverRssFeedHandler(
  dependencies: Dependencies = {},
) {
  const config = {
    auth: "publishable" as const,
    cors: "disabled" as const,
    ...(dependencies.env ? { env: dependencies.env } : {}),
  };
  const discover = dependencies.discover ?? createDiscoverer({
    fetch,
    resolveDns: async (host, type) => await Deno.resolveDns(host, type),
  });

  const authenticatedHandler = withSupabase(
    config,
    async (request: Request) => {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }
      try {
        const body = await request.json();
        if (typeof body?.url !== "string") {
          return json({
            error: "URL is required",
            reason_code: "invalid_request",
          }, 400);
        }
        const { candidates, diagnostics } = await discover(body.url);
        return json({ candidates, diagnostics });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        const reasonCode = getReasonCode(message);
        console.error("RSS discovery failed", {
          reason_code: reasonCode,
          error_type: error instanceof Error ? error.name : "unknown",
        });
        const responseData: Record<string, unknown> = {
          error: "RSS discovery failed",
          reason_code: reasonCode,
        };
        if (reasonCode === "http_error") {
          const { http_status, http_stage } = getHttpErrorInfo(message);
          if (http_status) responseData.http_status = http_status;
          if (http_stage) responseData.http_stage = http_stage;
        }
        return json(responseData, 400);
      }
    },
  );

  return (request: Request) =>
    request.method === "OPTIONS"
      ? Promise.resolve(new Response("ok", { headers: corsHeaders }))
      : authenticatedHandler(request);
}
