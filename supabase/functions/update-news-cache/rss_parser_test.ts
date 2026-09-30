import { deepStrictEqual, equal } from "node:assert/strict";
import { parseRss } from "./rss_parser.ts";

const url = "https://example.com/rss/feed.xml";
const date = "2026-09-05T17:31:47+09:00";
const expected = {
  title: "Article & title",
  url: "https://example.com/article/1",
  time: "2026/09/05 17:31",
  published_at: "2026-09-05T08:31:47.000Z",
};

Deno.test("RSS 2.0 preserves fields, repeated items and date fallbacks", () => {
  const result = parseRss(
    `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
    <title>RSS source</title>
    <item><title>Article &amp; title</title><link>/article/1</link><pubDate>Sat, 05 Sep 2026 17:31:47 +0900</pubDate></item>
    <item><title>Second</title><link>/article/2</link><dc:date>${date}</dc:date></item>
    </channel></rss>`,
    url,
  );
  equal(result.detectedType, "rss");
  equal(result.sourceName, "RSS source");
  equal(result.items.length, 2);
  deepStrictEqual(result.items[0], expected);
  equal(result.items[1].published_at, expected.published_at);
});

Deno.test("RSS 2.0 single item and invalid date retain existing behavior", () => {
  const result = parseRss(
    `<rss><channel><item><title>One</title><link>/one</link><pubDate>invalid</pubDate></item></channel></rss>`,
    url,
  );
  equal(result.items.length, 1);
  equal(result.items[0].published_at, null);
  equal(result.items[0].time, null);
});

Deno.test("Atom preserves entry fields, first link and published/updated precedence", () => {
  const result = parseRss(
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom source</title>
    <entry><title>Article &amp; title</title><link href="/article/1"/><link href="/other"/>
    <published>${date}</published><updated>2026-09-06T00:00:00Z</updated></entry>
    <entry><title>Second</title><link href="/article/2"/><updated>${date}</updated></entry>
    </feed>`,
    url,
  );
  equal(result.detectedType, "atom");
  equal(result.sourceName, "Atom source");
  equal(result.items.length, 2);
  deepStrictEqual(result.items[0], expected);
  equal(result.items[1].published_at, expected.published_at);
});

Deno.test("Atom single entry retains existing behavior", () => {
  const result = parseRss(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <title>Article &amp; title</title><link href="/article/1"/><published>${date}</published>
    </entry></feed>`,
    url,
  );
  deepStrictEqual(result.items, [expected]);
});

const rdfFixture = (description: string) =>
  `<rdf:RDF
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/"><title>RDF source</title>
    <items><rdf:Seq><rdf:li rdf:resource="https://example.com/not-an-article"/></rdf:Seq></items>
  </channel>
  <item rdf:about="https://example.com/article/1"><title>Article &amp; title</title>
    <link>/article/1</link><dc:date>${date}</dc:date><description>${description}</description>
  </item>
</rdf:RDF>`;

Deno.test("4Gamer-style RDF reads direct item and escaped description", () => {
  const result = parseRss(rdfFixture("Summary &amp; details"), url);
  equal(result.detectedType, "rdf");
  equal(result.sourceName, "RDF source");
  deepStrictEqual(result.items, [{
    ...expected,
    description: "Summary & details",
  }]);
});

Deno.test("GAME Watch-style RDF preserves CDATA description", () => {
  const result = parseRss(
    rdfFixture("<![CDATA[<p>Summary & details</p>]]>"),
    url,
  );
  deepStrictEqual(result.items, [{
    ...expected,
    description: "<p>Summary & details</p>",
  }]);
});

Deno.test("RDF resolves alternate prefixes and local namespace declarations", () => {
  const xml = rdfFixture("Summary")
    .replaceAll("rdf:", "r:").replace("xmlns:rdf=", "xmlns:r=")
    .replace(' xmlns:dc="http://purl.org/dc/elements/1.1/"', "")
    .replaceAll("dc:date", "d:date")
    .replace("<d:date>", '<d:date xmlns:d="http://purl.org/dc/elements/1.1/">')
    .replace(
      'xmlns="http://purl.org/rss/1.0/"',
      'xmlns:s="http://purl.org/rss/1.0/"',
    )
    .replace(
      /<(\/?)(channel|title|items|item|link|description)(?=[\s>])/g,
      "<$1s:$2",
    );
  deepStrictEqual(parseRss(xml, url).items, [{
    ...expected,
    description: "Summary",
  }]);
});

Deno.test("RDF repeated items, missing fields, invalid date and foreign namespace", () => {
  const xml = rdfFixture("Summary").replace(
    "</rdf:RDF>",
    `
    <item><title>Second</title><link>/second</link><dc:date>invalid</dc:date></item>
    <item><title>Missing link</title></item>
    <item><link>/missing-title</link></item>
    <x:item xmlns:x="urn:other"><title>Foreign</title><link>/foreign</link></x:item>
    </rdf:RDF>`,
  );
  const result = parseRss(xml, url);
  equal(result.items.length, 2);
  deepStrictEqual(result.items[1], {
    title: "Second",
    url: "https://example.com/second",
    time: null,
    published_at: null,
    description: "",
  });
});

Deno.test("Unknown XML remains unknown", () => {
  deepStrictEqual(parseRss("<document/>", url), {
    sourceName: null,
    items: [],
    detectedType: "unknown",
  });
});
