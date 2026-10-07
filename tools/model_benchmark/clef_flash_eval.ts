// Reproducible, standalone Workers AI classification evaluation.
// Live requests are opt-in; credentials are read only from the process environment.
export const CATEGORIES = ["トレンド", "エンタメ", "サブカル", "マネー", "IT・ガジェット", "除外"] as const;
export type Category = typeof CATEGORIES[number];

export interface EvalArticle {
  article_id: string;
  title: string;
  description: string;
  input_sha256: string;
}

export interface RunResult {
  article_id: string;
  category: Category | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
}

export function parseCategory(value: unknown): Category | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "category" in parsed) {
      const category = (parsed as { category: unknown }).category;
      return CATEGORIES.includes(category as Category) ? category as Category : null;
    }
  } catch { /* accept a plain category below */ }
  return CATEGORIES.includes(cleaned as Category) ? cleaned as Category : null;
}

export function summarize(results: RunResult[]) {
  const successful = results.filter((r): r is RunResult & { category: Category; latency_ms: number } => r.category !== null && r.latency_ms !== null);
  const sortedLatency = successful.map(r => r.latency_ms).sort((a, b) => a - b);
  const percentile = (p: number) => sortedLatency.length ? sortedLatency[Math.max(0, Math.ceil(p * sortedLatency.length) - 1)] : null;
  const excluded = successful.filter(r => r.category === "除外").length;
  return {
    attempted: results.length,
    successful: successful.length,
    failed: results.length - successful.length,
    category_counts: Object.fromEntries(CATEGORIES.map(c => [c, successful.filter(r => r.category === c).length])),
    excluded_count: excluded,
    exclusion_precision: null,
    exclusion_recall: null,
    latency_p50_ms: percentile(0.50),
    latency_p95_ms: percentile(0.95),
    input_tokens: results.every(r => r.input_tokens !== null) ? results.reduce((n, r) => n + (r.input_tokens ?? 0), 0) : null,
    output_tokens: results.every(r => r.output_tokens !== null) ? results.reduce((n, r) => n + (r.output_tokens ?? 0), 0) : null,
    repeat_agreement: null,
  };
}

const SYSTEM_PROMPT = `あなたはAI速のニュース記事分類器です。入力は記事タイトルと短い説明です。記事の主題を次の6種類のいずれか1つに分類してください。トレンド、エンタメ、サブカル、マネー、IT・ガジェット、除外。政治・社会・事件・災害・国際など広く社会的に重要な話題はトレンド、芸能・スポーツはエンタメ、漫画・アニメ・ゲーム・ネット文化はサブカル、金融・企業経済・投資はマネー、技術・製品・デジタルサービスはIT・ガジェット。AI速のニュースとして扱う価値が薄い広告、宣伝、販促、求人、イベント告知、掲示板雑談・反応集、本文のない記事は除外。内容に基づき最も適切なものを選ぶ。JSONのみで {"category":"..."} と返す。`;

export async function callWorkersAI(args: { accountId: string; token: string; model: string; article: EvalArticle; repeat: number }): Promise<RunResult> {
  const input = `タイトル: ${args.article.title}\n説明: ${args.article.description}`;
  const started = performance.now();
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(args.accountId)}/ai/run/${encodeURIComponent(args.model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: input }], max_tokens: 80, temperature: 0 }),
    });
    const elapsed = Math.round(performance.now() - started);
    if (!response.ok) return { article_id: args.article.article_id, category: null, latency_ms: elapsed, input_tokens: null, output_tokens: null, error: `http_${response.status}` };
    const body: any = await response.json();
    const content = body?.result?.response ?? body?.result?.choices?.[0]?.message?.content;
    return {
      article_id: args.article.article_id,
      category: parseCategory(content),
      latency_ms: elapsed,
      input_tokens: Number.isFinite(body?.result?.usage?.prompt_tokens) ? body.result.usage.prompt_tokens : null,
      output_tokens: Number.isFinite(body?.result?.usage?.completion_tokens) ? body.result.usage.completion_tokens : null,
      error: content == null ? "missing_response" : parseCategory(content) === null ? "invalid_category" : null,
    };
  } catch {
    return { article_id: args.article.article_id, category: null, latency_ms: Math.round(performance.now() - started), input_tokens: null, output_tokens: null, error: "network_error" };
  }
}

if (import.meta.main) {
  const args = [...Deno.args];
  const live = args.includes("--live");
  const arg = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const root = new URL("./", import.meta.url);
  const articlesDir = new URL("./dataset/articles/", root);
  const articles: EvalArticle[] = [];
  for await (const entry of Deno.readDir(articlesDir)) {
    if (!entry.isFile || !/^article-\d+\.json$/.test(entry.name)) continue;
    const raw = await Deno.readTextFile(new URL(entry.name, articlesDir));
    const data = JSON.parse(raw);
    if (typeof data.title !== "string" || !data.title.trim()) continue;
    const description = typeof data.description === "string" ? data.description : "";
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${data.title}\n${description}`));
    const input_sha256 = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
    articles.push({ article_id: data.article_id, title: data.title, description, input_sha256 });
  }
  articles.sort((a, b) => a.article_id.localeCompare(b.article_id));
  const selected = articles.slice(0, Number(arg("--limit", "20")));
  const report: Record<string, unknown> = {
    dataset: "tools/model_benchmark/dataset/articles/*.json",
    total_available: articles.length,
    selected_count: selected.length,
    selected_inputs: selected.map(({ article_id, input_sha256 }) => ({ article_id, input_sha256 })),
    label_status: "no verified current ground-truth labels; legacy.app_categories excluded from scoring",
    model: arg("--model") ?? null,
    live,
    results: [],
  };
  if (!live) {
    console.log(JSON.stringify({ ...report, status: "dry_run", reason: "pass --live to call Workers AI" }, null, 2));
    Deno.exit(0);
  }
  const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  const token = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const model = arg("--model");
  if (!accountId || !token || !model) {
    console.log(JSON.stringify({ ...report, status: "not_measured", reason: "live evaluation requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and explicit --model" }, null, 2));
    Deno.exit(0);
  }
  const repetitions = Math.max(1, Math.min(3, Number(arg("--repeat", "2"))));
  const results: RunResult[] = [];
  for (let run = 0; run < repetitions; run++) {
    for (const article of selected) {
      results.push(await callWorkersAI({ accountId, token, model, article, repeat: run }));
    }
  }
  const agreement = selected.map(a => results.filter(r => r.article_id === a.article_id).map(r => r.category)).filter(xs => xs.length > 1 && xs.every(x => x !== null)).map(xs => xs.every(x => x === xs[0]) ? 1 : 0);
  report.results = results;
  report.summary = { ...summarize(results), repeat_agreement: agreement.length ? agreement.reduce<number>((a, b) => a + b, 0) / agreement.length : null };
  report.estimated_cost_usd = null;
  report.cost_note = "Workers AI billing/Neurons are not returned by the inference response; cost not measured.";
  console.log(JSON.stringify(report, null, 2));
}
