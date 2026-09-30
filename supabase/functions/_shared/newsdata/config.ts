// NewsData.io運用値の唯一の定義。Cron SQLもこの値から生成する。
export const config = {
  enabled: true,
  intervalSeconds: 300,
  maxRequests: 10,
  maxItems: 100,
  pageSize: 10,
  requestTimeoutMs: 10000, // CURRENT_SPECに数値指定なし。実装上の仮値。
  articleRetentionSeconds: 7 * 86400,
  logRetentionSeconds: 30 * 86400,
  language: "ja",
  endpoint: "https://newsdata.io/api/1/latest",
  // V2 Settings
  timezone: "Asia/Tokyo",
  dailyCreditLimit: 100,
  rateLimitCredits: 30,
  rateLimitWindowMinutes: 15,
  quotaResetTime: "09:00",
  // 08時台のburn-down / Last Pushは廃止。quota resetとProbeはscheduler側で維持する。
  burnDownStart: "09:00",
  targetExhaustTime: "09:00",
  requestsPerFetch: 1,
  normalBudget: 80,
  techIntervalMinutes: 120,
  techBudget: 12,
  techBurstReserve: 0,
  subcultureIntervalMinutes: 180,
  subcultureBudget: 8,
  subcultureBurstReserve: 0,
  maxBurstPages: 1,
  burstMinItems: 10,
  burstMinNewItems: 10,
  // Fetch Modes
  subcultureSearch: "ゲーム OR VTuber OR フィギュア OR コスプレ",
  techSearch:
    "半導体 OR GPU OR CPU OR Windows OR Android OR iPhone OR ロボット",
  excludedDomains:
    "topics.smt.docomo.ne.jp,smartnews.com,jp.investing.com,prtimes.jp,news.google.com",
  schedule: [
    { start: "09:00", end: "13:00", intervalMinutes: 24 },
    { start: "13:00", end: "14:00", intervalMinutes: 32 },
    { start: "14:00", end: "17:00", intervalMinutes: 60 },
    { start: "17:00", end: "01:00", intervalMinutes: 28 },
    { start: "01:00", end: "05:00", intervalMinutes: 60 },
    { start: "05:00", end: "07:00", intervalMinutes: 40 },
    { start: "07:00", end: "08:00", intervalMinutes: 28 },
    { start: "08:00", end: "09:00", intervalMinutes: 30 },
  ] as { start: string; end: string; intervalMinutes: number }[],
  categoryMap: {
    top: "トレンド",
    world: "トレンド",
    politics: "トレンド",
    crime: "トレンド",
    domestic: "トレンド",
    environment: "トレンド",
    education: "トレンド",
    health: "トレンド",
    tourism: "トレンド",
    entertainment: "エンタメ",
    sports: "エンタメ",
    lifestyle: "エンタメ",
    food: "エンタメ",
    other: "サブカル",
    business: "マネー",
    technology: "IT・ガジェット",
    science: "IT・ガジェット",
  } as Record<string, string>,
};
export const keys = {
  settings: "newsdata:settings", // JSON上書き。enabled=falseで再デプロイせず停止。
  articles: "newsdata:articles",
  article: (id: string) => `newsdata:article:${id}`,
  identity: (hash: string) => `newsdata:identity:${hash}`,
  jobs: "newsdata:jobs",
  job: (id: string) => `newsdata:job:${id}`,
  slot: (slot: number) => `newsdata:slot:${slot}`,
  lock: "newsdata:lock",
  v2State: "newsdata:v2:state",
};
export type Config = typeof config;
export function resolveConfig(raw: string | null): Config {
  const overrides = raw ? JSON.parse(raw) : {};
  // Stored runtime settings may predate hourly low-credit operation.
  const result = {
    ...config,
    ...overrides,
    requestsPerFetch: 1,
    maxBurstPages: 1,
  };
  for (
    const name of [
      "intervalSeconds",
      "maxRequests",
      "maxItems",
      "pageSize",
      "requestTimeoutMs",
      "articleRetentionSeconds",
      "logRetentionSeconds",
      "dailyCreditLimit",
      "rateLimitCredits",
      "rateLimitWindowMinutes",
      "requestsPerFetch",
      "normalBudget",
      "techIntervalMinutes",
      "techBudget",
      "techBurstReserve",
      "subcultureIntervalMinutes",
      "subcultureBudget",
      "subcultureBurstReserve",
      "maxBurstPages",
      "burstMinItems",
      "burstMinNewItems",
    ] as const
  ) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 0) {
      throw new Error(`Invalid configuration: ${name}`);
    }
  }
  if (
    result.normalBudget + result.techBudget + result.techBurstReserve +
          result.subcultureBudget + result.subcultureBurstReserve !==
      result.dailyCreditLimit ||
    result.burstMinItems < 1 ||
    result.burstMinNewItems < 1
  ) throw new Error("Invalid configuration: credit allocation or burst rules");
  if (
    typeof result.enabled !== "boolean" || !result.categoryMap ||
    Object.values(result.categoryMap).some((v) => typeof v !== "string") ||
    !Array.isArray(result.schedule) ||
    typeof result.subcultureSearch !== "string" ||
    typeof result.techSearch !== "string" ||
    typeof result.excludedDomains !== "string"
  ) throw new Error("Invalid configuration");
  return { ...result, endpoint: config.endpoint };
}
