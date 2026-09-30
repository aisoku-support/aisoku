import { XMLParser } from "npm:fast-xml-parser";

export type NewsItem = {
  title: string;
  url: string;
  time: string | null;
  published_at: string | null;
  description?: string;
  feed_url?: string;
  source_name?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("#text" in object) return String(object["#text"] ?? "").trim();
    if ("text" in object) return String(object.text ?? "").trim();
  }
  return String(value).trim();
}

function extractUrl(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object["@_href"]) return String(object["@_href"]).trim();
    if (object.href) return String(object.href).trim();
    if (object["#text"]) return String(object["#text"]).trim();
  }
  return "";
}

function parsePublishedDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatTime(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function resolveUrl(articleUrl: string, feedUrl: string): string {
  if (!articleUrl) return "";
  try {
    return new URL(articleUrl, feedUrl).toString();
  } catch {
    return articleUrl;
  }
}

// Resolve RDF names by URI, including inherited and local namespace declarations.
type XmlNode = Record<string, unknown>;
type Namespaces = Record<string, string>;
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RSS_NS = "http://purl.org/rss/1.0/";
const DC_NS = "http://purl.org/dc/elements/1.1/";

function namespaces(node: unknown, inherited: Namespaces): Namespaces {
  const result = { ...inherited };
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "@_xmlns") result[""] = String(value);
      else if (key.startsWith("@_xmlns:")) result[key.slice(8)] = String(value);
    }
  }
  return result;
}

function children(
  node: XmlNode,
  localName: string,
  uri: string,
  inherited: Namespaces,
): { value: unknown; scope: Namespaces }[] {
  const result: { value: unknown; scope: Namespaces }[] = [];
  for (const [name, values] of Object.entries(node)) {
    if (name.startsWith("@_") || name.startsWith("#")) continue;
    const parts = name.split(":");
    if (parts[parts.length - 1] !== localName) continue;
    for (const value of asArray(values)) {
      const scope = namespaces(value, inherited);
      if (scope[parts.length > 1 ? parts[0] : ""] === uri) {
        result.push({ value, scope });
      }
    }
  }
  return result;
}

function rdfField(
  node: XmlNode,
  name: string,
  uri: string,
  scope: Namespaces,
): unknown {
  return children(node, name, uri, scope)[0]?.value;
}

export function parseRss(
  xml: string,
  feedUrl: string,
): {
  sourceName: string | null;
  items: NewsItem[];
  detectedType: "rss" | "atom" | "rdf" | "unknown";
} {
  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;

  if (channel) {
    const sourceName = cleanText(channel.title) || null;
    const rawItems = asArray(channel.item);
    const items: NewsItem[] = [];

    for (const item of rawItems) {
      const title = cleanText(item?.title);
      const articleUrl = resolveUrl(extractUrl(item?.link), feedUrl);
      const publishedAt = parsePublishedDate(
        item?.pubDate ?? item?.published ?? item?.updated ?? item?.["dc:date"],
      );
      if (!title || !articleUrl) continue;
      items.push({
        title,
        url: articleUrl,
        time: formatTime(publishedAt),
        published_at: publishedAt,
      });
    }
    return { sourceName, items, detectedType: "rss" };
  }

  const feed = parsed?.feed;
  if (feed) {
    const sourceName = cleanText(feed.title) || null;
    const rawEntries = asArray(feed.entry);
    const items: NewsItem[] = [];

    for (const entry of rawEntries) {
      const title = cleanText(entry?.title);
      const links = asArray(entry?.link);
      let articleUrl = "";
      for (const link of links) {
        const candidate = extractUrl(link);
        if (candidate) {
          articleUrl = candidate;
          break;
        }
      }
      articleUrl = resolveUrl(articleUrl, feedUrl);
      const publishedAt = parsePublishedDate(
        entry?.published ?? entry?.updated,
      );
      if (!title || !articleUrl) continue;
      items.push({
        title,
        url: articleUrl,
        time: formatTime(publishedAt),
        published_at: publishedAt,
      });
    }
    return { sourceName, items, detectedType: "atom" };
  }

  const rdf = children(parsed, "RDF", RDF_NS, {})[0];
  if (rdf) {
    const root = rdf.value as XmlNode;
    const channel = children(root, "channel", RSS_NS, rdf.scope)[0];
    const sourceName = channel
      ? cleanText(
        rdfField(channel.value as XmlNode, "title", RSS_NS, channel.scope),
      ) || null
      : null;
    const items: NewsItem[] = [];
    // Article bodies are direct children, not channel/items/rdf:Seq/rdf:li.
    for (const child of children(root, "item", RSS_NS, rdf.scope)) {
      const item = child.value as XmlNode;
      const title = cleanText(rdfField(item, "title", RSS_NS, child.scope));
      const articleUrl = resolveUrl(
        extractUrl(rdfField(item, "link", RSS_NS, child.scope)),
        feedUrl,
      );
      const publishedAt = parsePublishedDate(
        rdfField(item, "date", DC_NS, child.scope),
      );
      if (!title || !articleUrl) continue;
      items.push({
        title,
        url: articleUrl,
        time: formatTime(publishedAt),
        published_at: publishedAt,
        description: cleanText(
          rdfField(item, "description", RSS_NS, child.scope),
        ),
      });
    }
    return { sourceName, items, detectedType: "rdf" };
  }

  return { sourceName: null, items: [], detectedType: "unknown" };
}
