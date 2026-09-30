// Mozilla Readability 0.6.0; upstream Apache-2.0 license is kept beside the vendored source.
// @ts-ignore Upstream source uses CommonJS exports but runs under Deno's CommonJS interop.
import { Readability } from "./vendor/Readability.js";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.56";

export type ArticleDomParser = (content: string) => { body: any };

type ArticleBodyBaseResult =
  | {
    ok: true;
    body: string;
    chars: number;
    redirected: boolean;
    httpStatus?: number | null;
  }
  | {
    ok: false;
    reason:
      | "missing_url"
      | "fetch_failed"
      | "http_error"
      | "timeout"
      | "redirect_to_listing"
      | "dom_parse_failed"
      | "readability_failed"
      | "empty_body";
    readability: "not_run" | "failed" | "success";
    redirected: boolean;
    chars: number;
    httpStatus?: number | null;
  };

export type ArticleBodyResult = ArticleBodyBaseResult & {
  extractionMethod: "none" | "readability";
  durationMs: number;
  httpStatus: number | null;
  diagnostics?: ArticleBodyDiagnostics;
};

export type ArticleBodyDiagnostics = {
  domain: string | null;
  finalDomain: string | null;
  domParse: "not_run" | "success" | "failed";
  readabilityFailure: "exception" | "null_result" | null;
  exceptionType: string | null;
  retryCount: number;
};

function safeDomain(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function safeExceptionType(error: unknown): string {
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = String(value?.cause?.code ?? value?.code ?? "").toUpperCase();
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT") {
    return "timeout";
  }
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) {
    return "dns_resolution_failed";
  }
  if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
    return "connection_failed";
  }
  if (["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(code)) {
    return "connection_interrupted";
  }
  if (error instanceof TypeError) return "network_error";
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ? name : "unknown_exception";
}

function normalizedUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
    return url;
  } catch {
    return null;
  }
}

export function cleanArticleText(
  content: string,
  parseHtml: ArticleDomParser = (value) =>
    new DOMParser().parseFromString(value, "text/html"),
): string {
  const template = parseHtml(content).body;
  template.innerHTML = content;
  for (
    const link of Array.from(template.querySelectorAll("[rel~='sponsored']"))
  ) {
    let block: any = link;
    while (
      block.parentElement &&
      !/^(ARTICLE|SECTION|MAIN|BODY|#document-fragment)$/.test(
        block.parentElement.tagName || "#document-fragment",
      )
    ) {
      block = block.parentElement;
    }
    const text = (block.textContent ?? "").trim();
    const anchors: any[] = Array.from(block.querySelectorAll("a"));
    const nonLinkText = text.length -
      anchors.reduce(
        (sum, anchor) => sum + (anchor.textContent ?? "").trim().length,
        0,
      );
    if (block !== template && nonLinkText < 20 && anchors.length > 0) {
      block.remove();
    }
  }
  return (template.textContent ?? "").replace(/\s+/gu, " ").trim();
}
function isListingRedirect(original: string, final: string): boolean {
  const before = normalizedUrl(original);
  const after = normalizedUrl(final);
  if (
    !before || !after ||
    (before.origin === after.origin && before.pathname === after.pathname)
  ) return false;
  const path = after.pathname.toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const listingSegment =
    /^(?:category|categories|tag|tags|archive|archives|news|topics|search|page|list|author|authors|column|columns|section|sections|topics?)$/;
  const listingQuery = [...after.searchParams.keys()].some((key) =>
    /^(?:page|paged|category|cat|tag|s|q|search)$/i.test(key)
  );
  return path === "/" || listingQuery ||
    segments.some((segment) => listingSegment.test(segment));
}

async function extractArticleBodyInternal(
  articleUrl: string | null,
  fetcher: (
    input: string,
    init: RequestInit,
  ) => Promise<
    {
      ok: boolean;
      status?: number;
      url: string;
      text(): Promise<string>;
      body?: ReadableStream<Uint8Array> | null;
    }
  > = fetch,
  parserFactory: (
    html: string,
  ) => { parse: () => { textContent?: string; content?: string } | null } = (
    html,
  ) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    return new Readability(document, { debug: false });
  },
  parseHtml: ArticleDomParser = (html) =>
    new DOMParser().parseFromString(html, "text/html"),
  diagnostics: ArticleBodyDiagnostics = {
    domain: null,
    finalDomain: null,
    domParse: "not_run",
    readabilityFailure: null,
    exceptionType: null,
    retryCount: 0,
  },
): Promise<ArticleBodyBaseResult> {
  if (!articleUrl?.trim()) {
    return {
      ok: false,
      reason: "missing_url",
      readability: "not_run",
      redirected: false,
      chars: 0,
    };
  }
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = articleUrl?.trim() ? new URL(articleUrl) : null;
  } catch { /* invalid article URL */ }
  diagnostics.domain = parsedUrl?.hostname.toLowerCase() ?? null;
  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      reason: "missing_url",
      readability: "not_run",
      redirected: false,
      chars: 0,
    };
  }
  let html = "";
  let redirected = false;
  let httpStatus: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(articleUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      httpStatus = response.status ?? null;
      const finalUrl = response.url || articleUrl;
      diagnostics.finalDomain = safeDomain(finalUrl);
      redirected =
        normalizedUrl(articleUrl)?.href !== normalizedUrl(finalUrl)?.href;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (
          attempt === 0 &&
          ((response.status ?? 0) >= 500 || response.status === 429)
        ) {
          diagnostics.retryCount++;
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        return {
          ok: false,
          reason: "http_error",
          readability: "not_run",
          redirected,
          chars: 0,
          httpStatus: response.status ?? null,
        };
      }
      if (redirected && isListingRedirect(articleUrl, finalUrl)) {
        await response.body?.cancel().catch(() => {});
        return {
          ok: false,
          reason: "redirect_to_listing",
          readability: "not_run",
          redirected,
          chars: 0,
          httpStatus,
        };
      }
      // Headers and body share the same two-attempt budget and redirect checks.
      html = await response.text();
      break;
    } catch (error) {
      diagnostics.exceptionType = safeExceptionType(error);
      if (attempt === 0) {
        diagnostics.retryCount++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      const timeout = error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        ok: false,
        reason: timeout ? "timeout" : "fetch_failed",
        readability: "not_run",
        redirected,
        chars: 0,
      };
    }
  }
  let readability: {
    parse: () => { textContent?: string; content?: string } | null;
  };
  try {
    readability = parserFactory(html);
    diagnostics.domParse = "success";
  } catch (error) {
    diagnostics.domParse = "failed";
    diagnostics.exceptionType = safeExceptionType(error);
    return {
      ok: false,
      reason: "dom_parse_failed",
      readability: "not_run",
      redirected,
      chars: 0,
      httpStatus,
    };
  }
  let parsed: { textContent?: string; content?: string } | null;
  try {
    parsed = readability.parse();
  } catch (error) {
    diagnostics.readabilityFailure = "exception";
    diagnostics.exceptionType = safeExceptionType(error);
    return {
      ok: false,
      reason: "readability_failed",
      readability: "failed",
      redirected,
      chars: 0,
      httpStatus,
    };
  }
  if (!parsed) {
    diagnostics.readabilityFailure = "null_result";
    return {
      ok: false,
      reason: "readability_failed",
      readability: "failed",
      redirected,
      chars: 0,
      httpStatus,
    };
  }
  let body: string;
  try {
    body = parsed.content
      ? cleanArticleText(parsed.content, parseHtml)
      : (parsed.textContent ?? "").replace(/\s+/gu, " ").trim();
  } catch (error) {
    diagnostics.domParse = "failed";
    diagnostics.exceptionType = safeExceptionType(error);
    return {
      ok: false,
      reason: "dom_parse_failed",
      readability: "success",
      redirected,
      chars: 0,
      httpStatus,
    };
  }
  try {
    const chars = Array.from(body).length;
    if (chars === 0) {
      return {
        ok: false,
        reason: "empty_body",
        readability: "success",
        redirected,
        chars: 0,
        httpStatus,
      };
    }
    return { ok: true, body, chars, redirected, httpStatus };
  } catch (error) {
    diagnostics.exceptionType = safeExceptionType(error);
    return {
      ok: false,
      reason: "readability_failed",
      readability: "failed",
      redirected,
      chars: 0,
      httpStatus,
    };
  } finally {
    html = "";
  }
}

export async function extractArticleBody(
  articleUrl: string | null,
  fetcher: (
    input: string,
    init: RequestInit,
  ) => Promise<{
    ok: boolean;
    status?: number;
    url: string;
    text(): Promise<string>;
    body?: ReadableStream<Uint8Array> | null;
  }> = fetch,
  parserFactory: (
    html: string,
  ) => { parse: () => { textContent?: string; content?: string } | null } = (
    html,
  ) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    return new Readability(document, { debug: false });
  },
  parseHtml: ArticleDomParser = (html) =>
    new DOMParser().parseFromString(html, "text/html"),
): Promise<ArticleBodyResult> {
  const started = Date.now();
  const diagnostics: ArticleBodyDiagnostics = {
    domain: null,
    finalDomain: null,
    domParse: "not_run",
    readabilityFailure: null,
    exceptionType: null,
    retryCount: 0,
  };
  const result = await extractArticleBodyInternal(
    articleUrl,
    fetcher,
    parserFactory,
    parseHtml,
    diagnostics,
  );
  const readability = result.ok ? "success" : result.readability;
  return {
    ...result,
    extractionMethod: readability === "not_run" ? "none" : "readability",
    durationMs: Date.now() - started,
    httpStatus: result.httpStatus ?? (result.ok ? 200 : null),
    diagnostics,
  };
}
