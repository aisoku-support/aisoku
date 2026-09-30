import {
  createUpstashClient,
  loadClaimedArticles,
} from "../supabase/functions/_shared/topic/article_store.ts";

const url = Deno.env.get("UPSTASH_REDIS_REST_URL");
const token = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
if (!url || !token) throw new Error("Upstash configuration missing");
async function command(command: unknown[]) {
  const response = await fetch(url!, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("Upstash fixture HTTP failure");
  return (await response.json()).result;
}
const canonicalIds = await command(["ZREVRANGE", "newsdata:articles", 0, 0]);
if (!Array.isArray(canonicalIds) || typeof canonicalIds[0] !== "string") {
  throw new Error("No cached article fixture available");
}
const raw = await command(["GET", `newsdata:article:${canonicalIds[0]}`]);
const articleId = JSON.parse(String(raw)).article_id;
if (typeof articleId !== "string") throw new Error("Fixture article_id missing");
const base = createUpstashClient(url, token);
let mgetRequests = 0;
const result = await loadClaimedArticles({
  mget: (keys) => {
    mgetRequests++;
    return base.mget(keys);
  },
}, [articleId]);
console.log(JSON.stringify({ resolved: "article" in result[0], mgetRequests }));
