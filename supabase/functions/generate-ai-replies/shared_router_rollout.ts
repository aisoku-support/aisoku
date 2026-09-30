const TOPIC_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEST_TOPICS = 10;
const ROUTER_MODELS = [
  "groq-120b",
  "google-gemma",
  "cloudflare-gemma",
  "gemini-3.1",
  "openrouter-nemotron",
] as const;
export type RolloutModel = typeof ROUTER_MODELS[number];

type Rollout = {
  enabled: boolean;
  allowedTopicIds: string[];
  singleModel?: RolloutModel;
};

/** Invalid or overly broad rollout settings always keep the router off. */
export function sharedRouterDecision(
  topicId: string,
  raw?: string,
): { allowed: boolean; singleModel?: RolloutModel } {
  if (!TOPIC_ID.test(topicId) || !raw) return { allowed: false };
  try {
    const value = JSON.parse(raw) as Partial<Rollout>;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { allowed: false };
    }
    if (
      Object.keys(value).some((key) =>
        key !== "enabled" && key !== "allowedTopicIds" &&
        key !== "singleModel"
      )
    ) return { allowed: false };
    if (typeof value.enabled !== "boolean") return { allowed: false };
    const ids = value.allowedTopicIds ?? [];
    if (
      !Array.isArray(ids) || ids.length > MAX_TEST_TOPICS ||
      ids.some((id) => typeof id !== "string" || !TOPIC_ID.test(id))
    ) return { allowed: false };
    if (
      value.singleModel !== undefined &&
      (value.enabled || !ROUTER_MODELS.includes(value.singleModel) ||
        ids.length !== 1 || ids[0]?.toLowerCase() !== topicId.toLowerCase())
    ) return { allowed: false };
    const allowed = value.enabled ||
      ids.some((id) => id.toLowerCase() === topicId.toLowerCase());
    return {
      allowed,
      ...(allowed && value.singleModel
        ? { singleModel: value.singleModel }
        : {}),
    };
  } catch {
    return { allowed: false };
  }
}

/** Compatibility helper for callers that only need the rollout gate. */
export function sharedRouterAllowed(topicId: string, raw?: string): boolean {
  return sharedRouterDecision(topicId, raw).allowed;
}
