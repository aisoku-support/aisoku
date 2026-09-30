import { type Config, keys } from "./config.ts";
import { type Article, mergeArticles } from "./normalize.ts";
import type { V2State } from "./scheduler.ts";
export class Redis {
  constructor(private url: string, private token: string) {}
  async command<T = unknown>(...command: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Redis HTTP failure");
    const body = await response.json();
    if (body.error) throw new Error("Redis command failure");
    return body.result as T;
  }
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
// 同一記事への複数ID/URLを参照キーで解決。本体と索引と参照を原子的に更新。
const saveScript = `
local item = cjson.decode(ARGV[1])
local aliases = cjson.decode(ARGV[2])
local bodies = {}
local canonical = ARGV[3]
local known = false
for _, alias in ipairs(aliases) do
  local id = redis.call('GET', alias)
  if id then
    local body = redis.call('GET', 'newsdata:article:' .. id)
    if body then bodies[id] = cjson.decode(body); canonical = id; known = true end
  end
end
local function union(a,b)
  local seen = {}; local out = {}
  for _, list in ipairs({a,b}) do for _, v in ipairs(list) do if not seen[v] then seen[v]=true; table.insert(out,v) end end end
  return out
end
for id, old in pairs(bodies) do
  item.newsdata_categories = union(item.newsdata_categories, old.newsdata_categories)
  item.app_categories = union(item.app_categories, old.app_categories)
  aliases = union(aliases, old.identity_keys or {})
  if id ~= canonical then redis.call('DEL', 'newsdata:article:' .. id); redis.call('ZREM', KEYS[1], id) end
end
item.identity_keys = aliases
item.expires_at = tonumber(ARGV[5]) + tonumber(ARGV[4]) * 1000
local mapping = cjson.decode(ARGV[6])
item.app_categories = {}
for _, category in ipairs(item.newsdata_categories) do
  if mapping[category] then item.app_categories = union(item.app_categories, {mapping[category]}) end
end
-- cjsonは空配列を{}へ変換するため、エンコード後に空カテゴリ配列を補正。
local encoded = cjson.encode(item)
encoded = string.gsub(encoded, '"app_categories":{}', '"app_categories":[]')
encoded = string.gsub(encoded, '"newsdata_categories":{}', '"newsdata_categories":[]')
redis.call('SET', 'newsdata:article:' .. canonical, encoded, 'EX', ARGV[4])
redis.call('ZADD', KEYS[1], ARGV[5], canonical)
for _, alias in ipairs(aliases) do redis.call('SET', alias, canonical, 'EX', ARGV[4]) end
if known then return {0, false} else return {1, item.article_id} end
`;
export async function saveArticles(
  redis: Redis,
  groups: Article[][],
  cfg: Config,
) {
  let new_articles = 0;
  let already_known = 0;
  const new_article_ids: string[] = [];
  for (const group of groups) {
    const aliases = [
      ...new Set(
        await Promise.all(
          group.flatMap(
            (a) => [`id:${a.article_id}`, `url:${a.normalized_url}`],
          ).map(async (s) => keys.identity(await digest(s))),
        ),
      ),
    ];
    const item = mergeArticles(group);
    const saved = await redis.command<[number, string | false]>(
      "EVAL",
      saveScript,
      1,
      keys.articles,
      JSON.stringify(item),
      JSON.stringify(aliases),
      await digest(`id:${item.article_id}`),
      cfg.articleRetentionSeconds,
      Date.now(),
      JSON.stringify(cfg.categoryMap),
    );
    if (saved[0]) {
      new_articles++;
      if (typeof saved[1] === "string") new_article_ids.push(saved[1]);
    } else already_known++;
  }
  await redis.command(
    "ZREMRANGEBYSCORE",
    keys.articles,
    "-inf",
    Date.now() - cfg.articleRetentionSeconds * 1000,
  );
  return { new_articles, already_known, new_article_ids };
}
export async function saveLog(
  redis: Redis,
  id: string,
  log: object,
  cfg: Config,
  started: number,
) {
  await redis.command(
    "SET",
    keys.job(id),
    JSON.stringify(log),
    "EX",
    cfg.logRetentionSeconds,
  );
  await redis.command("ZADD", keys.jobs, started, id);
  await redis.command(
    "ZREMRANGEBYSCORE",
    keys.jobs,
    "-inf",
    Date.now() - cfg.logRetentionSeconds * 1000,
  );
}

export async function getV2State(redis: Redis): Promise<V2State | null> {
  const data = await redis.command<string | null>("GET", keys.v2State);
  return data ? JSON.parse(data) : null;
}

export async function saveV2State(redis: Redis, state: V2State) {
  await redis.command("SET", keys.v2State, JSON.stringify(state));
}

export async function acquire(
  redis: Redis,
  cfg: Config,
  id: string,
  now: number,
): Promise<boolean> {
  return await redis.command<number>(
    "EVAL",
    `
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    return 1`,
    1,
    keys.lock,
    id,
    Math.ceil(cfg.requestTimeoutMs / 1000) + 60,
  ) === 1;
}
export async function release(redis: Redis, id: string) {
  await redis.command(
    "EVAL",
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    1,
    keys.lock,
    id,
  );
}
