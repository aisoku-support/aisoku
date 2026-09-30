const url = Deno.env.get("UPSTASH_REDIS_REST_URL");
const token = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
if (!url || !token) throw new Error("Upstash configuration missing");
async function command(command: unknown[]) {
  const response = await fetch(url!, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("Upstash observation HTTP failure");
  return (await response.json()).result;
}
const ids = await command(["ZREVRANGE", "newsdata:jobs", 0, 0]);
const raw = Array.isArray(ids) && typeof ids[0] === "string"
  ? await command(["GET", `newsdata:job:${ids[0]}`])
  : null;
const stateRaw = await command(["GET", "newsdata:v2:state"]);
const job = raw ? JSON.parse(String(raw)) : {};
const state = stateRaw ? JSON.parse(String(stateRaw)) : {};
console.log(JSON.stringify({
  run_finished_at: job.run_finished_at ?? null,
  trigger: job.trigger ?? null,
  state: job.state ?? null,
  modes: Array.isArray(job.requests)
    ? [...new Set(job.requests.map((r: Record<string, unknown>) => r.request_mode))]
    : [],
  new_articles: job.new_articles ?? null,
  topic_enqueued: job.topic_enqueued ?? null,
  topic_enqueue_failed: job.topic_enqueue_failed ?? null,
  next_normal_fetch_at: state.next_normal_fetch_at ?? null,
  next_tech_fetch_at: state.next_tech_fetch_at ?? null,
  next_subculture_fetch_at: state.next_subculture_fetch_at ?? null,
}));
