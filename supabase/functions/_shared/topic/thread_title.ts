import { topicConfig } from "./config.ts";

export type ThreadTitleInput = { id: string; subject: string; event: string };
export type ThreadTitleStatus =
  | "success"
  | "timeout"
  | "invalid_json"
  | "empty"
  | "schema_invalid"
  | "missing_id"
  | "duplicate_id"
  | "unknown_id"
  | "rate_limit"
  | "http_4xx"
  | "http_5xx"
  | "network_error";
export type ThreadTitleResult = {
  id: string;
  title: string | null;
  status: ThreadTitleStatus;
  lengthExceeded?: boolean;
};

const instruction =
  `あなたは5ch風の匿名ニュース掲示板で、ニューススレッドを立てる編集者です。

報道機関のニュース見出しではなく、掲示板ユーザーが思わず開きたくなるスレタイを作成してください。

【タイトルの構成】

ニュースの内容に合わせて、次の表現方法から最も面白くなるものを選んでください。

A. 意外な事実を短く言い切る
B. ニュースの内容に対して疑問を投げかける
C. 特徴的な数字や出来事を強調する
D. ニュースにツッコミを入れる
E. 普通のニュース見出しにする
F. その他、読者の興味を引く自由な表現

ニュースごとに自由に構成を選び、匿名掲示板らしいスレタイを作成してください。

【出力】
- 47文字以内。
- 各ニュースにつきタイトルは1つ。
- 指定されたJSON形式だけを返す。`;

export async function generateThreadTitles(
  input: ThreadTitleInput[],
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<
  {
    results: ThreadTitleResult[];
    httpStatus: number | null;
    durationMs: number;
    finishReason: string | null;
    usageMetadata: Record<string, unknown> | null;
    retryAfterMs: number | null;
  }
> {
  const started = Date.now();
  const failed = (
    status: ThreadTitleStatus,
    httpStatus: number | null,
    retryAfterMs: number | null = null,
  ) => ({
    results: input.map((x) => ({ id: x.id, title: null, status })),
    httpStatus,
    durationMs: Date.now() - started,
    finishReason: null,
    usageMetadata: null,
    retryAfterMs,
  });
  try {
    const response = await fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${topicConfig.threadTitleModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: AbortSignal.timeout(topicConfig.threadTitleTimeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ parts: [{ text: JSON.stringify({ topics: input }) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                titles: {
                  type: "array",
                  minItems: 4,
                  maxItems: 4,
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      thread_title: { type: "string" },
                    },
                    required: ["id", "thread_title"],
                  },
                },
              },
              required: ["titles"],
            },
            thinkingConfig: {
              thinkingLevel: topicConfig.threadTitleThinkingLevel,
            },
            temperature: 0,
            maxOutputTokens: topicConfig.threadTitleMaxOutputTokens,
          },
        }),
      },
    );
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("Retry-After"),
      );
      return failed(
        response.status === 429
          ? "rate_limit"
          : response.status >= 500
          ? "http_5xx"
          : "http_4xx",
        response.status,
        retryAfterMs,
      );
    }
    const body = await response.json();
    const text =
      body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) =>
        p.text ?? ""
      ).join("") ?? "";
    const finishReason = body?.candidates?.[0]?.finishReason ?? null;
    const usageMetadata = body?.usageMetadata ?? null;
    let parsed: { titles?: Array<{ id?: unknown; thread_title?: unknown }> };
    try {
      parsed = JSON.parse(
        text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
      );
    } catch {
      return failed("invalid_json", response.status);
    }
    if (!Array.isArray(parsed.titles)) {
      return {
        ...failed("schema_invalid", response.status),
        finishReason,
        usageMetadata,
      };
    }
    const expected = new Set(input.map((x) => x.id));
    const seen = new Set<string>();
    const byId = new Map<string, ThreadTitleResult>();
    for (const row of parsed.titles) {
      if (typeof row.id !== "string") continue;
      if (!expected.has(row.id)) {
        byId.set(row.id, { id: row.id, title: null, status: "unknown_id" });
        continue;
      }
      if (seen.has(row.id)) {
        byId.set(row.id, { id: row.id, title: null, status: "duplicate_id" });
        continue;
      }
      seen.add(row.id);
      if (typeof row.thread_title !== "string") {
        byId.set(row.id, { id: row.id, title: null, status: "schema_invalid" });
        continue;
      }
      const title = row.thread_title.trim();
      const lengthExceeded = Array.from(title).length > 47;
      byId.set(row.id, {
        id: row.id,
        title: title || null,
        status: title ? "success" : "empty",
        ...(lengthExceeded ? { lengthExceeded: true } : {}),
      });
    }
    return {
      results: input.map((x) =>
        byId.get(x.id) ?? { id: x.id, title: null, status: "missing_id" }
      ),
      httpStatus: response.status,
      durationMs: Date.now() - started,
      finishReason,
      usageMetadata,
      retryAfterMs: null,
    };
  } catch (error) {
    return failed(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "timeout"
        : "network_error",
      null,
    );
  }
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}
