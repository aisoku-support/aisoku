import type { Config } from "./config.ts";
import type { RequestMode } from "./scheduler.ts";
export class FetchError extends Error {
  constructor(
    public type: string,
    public status: number | null = null,
    public code: string | null = null,
    public networkCause: string | null = null,
    public networkCauseName: string | null = null,
    public networkCategory: string | null = null,
    public endpointHost: string | null = null,
    public timeoutMs: number | null = null,
  ) {
    super(`NewsData ${type}`); // 外部レスポンス/URL/Secretをメッセージへ取り込まない。
  }
}
const safeNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_PROTOCOL_ERROR",
]);
function networkDetails(error: unknown) {
  let current: unknown = error;
  let name: string | null = null;
  let code: string | null = null;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (typeof current !== "object") break;
    const item = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (!name && typeof item.name === "string") {
      name = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(item.name)
        ? item.name
        : "Error";
    }
    if (typeof item.code === "string" && safeNetworkCodes.has(item.code)) {
      code = item.code;
    }
    current = item.cause;
  }
  const category = code === "ENOTFOUND" || code === "EAI_AGAIN"
    ? "dns"
    : code === "ECONNRESET"
    ? "reset"
    : code?.includes("TLS") || code?.startsWith("CERT_") ||
        code?.startsWith("ERR_SSL_")
    ? "tls"
    : code === "ETIMEDOUT"
    ? "timeout"
    : code === "ECONNREFUSED"
    ? "refused"
    : code
    ? "network"
    : null;
  return { code, name, category };
}
export type RawArticle = Record<string, unknown>;
export type Page = {
  items: RawArticle[];
  nextPage: string | null;
  status: number;
  quota_exhausted: boolean;
};
export type FetchPage = (
  page: string | null,
  requestMode: RequestMode,
) => Promise<Page>;
function errorType(code: string, status: number): string {
  if (/rate/i.test(code)) return "rate_limit";
  if (/quota|credit|limitexceeded/i.test(code)) return "quota";
  if (status === 429) return "rate_limit";
  return status >= 400 ? "http" : "api";
}
export function createApi(
  apiKey: string,
  cfg: Config,
  transport: typeof fetch = fetch,
): FetchPage {
  return async (page, requestMode) => {
    const url = new URL(cfg.endpoint);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("language", cfg.language);
    url.searchParams.set("size", String(cfg.pageSize));
    url.searchParams.set("removeduplicate", "1");

    if (requestMode === "subculture") {
      url.searchParams.set("q", cfg.subcultureSearch);
    } else if (requestMode === "tech") {
      url.searchParams.set("qInTitle", cfg.techSearch);
    } else {
      // normal mode: exclude PR TIMES
      url.searchParams.set("excludedomain", cfg.excludedDomains);
    }

    if (page) url.searchParams.set("page", page);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    const endpointHost = url.hostname;
    try {
      const response = await transport(url, { signal: controller.signal });
      let body;
      try {
        body = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new FetchError(
            "timeout",
            response.status,
            null,
            null,
            "AbortError",
            "timeout",
            endpointHost,
            cfg.requestTimeoutMs,
          );
        }
        throw new FetchError(
          response.ok ? "json" : errorType("", response.status),
          response.status,
        );
      }
      if (!response.ok || body?.status === "error") {
        const rawCode = body?.results?.code;
        const code = typeof rawCode === "string" &&
            /^[a-zA-Z0-9_-]{1,80}$/.test(rawCode) && !rawCode.includes(apiKey)
          ? rawCode
          : null;
        const type = errorType(code ?? "", response.status);
        throw new FetchError(type, response.status, code);
      }
      if (
        body?.status !== "success" || !Array.isArray(body.results) ||
        body.results.some((r: unknown) =>
          !r || typeof r !== "object" || Array.isArray(r)
        ) ||
        (body.nextPage != null && typeof body.nextPage !== "string")
      ) throw new FetchError("response_format", response.status);
      return {
        items: body.results,
        nextPage: body.nextPage || null,
        status: response.status,
        quota_exhausted: false,
      };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      const details = networkDetails(error);
      throw new FetchError(
        controller.signal.aborted ? "timeout" : "connection",
        null,
        null,
        details.code,
        details.name,
        controller.signal.aborted ? "timeout" : details.category,
        endpointHost,
        cfg.requestTimeoutMs,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
