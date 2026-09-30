
const REDIS_URL = Deno.env.get("UPSTASH_REDIS_REST_URL");
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Missing Redis environment variables.");
  Deno.exit(1);
}

const PIPELINE_URL = REDIS_URL.endsWith("/") ? REDIS_URL + "pipeline" : REDIS_URL + "/pipeline";

// 1. Identify subculture requests
const logContent = await Deno.readTextFile("newsdata_24h_20260910_1725.json");
const logData = JSON.parse(logContent);

const subcultureRequests: any[] = [];
for (const job of logData.jobs || []) {
  for (const req of job.requests || []) {
    if (req.request_mode === "subculture" && req.status === "success") {
      subcultureRequests.push({
        request_time_jst: new Date(new Date(req.started_at).getTime() + 9 * 3600000).toISOString().replace("T", " ").split(".")[0],
        started_at_ms: new Date(req.started_at).getTime(),
        new_items: req.new_items,
        already_known_items: req.already_known_items
      });
    }
  }
}

const logStartMs = new Date("2026-09-09T08:25:43.720Z").getTime();
const logEndMs = new Date("2026-09-10T08:25:43.720Z").getTime();

const articleIds = await fetch(REDIS_URL, {
  method: "POST",
  headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(["ZRANGE", "newsdata:articles", (logStartMs - 600000).toString(), (logEndMs + 600000).toString(), "BYSCORE"])
}).then(r => r.json()).then(b => b.result);

const uniqueArticles: Map<string, any> = new Map();
const batchSize = 100;
for (let i = 0; i < articleIds.length; i += batchSize) {
  const batch = articleIds.slice(i, i + batchSize);
  const pipeline = batch.map((id: string) => ["GET", `newsdata:article:${id}`]);
  const results = await fetch(PIPELINE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(pipeline),
  }).then(r => r.json());

  for (const res of results) {
    if (res.result) {
      const art = JSON.parse(res.result);
      const artFetchedMs = new Date(art.fetched_at).getTime();

      // Match to ANY subculture request window
      const matchedReq = subcultureRequests.find(req => {
        return Math.abs(artFetchedMs - req.started_at_ms) < 300000;
      });

      if (matchedReq) {
          // If multiple articles have the same ID (unlikely in Redis), keep the first one
          if (!uniqueArticles.has(art.article_id)) {
            uniqueArticles.set(art.article_id, {
                ...art,
                last_seen_request_jst: matchedReq.request_time_jst,
                last_seen_ms: matchedReq.started_at_ms
            });
          }
      }
    }
  }
}

const candidates = Array.from(uniqueArticles.values());
console.log(`Found ${candidates.length} unique articles matching subculture request windows.`);

// We need to identify which 58 were "new".
// 58 articles were recorded as 'new_items' during the requests.
// This means they were added to Redis for the first time during those requests.
// 2 articles in my 60 must have been "already_known" even though they were fetched during a subculture window.

// Actually, the most reliable way to identify "new" articles is to look at their fetched_at
// relative to other requests.
// But since I only have the LATEST fetched_at, I can't be 100% sure if an article was re-fetched.

// However, if I sort all 60 by their last_seen_ms, I can match them to requests.
candidates.sort((a, b) => a.last_seen_ms - b.last_seen_ms);

const reconstructed: any[] = [];
const requestCounts = new Map<string, number>();

for (const art of candidates) {
    const reqTime = art.last_seen_request_jst;
    const currentCount = requestCounts.get(reqTime) || 0;
    const req = subcultureRequests.find(r => r.request_time_jst === reqTime);

    // If this request expects more new items, assign this article as 'new'
    if (currentCount < (req?.new_items || 0)) {
        reconstructed.push({
            article_id: art.article_id,
            title: art.title,
            published_at_utc: art.published_at,
            published_at_jst: new Date(new Date(art.published_at).getTime() + 9 * 3600000).toISOString().replace("T", " ").split(".")[0],
            api_available_estimated_jst: new Date(new Date(art.published_at).getTime() + 21 * 3600000).toISOString().replace("T", " ").split(".")[0],
            first_subculture_request_jst: reqTime,
            fetched_at: art.fetched_at
        });
        requestCounts.set(reqTime, currentCount + 1);
    }
}

console.log(`Reconstructed ${reconstructed.length} / 58 new items.`);

// If still missing (e.g. 54/58), try to find articles that were re-fetched LATER than their "new" request.
if (reconstructed.length < 58) {
    const missingArticles = candidates.filter(c => !reconstructed.some(r => r.article_id === c.article_id));
    console.log(`Remaining articles in pool: ${missingArticles.length}`);

    for (const req of subcultureRequests) {
        const foundSoFar = reconstructed.filter(r => r.first_subculture_request_jst === req.request_time_jst).length;
        if (foundSoFar < req.new_items) {
            const needed = req.new_items - foundSoFar;
            // These missing items must be in the pool but assigned to a LATER request (due to re-fetch).
            // Their published_at must be <= this request time.
            const candidatesForThis = missingArticles.filter(c => {
                const pubMs = new Date(c.published_at).getTime();
                return pubMs <= req.started_at_ms;
            });
            // Sort by published_at DESC (most likely to be the new ones)
            candidatesForThis.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

            const toAdd = candidatesForThis.slice(0, needed);
            console.log(`Assigning ${toAdd.length} articles to ${req.request_time_jst} (re-fetch case)`);
            for (const a of toAdd) {
                reconstructed.push({
                    article_id: a.article_id,
                    title: a.title,
                    published_at_utc: a.published_at,
                    published_at_jst: new Date(new Date(a.published_at).getTime() + 9 * 3600000).toISOString().replace("T", " ").split(".")[0],
                    api_available_estimated_jst: new Date(new Date(a.published_at).getTime() + 21 * 3600000).toISOString().replace("T", " ").split(".")[0],
                    first_subculture_request_jst: req.request_time_jst,
                    fetched_at: a.fetched_at
                });
                // Remove from pool
                missingArticles.splice(missingArticles.indexOf(a), 1);
            }
        }
    }
}

console.log(`Final reconstructed count: ${reconstructed.length} / 58`);

// Analysis
reconstructed.sort((a, b) => a.api_available_estimated_jst.localeCompare(b.api_available_estimated_jst));

const intervalTable = reconstructed.map((art, i) => {
  let interval: number | null = null;
  if (i > 0) {
    const prev = reconstructed[i-1];
    interval = Math.round((new Date(art.api_available_estimated_jst).getTime() - new Date(prev.api_available_estimated_jst).getTime()) / 60000);
  }
  return { ...art, interval_min: interval };
});

function getMaxRollingWindow(articles: any[], windowMinutes: number) {
  let maxCount = 0;
  let maxWindowStart: string = "";

  for (const art of articles) {
    const windowStart = new Date(art.api_available_estimated_jst).getTime();
    const windowEnd = windowStart + windowMinutes * 60000;

    const count = articles.filter(a => {
      const t = new Date(a.api_available_estimated_jst).getTime();
      return t >= windowStart && t < windowEnd;
    }).length;

    if (count > maxCount) {
      maxCount = count;
      maxWindowStart = art.api_available_estimated_jst;
    }
  }
  return { maxCount, peak_start: maxWindowStart };
}

const window60 = getMaxRollingWindow(reconstructed, 60);
const window90 = getMaxRollingWindow(reconstructed, 90);
const window120 = getMaxRollingWindow(reconstructed, 120);

const results = {
  summary: {
    expected_new_items: 58,
    reconstructed_count: reconstructed.length,
    first_api_available_jst: reconstructed[0]?.api_available_estimated_jst,
    last_api_available_jst: reconstructed[reconstructed.length - 1]?.api_available_estimated_jst,
    rolling_windows: {
      "60min": { max_count: window60.maxCount, peak_start: window60.peak_start, limit_exceeded: window60.maxCount > 10 },
      "90min": { max_count: window90.maxCount, peak_start: window90.peak_start, limit_exceeded: window90.maxCount > 10 },
      "120min": { max_count: window120.maxCount, peak_start: window120.peak_start, limit_exceeded: window120.maxCount > 10 }
    }
  },
  articles: intervalTable
};

await Deno.writeTextFile("newsdata_subculture_new_articles_analysis_v3.json", JSON.stringify(results, null, 2));

console.log("Analysis complete.");
