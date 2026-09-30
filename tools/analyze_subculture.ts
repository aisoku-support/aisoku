
import { Article } from "../supabase/functions/_shared/newsdata/normalize.ts";

const SUBCULTURE_KEYWORDS = ["ゲーム", "VTuber", "フィギュア", "コスプレ"];

function matchesSubculture(art: Article): boolean {
  const text = (art.title + " " + (art.description || "")).toLowerCase();
  return SUBCULTURE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

async function main() {
  const data = JSON.parse(await Deno.readTextFile("newsdata_24h_20260910_1725.json"));
  const articles: Article[] = data.articles;
  const jobs: any[] = data.jobs;

  // Filter all subculture articles and sort by published_at DESC
  const subcultureArticles = articles.filter(matchesSubculture).sort((a, b) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );

  const subcultureRequests: any[] = [];
  for (const job of jobs) {
    if (!job.requests) continue;
    for (const req of job.requests) {
      if (req.request_mode === "subculture" && req.status === "success") {
        subcultureRequests.push({
          ...req,
          job_started_at: job.run_started_at,
        });
      }
    }
  }

  // Sort requests by started_at ASC
  subcultureRequests.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

  const results: any[] = [];
  let previousSubcultureTime: number | null = null;

  for (const req of subcultureRequests) {
    const requestTime = new Date(req.started_at).getTime();
    const interval = previousSubcultureTime ? Math.round((requestTime - previousSubcultureTime) / 60000) : null;
    previousSubcultureTime = requestTime;

    const newCount = req.new_items;
    const alreadyKnownCount = req.already_known_items;

    // 1. Identify "new" articles for this request
    // These should have fetched_at very close to started_at
    const newArticles = articles.filter(a => {
      const fetchedTime = new Date(a.fetched_at).getTime();
      return Math.abs(fetchedTime - requestTime) < 30000 && matchesSubculture(a);
    });

    // 2. Identify "already known" candidates
    // These are articles that match keywords and were fetched BEFORE started_at
    const knownCandidates = articles.filter(a => {
      const fetchedTime = new Date(a.fetched_at).getTime();
      return fetchedTime < requestTime - 10000 && matchesSubculture(a);
    }).sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

    // We assume the API returns the most recent 10 items.
    // So the duplicates are the ones that were already known but are still in the top 10.
    // This is hard to be 100% sure about without the exact list, but we can look for the most recent $alreadyKnownCount ones.
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

    // Stats for duplicates
    let oldest = null, newest = null, range = null, minAge = null, maxAge = null, avgAge = null, medianAge = null;
    if (reconstructedCount > 0) {
      const ages = duplicateArticles.map(a => a.age_minutes_at_request).sort((a, b) => a - b);
      minAge = ages[0];
      maxAge = ages[ages.length - 1];
      avgAge = Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10;
      medianAge = ages[Math.floor(ages.length / 2)];

      const pubTimes = duplicateArticles.map(a => new Date(a.published_at_utc).getTime()).sort((a, b) => a - b);
      oldest = new Date(pubTimes[0] + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, "");
      newest = new Date(pubTimes[pubTimes.length - 1] + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, "");
      range = Math.round((pubTimes[pubTimes.length - 1] - pubTimes[0]) / 60000);
    }

    results.push({
      request_time_utc: req.started_at,
      request_time_jst: new Date(requestTime + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\..*$/, ""),
      minutes_since_previous_subculture: interval,
      new_items: newCount,
      already_known_items: alreadyKnownCount,
      reconstruction_status: status,
      reconstructed_duplicate_count: reconstructedCount,
      missing_duplicate_count: missingCount,
      duplicate_articles: duplicateArticles,
      oldest_published_at_jst: oldest,
      newest_published_at_jst: newest,
      published_range_minutes: range,
      min_age_minutes: minAge,
      max_age_minutes: maxAge,
      average_age_minutes: avgAge,
      median_age_minutes: medianAge,
    });
  }

  // 1. Output JSON
  await Deno.writeTextFile("newsdata_subculture_duplicate_analysis_20260910.json", JSON.stringify(results, null, 2));

  // 2. Output CSV
  const csvHeaders = ["request_time_jst", "interval_min", "new", "known", "status", "recon_count", "avg_age", "med_age", "min_age", "max_age"];
  const csvRows = results.map(r => [
    r.request_time_jst,
    r.minutes_since_previous_subculture ?? "",
    r.new_items,
    r.already_known_items,
    r.reconstruction_status,
    r.reconstructed_duplicate_count,
    r.average_age_minutes ?? "",
    r.median_age_minutes ?? "",
    r.min_age_minutes ?? "",
    r.max_age_minutes ?? ""
  ]);
  const csvContent = [csvHeaders.join(","), ...csvRows.map(row => row.join(","))].join("\n");
  await Deno.writeTextFile("newsdata_subculture_duplicate_analysis_20260910.csv", csvContent);

  // 3. Final Summary for Console
  console.log("Analysis Complete.");
  const totalKnown = results.reduce((a, b) => a + b.already_known_items, 0);
  const totalRecon = results.reduce((a, b) => a + b.reconstructed_duplicate_count, 0);
  console.log(`Total subculture requests: ${results.length}`);
  console.log(`Total already_known_items: ${totalKnown}`);
  console.log(`Actually reconstructed: ${totalRecon} (${Math.round(totalRecon/totalKnown*100)}%)`);
}

main().catch(console.error);
