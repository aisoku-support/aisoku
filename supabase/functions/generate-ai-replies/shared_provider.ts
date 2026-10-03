import type { AiRateLimiter } from "../_shared/ai_rate_limit.ts";
export type Model =
  | "groq-120b"
  | "google-gemma"
  | "cloudflare-gemma"
  | "gemini-3.1"
  | "openrouter-nemotron";
export const PROVIDERS: Record<
  Model,
  {
    model: string;
    key: string;
    kind: "google" | "openai" | "cloudflare";
    url: string;
  }
> = {
  "groq-120b": {
    model: "openai/gpt-oss-120b",
    key: "GROQ_API_KEY",
    kind: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
  },
  "google-gemma": {
    model: "gemma-4-26b-a4b-it",
    key: "GEMINI_API_KEY",
    kind: "google",
    url: "",
  },
  "cloudflare-gemma": {
    model: "@cf/google/gemma-4-26b-a4b-it",
    key: "CLOUDFLARE_AI_API_TOKEN",
    kind: "cloudflare",
    url: "",
  },
  "gemini-3.1": {
    model: "gemini-3.1-flash-lite",
    key: "GEMINI_API_KEY",
    kind: "google",
    url: "",
  },
  "openrouter-nemotron": {
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    key: "OPENROUTER_API_KEY",
    kind: "openai",
    url: "https://openrouter.ai/api/v1/chat/completions",
  },
};

export function providerAvailable(
  model: Model,
  limiter: AiRateLimiter,
): boolean {
  return Boolean(limiter.env(PROVIDERS[model].key)) &&
    (model !== "cloudflare-gemma" ||
      Boolean(limiter.env("CLOUDFLARE_ACCOUNT_ID"))) &&
    (model !== "openrouter-nemotron");
}

export function providerRequest(
  model: Model,
  prompt: string,
  limiter: Pick<AiRateLimiter, "env">,
) {
  const p = PROVIDERS[model];
  const key = limiter.env(p.key);
  let url = p.url;
  let body: Record<string, unknown>;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (p.kind === "google") {
    url =
      `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent`;
    headers["x-goog-api-key"] = key!;
    body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.95,
        maxOutputTokens: 1200,
        ...(model === "gemini-3.1"
          ? { responseMimeType: "application/json" }
          : { thinkingConfig: { thinkingLevel: "MINIMAL" } }),
      },
    };
  } else {
    headers.Authorization = `Bearer ${key}`;
    body = {
      model: p.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.95,
      max_tokens: 1200,
      ...(model === "groq-120b" ? { reasoning_effort: "low" } : {}),
      ...(model === "openrouter-nemotron"
        ? {
          provider: {
            allow_fallbacks: false,
            max_price: { prompt: 0, completion: 0 },
          },
        }
        : {}),
    };
    if (p.kind === "cloudflare") {
      url = `https://api.cloudflare.com/client/v4/accounts/${
        encodeURIComponent(limiter.env("CLOUDFLARE_ACCOUNT_ID")!)
      }/ai/run/${p.model}`;
      delete body.model;
    }
  }
  return { url, headers, body };
}
