import type { QueueItem } from "./types.ts";

export type SupabaseConfig = { url: string; serviceRoleKey: string };

export function supabaseConfigFromEnv(): SupabaseConfig {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase configuration missing");
  }
  return { url: url.replace(/\/$/, ""), serviceRoleKey };
}

function headers(config: SupabaseConfig) {
  return {
    Authorization: `Bearer ${config.serviceRoleKey}`,
    apikey: config.serviceRoleKey,
    "Content-Type": "application/json",
  };
}

export async function safeReadJson<T>(
  response: Response,
  source: string,
  options: { requireBody?: boolean } = {},
): Promise<T> {
  const requireBody = options.requireBody ?? true;
  const bodyText = await response.text();
  const status = response.status;
  const contentType = response.headers.get("content-type") ?? "missing";
  const bodyLength = bodyText.length;

  if (!response.ok) {
    throw new Error(
      `${source} HTTP failure status=${status} content_type=${contentType} body_length=${bodyLength}`,
    );
  }

  if (bodyLength === 0) {
    if (requireBody) {
      throw new Error(
        `${source} empty response status=${status} content_type=${contentType} body_length=0`,
      );
    }
    return undefined as unknown as T;
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new Error(
      `${source} malformed JSON status=${status} content_type=${contentType} body_length=${bodyLength}`,
    );
  }
}

async function readJson(response: Response, requireBody = true) {
  return await safeReadJson(response, "Supabase", { requireBody });
}

export async function claimQueue(
  config: SupabaseConfig,
  workerId: string,
  claimId: string,
  limit: number,
  leaseSeconds: number,
): Promise<QueueItem[]> {
  const response = await fetch(
    `${config.url}/rest/v1/rpc/claim_topic_processing_articles`,
    {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        p_limit: limit,
        p_worker_id: workerId,
        p_claim_id: claimId,
        p_lease_seconds: leaseSeconds,
      }),
    },
  );
  return await readJson(response, true) as QueueItem[];
}

export async function markProcessingStarted(
  config: SupabaseConfig,
  claimId: string,
  articleIds: string[],
  at: string,
) {
  if (articleIds.length === 0) return;
  const response = await fetch(
    `${config.url}/rest/v1/topic_processing_queue?claim_id=eq.${
      encodeURIComponent(claimId)
    }`,
    {
      method: "PATCH",
      headers: { ...headers(config), Prefer: "return=minimal" },
      body: JSON.stringify({ processing_started_at: at }),
    },
  );
  await readJson(response, false);
}

export async function markExternalApiStarted(
  config: SupabaseConfig,
  claimId: string,
  articleIds: string[],
  at: string,
) {
  if (articleIds.length === 0) return;
  const ids = `(${
    articleIds.map((id) => `"${id.replaceAll('"', '\\"')}"`).join(",")
  })`;
  const response = await fetch(
    `${config.url}/rest/v1/topic_processing_queue?claim_id=eq.${
      encodeURIComponent(claimId)
    }&article_id=in.${
      encodeURIComponent(ids)
    }&processed_at=is.null&terminal_status=is.null`,
    {
      method: "PATCH",
      headers: { ...headers(config), Prefer: "return=minimal" },
      body: JSON.stringify({ external_api_started_at: at }),
    },
  );
  await readJson(response, false);
}

export async function markTerminal(
  config: SupabaseConfig,
  articleId: string,
  status: string,
  at: string,
) {
  const response = await fetch(
    `${config.url}/rest/v1/topic_processing_queue?article_id=eq.${
      encodeURIComponent(articleId)
    }`,
    {
      method: "PATCH",
      headers: { ...headers(config), Prefer: "return=minimal" },
      body: JSON.stringify({ terminal_status: status, processed_at: at }),
    },
  );
  await readJson(response, false);
}

export async function deferQueueArticle(
  config: SupabaseConfig,
  claimId: string,
  articleId: string,
  availableAt: string,
  expectedAttemptCount: number,
  nextAttemptCount: number,
  fetcher: typeof fetch = fetch,
) {
  const query = new URL(
    `${config.url}/rest/v1/topic_processing_queue`,
  );
  query.searchParams.set("article_id", `eq.${articleId}`);
  query.searchParams.set("claim_id", `eq.${claimId}`);
  query.searchParams.set("processed_at", "is.null");
  query.searchParams.set("terminal_status", "is.null");
  query.searchParams.set(
    "stage2_attempt_count",
    `eq.${expectedAttemptCount}`,
  );
  query.searchParams.set(
    "select",
    "article_id,stage2_attempt_count,available_at",
  );
  const response = await fetcher(query, {
    method: "PATCH",
    headers: { ...headers(config), Prefer: "return=representation" },
    body: JSON.stringify({
      queued_at: new Date().toISOString(),
      available_at: availableAt,
      stage2_attempt_count: nextAttemptCount,
      claimed_at: null,
      claim_id: null,
      worker_id: null,
      processing_started_at: null,
      external_api_started_at: null,
    }),
  });
  const rows = await safeReadJson<
    Array<{
      article_id: string;
      stage2_attempt_count: number;
      available_at: string;
    }>
  >(response, "Topic queue defer");
  if (rows.length !== 1 || rows[0].article_id !== articleId) {
    throw new Error("Topic queue defer lost its claim");
  }
  return rows[0];
}
