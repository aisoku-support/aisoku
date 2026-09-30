
const SUBCULTURE_KEYWORDS = ["ゲーム", "VTuber", "フィギュア", "コスプレ"];
const REDIS_URL = Deno.env.get("UPSTASH_REDIS_REST_URL");
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

async function redisCommand<T = any>(command: any[]): Promise<T> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("Upstash configuration missing");
  }
  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Redis HTTP failure: ${response.statusText}`);
  const body = await response.json();
  if (body.error) throw new Error(`Redis command failure: ${body.error}`);
  return body.result as T;
}

function matchesSubculture(art: any): boolean {
  const text = (art.title + " " + (art.description || "")).toLowerCase();
  return SUBCULTURE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

async function main() {
  const data = JSON.parse(await Deno.readTextFile("newsdata_24h_20260910_1725.json"));
  const jobs: any[] = data.jobs;

  // 1. Get ALL article IDs from Redis to have a wider window (last 3 days)
  console.log("Fetching article IDs from Redis...");
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const allIds = await redisCommand(["ZRANGEBYSCORE", "newsdata:articles", threeDaysAgo, "+inf"]);
  console.log(`Found ${allIds.length} articles in last 3 days.`);

  // 2. Fetch and filter subculture articles
  const subcultureArticles: any[] = [];
  const batchSize = 100;
  for (let i = 0; i < allIds.length; i += batchSize) {
    const batch = allIds.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((id: string) => redisCommand(["GET", `newsdata:article:${id}`])));
    for (const res of results) {
      if (res) {
        const art = JSON.parse(res);
        if (matchesSubculture(art)) {
          subcultureArticles.push(art);
        }
      }
    }
  }
  console.log(`Found ${subcultureArticles.length} subculture articles.`);

  const subcultureRequests: any[] = [];
  for (const job of jobs) {
    if (!job.requests) continue;
    for (const req of job.requests) {
      if (req.request_mode === "subculture" && req.status === "success") {
        subcultureRequests.push({ ...req, job_started_at: job.run_started_at });
      }
    }
  }
  subcultureRequests.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

  const results: any[] = [];
  let previousSubcultureTime: number | null = null;
  const allDuplicateAges: number[] = [];

  for (const req of subcultureRequests) {
    const requestTime = new Date(req.started_at).getTime();
    const interval = previousSubcultureTime ? Math.round((requestTime - previousSubcultureTime) / 60000) : null;
    previousSubcultureTime = requestTime;

    const alreadyKnownCount = req.already_known_items;

    // Duplicates are articles matching subculture that were fetched BEFORE started_at
    const knownCandidates = subcultureArticles.filter(a => {
      const fetchedTime = new Date(a.fetched_at).getTime();
      return fetchedTime < requestTime - 5000; // Small buffer
    }).sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

    // Take the top $alreadyKnownCount
    const duplicateArticles = knownCandidates.slice(0, alreadyKnownCount).map(a => ({
      article_id: a.article_id,
      title: a.title,
      published_at_utc: a.published_at,
      published_at_jst: new Date(new Date(a.published_at).getTime() + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, ""),
      age_minutes_at_request: Math.round((requestTime - new Date(a.published_at).getTime()) / 60000)
    }));

    const reconstructedCount = duplicateArticles.length;
    const missingCount = alreadyKnownCount - reconstructedCount;
    let status = "fully_reconstructed";
    if (missingCount > 0) status = reconstructedCount > 0 ? "partially_reconstructed" : "not_reconstructable";

    let oldest = null, newest = null, range = null, minAge = null, maxAge = null, avgAge = null, medianAge = null;
    if (reconstructedCount > 0) {
      const ages = duplicateArticles.map(a => a.age_minutes_at_request).sort((a, b) => a - b);
      minAge = ages[0];
      maxAge = ages[ages.length - 1];
      avgAge = Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10;
      medianAge = ages[Math.floor(ages.length / 2)];
      allDuplicateAges.push(...ages);

      const pubTimes = duplicateArticles.map(a => new Date(a.published_at_utc).getTime()).sort((a, b) => a - b);
      oldest = new Date(pubTimes[0] + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, "");
      newest = new Date(pubTimes[pubTimes.length - 1] + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, "");
      range = Math.round((pubTimes[pubTimes.length - 1] - pubTimes[0]) / 60000);
    }

    results.push({
      request_time_jst: new Date(requestTime + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, ""),
      minutes_since_previous_subculture: interval,
      new_items: req.new_items,
      already_known_items: alreadyKnownCount,
      reconstruction_status: status,
      reconstructed_duplicate_count: reconstructedCount,
      duplicate_articles: duplicateArticles,
      average_age_minutes: avgAge,
      median_age_minutes: medianAge,
      min_age_minutes: minAge,
      max_age_minutes: maxAge,
    });
  }

  // Final Aggregations
  const intervalBuckets: Record<string, any[]> = { "30-39": [], "40-59": [], "60-89": [], "90+": [] };
  for (const r of results) {
    const inv = r.minutes_since_previous_subculture;
    if (inv === null) continue;
    let bucket = "90+";
    if (inv < 40) bucket = "30-39";
    else if (inv < 60) bucket = "40-59";
    else if (inv < 90) bucket = "60-89";
    intervalBuckets[bucket].push(r);
  }

  const intervalSummary = Object.entries(intervalBuckets).map(([name, reqs]) => {
    const count = reqs.length;
    if (count === 0) return { bucket: name, count: 0 };
    const avgNew = Math.round((reqs.reduce((a, b) => a + b.new_items, 0) / count) * 10) / 10;
    const avgKnown = Math.round((reqs.reduce((a, b) => a + b.already_known_items, 0) / count) * 10) / 10;
    const allAges = reqs.flatMap(r => r.duplicate_articles.map((a: any) => a.age_minutes_at_request));
    const avgAge = allAges.length > 0 ? Math.round((allAges.reduce((a, b) => a + b, 0) / allAges.length) * 10) / 10 : null;
    const medAge = allAges.length > 0 ? allAges.sort((a, b) => a - b)[Math.floor(allAges.length / 2)] : null;
    return { bucket: name, count, avg_new: avgNew, avg_known: avgKnown, avg_age: avgAge, median_age: medAge };
  });

  const ageDistribution = { "0-30m": 0, "30-60m": 0, "60-90m": 0, "90-120m": 0, "2-3h": 0, "3-6h": 0, "6h+": 0 };
  for (const age of allDuplicateAges) {
    if (age <= 30) ageDistribution["0-30m"]++;
    else if (age <= 60) ageDistribution["30-60m"]++;
    else if (age <= 90) ageDistribution["60-90m"]++;
    else if (age <= 120) ageDistribution["90-120m"]++;
    else if (age <= 180) ageDistribution["2-3h"]++;
    else if (age <= 360) ageDistribution["3-6h"]++;
    else ageDistribution["6h+"]++;
  }

  const finalOutput = {
    requests: results,
    interval_summary: intervalSummary,
    age_distribution: ageDistribution,
  };

  await Deno.writeTextFile("newsdata_subculture_duplicate_analysis_20260910.json", JSON.stringify(finalOutput, null, 2));

  const csvHeaders = ["request_time_jst", "interval_min", "new", "known", "status", "recon_count", "avg_age", "med_age"];
  const csvRows = results.map(r => [
    r.request_time_jst, r.minutes_since_previous_subculture ?? "", r.new_items, r.already_known_items,
    r.reconstruction_status, r.reconstructed_duplicate_count, r.average_age_minutes ?? "", r.median_age_minutes ?? ""
  ]);
  await Deno.writeTextFile("newsdata_subculture_duplicate_analysis_20260910.csv", [csvHeaders.join(","), ...csvRows.map(row => row.join(","))].join("\n"));

  console.log("Analysis v2 Complete.");
  const totalKnown = results.reduce((a, b) => a + b.already_known_items, 0);
  const totalRecon = results.reduce((a, b) => a + b.reconstructed_duplicate_count, 0);
  console.log(`Total subculture requests: ${results.length}`);
  console.log(`Total already_known_items: ${totalKnown}`);
  console.log(`Actually reconstructed: ${totalRecon} (${Math.round(totalRecon/totalKnown*100)}%)`);
}

main().catch(console.error);
