import { parseRss } from "../update-news-cache/rss_parser.ts";

export type FeedCandidate = { url: string; title: string };
export type DiscoveryDiagnostics = {
  article_result: string;
  homepage_result: string;
  homepage_alternate_count: number;
  common_paths_tried: number;
  common_paths_http_success: number;
  feed_candidates_found: number;
  feed_candidates_valid: number;
  final_candidates: number;
};
export type DiscoveryResult = {
  candidates: FeedCandidate[];
  diagnostics: DiscoveryDiagnostics;
};
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ResolveDns = (host: string, type: "A" | "AAAA") => Promise<string[]>;
type FeedOrGuideResponse = {
  text?: string;
  alternateUrls?: string[];
  isHtml?: boolean;
};

export type DiscoverDependencies = {
  fetch: FetchLike;
  resolveDns: ResolveDns;
  now?: () => number;
  requestTimeoutMs?: number;
  discoveryTimeoutMs?: number;
};

const PER_REQUEST_TIMEOUT_MS = 3500;
const WHOLE_DISCOVERY_TIMEOUT_MS = 9000;
const MAX_REDIRECTS = 4;
const MAX_FEED_RESPONSE_BYTES = 512 * 1024;
const HTML_WORK_BUFFER_BYTES = 512 * 1024;
const HTML_OVERLAP_CHARS = 16 * 1024;
const MAX_HTML_READ_BYTES = 4 * 1024 * 1024;
const MAX_FEED_CANDIDATES = 12;
const COMMON_PATHS = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml"];

export function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    if (url.port && url.port !== "80" && url.port !== "443") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (!url.hostname) return null;
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) url.port = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isBlockedIp(ip: string): boolean {
  const value = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (value.includes(".")) return isBlockedIpv4(value);
  const words = parseIpv6(value);
  if (!words) return true;
  // Only globally routable unicast (2000::/3) is accepted. Documentation
  // prefix 2001:db8::/32 is explicitly excluded.
  const globalUnicast = words[0] >= 0x2000 && words[0] <= 0x3fff;
  const documentation = words[0] === 0x2001 && words[1] === 0x0db8;
  return !globalUnicast || documentation;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return true;
  }
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte > 255)) return true;
  const [a, b, c] = bytes;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function parseIpv6(ip: string): number[] | null {
  if (!ip || ip.includes("%") || ip.split("::").length > 2) return null;
  const sides = ip.split("::");
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const result: number[] = [];
    for (const part of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      result.push(Number.parseInt(part, 16));
    }
    return result;
  };
  const left = parseSide(sides[0]);
  const right = parseSide(sides[1] ?? "");
  if (!left || !right) return null;
  if (sides.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing > 0 ? [...left, ...Array(missing).fill(0), ...right] : null;
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

async function assertSafeUrl(
  urlText: string,
  dependencies: DiscoverDependencies,
  deadline: number,
): Promise<URL> {
  const normalized = normalizeUrl(urlText);
  if (!normalized) {
    throw new Error("unsupported URL");
  }
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" || host.endsWith(".localhost") || isIpLiteral(host)
  ) {
    throw new Error("blocked host");
  }

  const aRecordsPromise = dependencies.resolveDns(host, "A").catch(() => []);
  const aaaaRecordsPromise = dependencies.resolveDns(host, "AAAA").catch(
    () => [],
  );

  const [aRecords, aaaaRecords] = await withDeadline(
    Promise.all([aRecordsPromise, aaaaRecordsPromise]),
    deadline,
    dependencies.now,
  );

  const allRecords = [...aRecords, ...aaaaRecords];
  if (allRecords.length === 0 || allRecords.some(isBlockedIp)) {
    throw new Error("blocked DNS result");
  }

  return url;
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  now: (() => number) | undefined,
): Promise<T> {
  const remaining = deadline - (now?.() ?? Date.now());
  if (remaining <= 0) throw new Error("discovery timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("discovery timeout")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function readTextLimited(
  response: Response,
  deadline: number,
  now: (() => number) | undefined,
): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_FEED_RESPONSE_BYTES) throw new Error("response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await withDeadline(reader.read(), deadline, now);
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_FEED_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

export function alternateLinks(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ??
      "";
    const type =
      /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ??
      /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (
      !href || !rel.split(/\s+/).includes("alternate") ||
      !/(rss|atom|rdf|xml)/.test(type)
    ) continue;
    try {
      urls.push(new URL(href, baseUrl).toString());
    } catch { /* ignore invalid href */ }
  }
  return urls;
}

function guideAnchorLinks(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = match[1];
    const innerHtml = match[2];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ??
      /\bhref\s*=\s*([^\s>]+)/i.exec(attributes)?.[1];
    if (!href) continue;

    const text = innerHtml.replace(/<[^>]*>/g, " ");
    const hasRssKeywordInText = /(rss|feed|フィード)/i.test(text);
    const hasRssKeywordInHref = /(rss|feed|rdf)/i.test(href);

    // Check for img alt or title inside the anchor
    let hasRssKeywordInImg = false;
    for (const imgMatch of innerHtml.matchAll(/<img\b([^>]*)>/gi)) {
      const imgAttrs = imgMatch[1];
      if (
        /(alt|title)\s*=\s*(?:["'][^"']*(rss|feed|フィード)[^"']*["']|'[^']*?(rss|feed|フィード)[^']*?')/i
          .test(imgAttrs)
      ) {
        hasRssKeywordInImg = true;
        break;
      }
    }

    if (!hasRssKeywordInHref && !hasRssKeywordInText && !hasRssKeywordInImg) {
      continue;
    }

    try {
      urls.push(new URL(href, baseUrl).toString());
    } catch { /* ignore invalid href */ }
  }
  return urls;
}

async function readHtmlAnyLinks(
  response: Response,
  baseUrl: string,
  deadline: number,
  now: (() => number) | undefined,
): Promise<string[]> {
  if (!response.body) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const urls: string[] = [];
  let overlap = "";
  let total = 0;
  let fullyRead = false;
  try {
    while (true) {
      const next = await withDeadline(reader.read(), deadline, now);
      if (next.done) {
        fullyRead = true;
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_HTML_READ_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      const text = decoder.decode(next.value, { stream: true });
      const window = overlap + text;
      urls.push(...alternateLinks(window, baseUrl));
      urls.push(...guideAnchorLinks(window, baseUrl));
      overlap = window.slice(-HTML_OVERLAP_CHARS);
    }
  } finally {
    if (!fullyRead) void reader.cancel();
  }
  return urls;
}

async function readFeedOrGuide(
  response: Response,
  baseUrl: string,
  deadline: number,
  now: (() => number) | undefined,
): Promise<FeedOrGuideResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml")
  ) {
    return {
      alternateUrls: await readHtmlAnyLinks(response, baseUrl, deadline, now),
      isHtml: true,
    };
  }
  const text = await readTextLimited(response, deadline, now);
  if (/^\s*<(?:!doctype\s+html|html|head|body|link|a)\b/i.test(text)) {
    const alternates = alternateLinks(text, baseUrl);
    const anchors = guideAnchorLinks(text, baseUrl);
    return {
      alternateUrls: [...alternates, ...anchors],
      isHtml: true,
    };
  }
  return { text, isHtml: false };
}

async function fetchSafe<T>(
  startUrl: string,
  dependencies: DiscoverDependencies,
  deadline: number,
  stage: string,
  readResponse: (response: Response, url: string) => Promise<T>,
): Promise<{ url: string; value: T }> {
  let current = startUrl;
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if ((dependencies.now?.() ?? Date.now()) >= deadline) {
      throw new Error("discovery timeout");
    }
    const url = await assertSafeUrl(current, dependencies, deadline);
    if (!visited.add(url.toString())) {
      throw new Error("redirect loop");
    }
    const controller = new AbortController();
    const remaining = deadline - (dependencies.now?.() ?? Date.now());
    if (remaining <= 0) {
      throw new Error("discovery timeout");
    }
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(
        dependencies.requestTimeoutMs ?? PER_REQUEST_TIMEOUT_MS,
        remaining,
      ),
    );
    try {
      const response = await withDeadline(
        dependencies.fetch(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": "news-app-rss-discovery/1.0",
            "Accept":
              "text/html, application/rss+xml, application/atom+xml, application/xml, text/xml",
          },
        }),
        deadline,
        dependencies.now,
      );

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("invalid redirect");
        }
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} stage:${stage}`);
      }
      const value = await readResponse(response, url.toString());
      return { url: url.toString(), value };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error("fetch timeout");
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("too many redirects");
}

export function getReasonCode(message: string): string {
  if (message.includes("unsupported URL") || message.includes("blocked host")) {
    return "url_rejected";
  }
  if (message.includes("blocked DNS result")) return "dns_rejected";
  if (message.includes("discovery timeout")) return "discovery_deadline";
  if (message.includes("response too large")) return "response_too_large";
  if (message.includes("fetch timeout")) return "fetch_timeout";
  if (message.includes("redirect loop")) return "redirect_loop";
  if (message.includes("invalid redirect")) return "redirect_rejected";
  if (message.includes("too many redirects")) return "too_many_redirects";
  if (message.includes("HTTP ")) return "http_error";
  return "fetch_failed";
}

export function getHttpErrorInfo(message: string): {
  http_status?: number;
  http_stage?: string;
} {
  const statusMatch = /HTTP (\d+)/.exec(message);
  const stageMatch = /stage:(\w+)/.exec(message);
  return {
    http_status: statusMatch ? parseInt(statusMatch[1], 10) : undefined,
    http_stage: stageMatch ? stageMatch[1] : undefined,
  };
}

function isArticleHttpFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { http_status, http_stage } = getHttpErrorInfo(error.message);
  return http_stage === "article" && http_status != null &&
    http_status >= 400 && http_status <= 599;
}

export function createDiscoverer(dependencies: DiscoverDependencies) {
  return async (articleUrl: string): Promise<DiscoveryResult> => {
    const diagnostics: DiscoveryDiagnostics = {
      article_result: "none",
      homepage_result: "none",
      homepage_alternate_count: 0,
      common_paths_tried: 0,
      common_paths_http_success: 0,
      feed_candidates_found: 0,
      feed_candidates_valid: 0,
      final_candidates: 0,
    };
    const deadline = (dependencies.now?.() ?? Date.now()) +
      (dependencies.discoveryTimeoutMs ?? WHOLE_DISCOVERY_TIMEOUT_MS);
    const found = new Set<string>();
    const candidates: {
      url: string;
      stage: string;
      canExploreGuide: boolean;
    }[] = [];
    const add = (
      urls: string[],
      stage: string,
      canExploreGuide = true,
    ) =>
      urls.forEach((value) => {
        const normalized = normalizeUrl(value);
        if (
          normalized && !found.has(normalized) &&
          candidates.length < MAX_FEED_CANDIDATES
        ) {
          found.add(normalized);
          candidates.push({ url: normalized, stage, canExploreGuide });
        }
      });

    let siteUrl = new URL("/", articleUrl).toString();
    let articleFinalUrl = articleUrl;
    try {
      const article = await fetchSafe(
        articleUrl,
        dependencies,
        deadline,
        "article",
        (response, url) =>
          readHtmlAnyLinks(response, url, deadline, dependencies.now),
      );
      add(article.value, "feed_candidate");
      siteUrl = new URL("/", article.url).toString();
      articleFinalUrl = article.url;
      diagnostics.article_result = "success";
    } catch (error) {
      const info = getHttpErrorInfo(
        error instanceof Error ? error.message : "",
      );
      if (info.http_status) {
        diagnostics.article_result = `http_${info.http_status}`;
      } else {
        diagnostics.article_result = getReasonCode(
          error instanceof Error ? error.message : "",
        );
      }
      if (!isArticleHttpFallbackError(error)) {
        throw error;
      }
    }

    if (siteUrl !== articleFinalUrl) {
      try {
        const site = await fetchSafe(
          siteUrl,
          dependencies,
          deadline,
          "homepage",
          (response, url) =>
            readHtmlAnyLinks(response, url, deadline, dependencies.now),
        );
        add(site.value, "feed_candidate");
        diagnostics.homepage_result = "success";
        diagnostics.homepage_alternate_count = site.value.length;
      } catch (error) {
        const info = getHttpErrorInfo(
          error instanceof Error ? error.message : "",
        );
        if (info.http_status) {
          diagnostics.homepage_result = `http_${info.http_status}`;
        } else {
          diagnostics.homepage_result = "error";
        }
      }
    } else {
      diagnostics.homepage_result = "skipped";
    }

    if (candidates.length === 0) {
      diagnostics.common_paths_tried = COMMON_PATHS.length;
      add(
        COMMON_PATHS.map((path) => new URL(path, siteUrl).toString()),
        "common_path",
      );
    }

    const result: FeedCandidate[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if ((dependencies.now?.() ?? Date.now()) >= deadline) {
        break;
      }
      try {
        const feed = await fetchSafe(
          candidate.url,
          dependencies,
          deadline,
          candidate.stage,
          (response, url) =>
            readFeedOrGuide(response, url, deadline, dependencies.now),
        );
        if (candidate.stage === "common_path") {
          diagnostics.common_paths_http_success++;
        }

        if (feed.value.isHtml) {
          if (candidate.canExploreGuide) {
            add(
              feed.value.alternateUrls ?? [],
              "feed_candidate",
              false,
            );
          }
          continue;
        }

        const parsed = parseRss(feed.value.text ?? "", feed.url);
        if (parsed.detectedType !== "unknown") {
          diagnostics.feed_candidates_valid++;
          result.push({
            url: normalizeUrl(feed.url)!,
            title: parsed.sourceName ?? "",
          });
        }
      } catch {
        /* each invalid candidate is ignored */
      }
    }

    const finalResult = result.filter((candidate, index, all) =>
      all.findIndex((value) => value.url === candidate.url) === index
    );
    diagnostics.feed_candidates_found = candidates.length;
    diagnostics.final_candidates = finalResult.length;
    return { candidates: finalResult, diagnostics };
  };
}
