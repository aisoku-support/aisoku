export const topicConfig = {
  batchSize: 1,
  embeddingDimensions: 384,
  lookbackHours: 24,
  similarityThresholds: {
    "gemini-embedding-001": 0.88,
    "gemini-embedding-2": 0.88,
    "openai/text-embedding-3-small:1536:v1": 0.88,
  },
  candidateLimit: 1,
  claimLeaseSeconds: 15 * 60,
  authHeader: "x-topic-processing-secret",
  authSecretEnv: "TOPIC_PROCESSING_SECRET",
  gemmaApiKeyEnv: "GEMINI_API_KEY",
  gemmaModel: "gemma-4-26b-a4b-it",
  groqApiKeyEnv: "GROQ_API_KEY",
  groqApiUrl: "https://api.groq.com/openai/v1/chat/completions",
  groqStage1Models: {
    morning: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
    afternoon: ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  },
  groqStage1TimeoutMs: 30_000,
  groqStage1MaxOutputTokens: 512,
  gemmaTimeoutMs: 30_000,
  gemmaClassificationMaxOutputTokens: 512,
  gemmaFactsMaxOutputTokens: 512,
  topicPublishMinimumFacts: 1,
  threadTitleModel: "gemini-3.5-flash-lite",
  threadTitleThinkingLevel: "medium",
  threadTitleTimeoutMs: 30_000,
  threadTitleMaxRetries: 1,
  threadTitleMaxRetryAfterMs: 60_000,
  threadTitleMaxOutputTokens: 8192,
  threadTitleBatchSize: 4,
  threadTitleMinStartIntervalMs: 4_100,
  threadTitleInternalRpdLimit: 490,
  threadTitleResetProbeIntervalMs: 5 * 60 * 1000,
  // Legacy diagnostic helper compatibility; no production path uses these.
  gemmaThreadTitleTimeoutMs: 30_000,
  gemmaThreadTitleTimeoutRetries: 0,
  gemmaThreadTitleMaxOutputTokens: 96,
  embeddingTimeoutMs: 60_000,
  embeddingInternalRpdLimit: 990,
  embeddingResetProbeIntervalMs: 5 * 60 * 1000,
  categoryEmbeddingModels: {
    "\u30c8\u30ec\u30f3\u30c9": "gemini-embedding-2",
    "\u30a8\u30f3\u30bf\u30e1": "gemini-embedding-2",
    "\u30b5\u30d6\u30ab\u30eb": "gemini-embedding-001",
    "\u30de\u30cd\u30fc": "gemini-embedding-001",
    "IT\u30fb\u30ac\u30b8\u30a7\u30c3\u30c8": "gemini-embedding-001",
  },
} as const;
export type EmbeddingModel = "gemini-embedding-001" | "gemini-embedding-2";
export function embeddingModelForCategory(
  category: string,
): EmbeddingModel | null {
  return topicConfig
    .categoryEmbeddingModels[
      category as keyof typeof topicConfig.categoryEmbeddingModels
    ] ?? null;
}
export function embeddingVersionForModel(model: EmbeddingModel) {
  return `${model}:384:v1`;
}
export function isAuthorized(request: Request, secret: string | undefined) {
  return Boolean(secret) &&
    request.headers.get(topicConfig.authHeader) === secret;
}

export function withTopicProcessingAuth(
  getSecret: () => string | undefined,
  handler: (request: Request) => Promise<Response>,
) {
  return async (request: Request) => {
    if (!isAuthorized(request, getSecret())) {
      return new Response("Unauthorized", { status: 401 });
    }
    return await handler(request);
  };
}
