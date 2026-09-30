import {
  type EmbeddingModel,
  embeddingVersionForModel,
  topicConfig,
} from "./config.ts";
import type { GemmaResult } from "./gemma_parser.ts";
import { safeReadJson } from "./queue.ts";
import { classifyEmbedding429 } from "./quota.ts";

export type TopicEmbeddingResult = GemmaResult & {
  embedding: number[];
  embedding_version: string;
};
export type EmbeddingFailure = { articleId: string; errorType: string };
export type EmbeddingBatch = {
  results: TopicEmbeddingResult[];
  failures: EmbeddingFailure[];
  usage?: unknown;
  elapsedMs: number;
};

export async function embedTopicResults(
  results: GemmaResult[],
  apiKey = Deno.env.get(topicConfig.gemmaApiKeyEnv),
  fetcher = fetch,
  model: EmbeddingModel = "gemini-embedding-2",
): Promise<EmbeddingBatch> {
  if (results.length === 0) return { results: [], failures: [], elapsedMs: 0 };
  if (!apiKey) throw new Error("Embedding API key missing");
  const started = Date.now();
  const requests = results.map((result) => ({
    model: `models/${model}`,
    content: { parts: [{ text: result.topic_text }] },
    outputDimensionality: topicConfig.embeddingDimensions,
  }));
  const response = await fetcher(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(topicConfig.embeddingTimeoutMs),
      body: JSON.stringify({ requests }),
    },
  );

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.clone().json();
    } catch { /* body is intentionally not logged */ }
    const error = new Error(
      `Embedding HTTP failure status=${response.status}`,
    ) as Error & { embedding429Kind?: string };
    if (response.status === 429) {
      error.embedding429Kind = classifyEmbedding429(payload);
    }
    throw error;
  }
  const body = await safeReadJson<any>(response, "Embedding");
  const embeddings = body?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== results.length) {
    throw new Error("Embedding response count mismatch");
  }
  const output: TopicEmbeddingResult[] = [];
  const failures: EmbeddingFailure[] = [];
  embeddings.forEach((item: unknown, index: number) => {
    const values = item && typeof item === "object" &&
        Array.isArray((item as Record<string, unknown>).values)
      ? (item as Record<string, unknown>).values as unknown[]
      : null;
    const articleId = results[index].article_id;
    if (
      !values || values.length !== topicConfig.embeddingDimensions ||
      values.some((value) =>
        typeof value !== "number" || !Number.isFinite(value)
      )
    ) {
      failures.push({ articleId, errorType: "dimension_mismatch" });
      return;
    }
    output.push({
      ...results[index],
      embedding: values as number[],
      embedding_version: embeddingVersionForModel(model),
    });
  });
  return {
    results: output,
    failures,
    usage: body.usageMetadata,
    elapsedMs: Date.now() - started,
  };
}
