import {
  type AiRepliesRequest,
  buildPrompt,
  inspectStrictReplies,
} from "../../../supabase/functions/generate-ai-replies/ai_replies.ts";

interface Env {
  TOPIC_PREGEN: DurableObjectNamespace;
  NOTIFICATION_SECRET: string;
  TOPIC_PREGEN_DIAGNOSTIC_SECRET: string;
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(time: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}
interface DurableObjectState {
  storage: DurableStorage;
}
type Target = {
  generation: number;
  topicId: string;
  title: string;
  facts: string[];
  newsUrl: string;
};
type StateData = {
  target: Target | null;
  attemptStarts: number[];
  attemptCount: number;
  status:
    | "idle"
    | "pending"
    | "attempting"
    | "retry_wait"
    | "failed"
    | "completed";
  lastErrorType: string | null;
  lastErrorMessage: string | null;
  lastHttpStatus: number | null;
  lastProviderHttpStatus: number | null;
  lastSaveHttpStatus: number | null;
  lastDiagnosticPhase: string | null;
  lastSseReadCompleted: boolean | null;
  lastSseCompletionConfirmed: boolean | null;
  lastSseEndMarkerSeen: boolean | null;
  lastModelFinishReason: string | null;
  lastCommentCount: number | null;
  lastCommentValidationReason: string | null;
  lastAttemptAt: number | null;
  completedAt: number | null;
  parserSucceeded: boolean | null;
  saveAttempted: boolean;
  saveSucceeded: boolean | null;
  diagnosticReplayCount: number;
  cooldownUntil: number;
  retryNotBefore: number;
  completedGeneration: number;
};
const initialState = (): StateData => ({
  target: null,
  attemptStarts: [],
  attemptCount: 0,
  status: "idle",
  lastErrorType: null,
  lastErrorMessage: null,
  lastHttpStatus: null,
  lastProviderHttpStatus: null,
  lastSaveHttpStatus: null,
  lastDiagnosticPhase: null,
  lastSseReadCompleted: null,
  lastSseCompletionConfirmed: null,
  lastSseEndMarkerSeen: null,
  lastModelFinishReason: null,
  lastCommentCount: null,
  lastCommentValidationReason: null,
  lastAttemptAt: null,
  completedAt: null,
  parserSucceeded: null,
  saveAttempted: false,
  saveSucceeded: null,
  diagnosticReplayCount: 0,
  cooldownUntil: 0,
  retryNotBefore: 0,
  completedGeneration: 0,
});
const retryableStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;
export function sanitizeProviderErrorMessage(
  message: unknown,
  sensitiveValues: string[] = [],
): string | null {
  if (typeof message !== "string") return null;
  const normalized = message.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ");
  let safe = normalized;
  const contentValues = sensitiveValues.filter((item) => item.length >= 4);
  for (const value of contentValues) {
    const excerptLength = Math.min(16, value.length);
    if (value.length >= 16) {
      for (let offset = 0; offset <= value.length - excerptLength; offset++) {
        if (normalized.includes(value.slice(offset, offset + excerptLength))) {
          return "Provider error message omitted because it contained request content.";
        }
      }
    }
  }
  for (
    const value of contentValues
      .sort((a, b) => b.length - a.length)
  ) {
    safe = safe.replaceAll(value, "[redacted]");
  }
  safe = safe
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token|secret)\s*[:=]\s*["']?)[^\s,"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:key|token|secret|access_token)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .trim();
  return safe ? safe.slice(0, 400) : null;
}
const parseRetryAfter = (value: string | null, now: number) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
};
export async function retryAtFor429(response: Response, now: number) {
  const headerRetry = parseRetryAfter(response.headers.get("Retry-After"), now);
  if (headerRetry != null) return Math.max(now + 1_000, headerRetry);
  try {
    const body = await response.clone().json() as {
      error?: { details?: Array<{ "@type"?: string; retryDelay?: string }> };
    };
    const detail = body.error?.details?.find((item) =>
      item["@type"]?.endsWith("google.rpc.RetryInfo")
    );
    const match = detail?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
    if (match) {
      return Math.max(
        now + 1_000,
        now + Math.ceil(Number(match[1]) * 1000),
      );
    }
  } catch { /* no structured retry hint */ }
  return null;
}
export function nextAttemptTime(
  starts: number[],
  now: number,
  retryAt?: number | null,
  random = Math.random,
) {
  const active = starts.filter((start) => now - start < 60_000);
  if (active.length >= 10) {
    return Math.max(now + 1, active[0] + 60_000, retryAt ?? 0);
  }
  if (retryAt != null) return Math.max(now + 1, retryAt);
  return now + 500 + Math.floor(random() * 2_501);
}
const equalSecret = (a: string, b: string) => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
};
const safeFacts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 40 &&
  value.every((fact) =>
    typeof fact === "string" && fact.trim().length > 0 && fact.length <= 500
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/status") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!env.TOPIC_PREGEN_DIAGNOSTIC_SECRET) {
        return new Response("Unavailable", { status: 503 });
      }
      if (
        !equalSecret(
          request.headers.get("Authorization") ?? "",
          `Bearer ${env.TOPIC_PREGEN_DIAGNOSTIC_SECRET}`,
        )
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = env.TOPIC_PREGEN.idFromName("singleton");
      return await env.TOPIC_PREGEN.get(id).fetch(
        new Request("https://coordinator/status"),
      );
    }
    if (url.pathname === "/internal/retry" && request.method === "POST") {
      if (!env.TOPIC_PREGEN_DIAGNOSTIC_SECRET) {
        return new Response("Unavailable", { status: 503 });
      }
      if (
        !equalSecret(
          request.headers.get("Authorization") ?? "",
          `Bearer ${env.TOPIC_PREGEN_DIAGNOSTIC_SECRET}`,
        )
      ) return new Response("Unauthorized", { status: 401 });
      const id = env.TOPIC_PREGEN.idFromName("singleton");
      return await env.TOPIC_PREGEN.get(id).fetch(
        new Request("https://coordinator/retry", { method: "POST" }),
      );
    }
    if (url.pathname === "/internal/rpc-check" && request.method === "POST") {
      if (!env.TOPIC_PREGEN_DIAGNOSTIC_SECRET) {
        return new Response("Unavailable", { status: 503 });
      }
      if (
        !equalSecret(
          request.headers.get("Authorization") ?? "",
          `Bearer ${env.TOPIC_PREGEN_DIAGNOSTIC_SECRET}`,
        )
      ) return new Response("Unauthorized", { status: 401 });
      const id = env.TOPIC_PREGEN.idFromName("singleton");
      return await env.TOPIC_PREGEN.get(id).fetch(
        new Request("https://coordinator/rpc-check", { method: "POST" }),
      );
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!env.NOTIFICATION_SECRET) {
      return new Response("Unavailable", { status: 503 });
    }
    if (
      !equalSecret(
        request.headers.get("Authorization") ?? "",
        `Bearer ${env.NOTIFICATION_SECRET}`,
      )
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (
      typeof body.topic_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(body.topic_id) ||
      typeof body.title !== "string" || body.title.length > 300 ||
      !safeFacts(body.facts)
    ) {
      return new Response("Invalid topic payload", { status: 400 });
    }
    const id = env.TOPIC_PREGEN.idFromName("singleton");
    return await env.TOPIC_PREGEN.get(id).fetch(
      new Request("https://coordinator/target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
};

export class TopicPregenCoordinator {
  private inFlight = false;
  private stateMutation: Promise<void> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (
      new URL(request.url).pathname === "/status" && request.method === "GET"
    ) {
      const data = await this.load();
      const alarmAt = await this.state.storage.getAlarm();
      const now = Date.now();
      return Response.json({
        topic_id: data.target?.topicId ?? null,
        generation: data.target?.generation ?? null,
        completed_generation: data.completedGeneration,
        attempts: data.attemptCount,
        rolling_window_attempts: data.attemptStarts.filter((at) =>
          now - at < 60_000
        ).length,
        status: data.status,
        last_error_type: data.lastErrorType,
        last_error_message: data.lastErrorMessage,
        last_http_status: data.lastHttpStatus,
        provider_http_status: data.lastProviderHttpStatus,
        save_http_status: data.lastSaveHttpStatus,
        last_diagnostic_phase: data.lastDiagnosticPhase,
        sse_read_completed: data.lastSseReadCompleted,
        sse_completion_confirmed: data.lastSseCompletionConfirmed,
        sse_end_marker_seen: data.lastSseEndMarkerSeen,
        model_finish_reason: data.lastModelFinishReason,
        comment_count: data.lastCommentCount,
        comment_validation_reason: data.lastCommentValidationReason,
        last_attempt_at: data.lastAttemptAt,
        completed_at: data.completedAt,
        parser_succeeded: data.parserSucceeded,
        save_attempted: data.saveAttempted,
        save_succeeded: data.saveSucceeded,
        diagnostic_replays: data.diagnosticReplayCount,
        alarm_scheduled: alarmAt != null,
        alarm_at: alarmAt,
        retry_not_before: data.retryNotBefore,
        cooldown_until: data.cooldownUntil,
      });
    }
    if (
      new URL(request.url).pathname === "/retry" && request.method === "POST"
    ) {
      const data = await this.load();
      const target = data.target;
      if (
        !target || data.completedGeneration < target.generation ||
        data.saveSucceeded === true || data.diagnosticReplayCount >= 1 ||
        (await this.state.storage.getAlarm()) != null
      ) return Response.json({ accepted: false }, { status: 409 });
      data.completedGeneration = target.generation - 1;
      data.diagnosticReplayCount++;
      data.status = "pending";
      data.lastErrorType = null;
      data.lastErrorMessage = null;
      data.lastHttpStatus = null;
      data.lastProviderHttpStatus = null;
      data.lastSaveHttpStatus = null;
      data.lastDiagnosticPhase = null;
      data.lastSseReadCompleted = null;
      data.lastSseCompletionConfirmed = null;
      data.lastSseEndMarkerSeen = null;
      data.lastModelFinishReason = null;
      data.lastCommentCount = null;
      data.lastCommentValidationReason = null;
      data.parserSucceeded = null;
      data.saveAttempted = false;
      data.saveSucceeded = null;
      await this.state.storage.put("state", data);
      const alarmAt = Math.max(
        Date.now(),
        data.cooldownUntil,
        data.retryNotBefore,
      );
      await this.state.storage.setAlarm(alarmAt);
      return Response.json({
        accepted: true,
        generation: target.generation,
        alarm_at: alarmAt,
      });
    }
    if (
      new URL(request.url).pathname === "/rpc-check" &&
      request.method === "POST"
    ) {
      const target = (await this.load()).target;
      if (!target) {
        return Response.json({ rpc_http_status: null, rpc_authorized: false }, {
          status: 409,
        });
      }
      try {
        const result = await this.rpc<boolean>("save_topic_pregen_chunk", {
          p_topic_id: target.topicId,
          p_generation: target.generation,
          p_news_url: "",
          p_news_title: "",
          p_replies: [],
        });
        return Response.json({
          rpc_http_status: 200,
          rpc_authorized: true,
          empty_save_accepted: result,
        });
      } catch (error) {
        return Response.json({
          rpc_http_status:
            (error as Error & { httpStatus?: number }).httpStatus ?? null,
          rpc_authorized: false,
          error_type: "rpc_request_failed",
        });
      }
    }
    if (
      new URL(request.url).pathname !== "/target" || request.method !== "POST"
    ) {
      return new Response("Not found", { status: 404 });
    }
    let input: { topic_id?: unknown; title?: unknown; facts?: unknown };
    try {
      input = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (
      typeof input.topic_id !== "string" || typeof input.title !== "string" ||
      !safeFacts(input.facts)
    ) {
      return new Response("Invalid target", { status: 400 });
    }
    const registered = await this.rpc<
      Array<{
        generation: number;
        topic_id: string;
        title: string;
        facts: string[];
        news_url: string;
      }>
    >("register_topic_pregen_target", { p_topic_id: input.topic_id });
    const row = registered[0];
    if (!row) return Response.json({ accepted: false });
    const accepted = await this.locked(async () => {
      const data = await this.load();
      if (data.target && data.target.generation > row.generation) return false;
      data.target = {
        generation: Number(row.generation),
        topicId: row.topic_id,
        title: row.title,
        facts: row.facts,
        newsUrl: row.news_url,
      };
      data.status = "pending";
      data.lastErrorType = null;
      data.lastErrorMessage = null;
      data.lastHttpStatus = null;
      data.lastAttemptAt = null;
      data.completedAt = null;
      data.parserSucceeded = null;
      data.saveAttempted = false;
      data.saveSucceeded = null;
      data.attemptCount = 0;
      data.attemptStarts = [];
      await this.state.storage.put("state", data);
      return true;
    });
    if (!accepted) return Response.json({ accepted: false });
    const data = await this.load();
    await this.state.storage.setAlarm(
      Math.max(Date.now(), data.cooldownUntil, data.retryNotBefore),
    );
    return Response.json({ accepted: true });
  }

  async alarm(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.runAttempt();
    } catch {
      const data = await this.load();
      data.lastErrorType = "alarm_handler_error";
      data.status = "retry_wait";
      if (data.target && data.target.generation > data.completedGeneration) {
        await this.persistAndSchedule(
          data,
          nextAttemptTime(data.attemptStarts, Date.now()),
        );
      }
    } finally {
      this.inFlight = false;
      const data = await this.load();
      const scheduled = await this.state.storage.getAlarm();
      if (
        scheduled == null && data.target &&
        data.target.generation > data.completedGeneration
      ) {
        await this.state.storage.setAlarm(
          Math.max(Date.now() + 1, data.cooldownUntil),
        );
      }
    }
  }

  private async runAttempt() {
    const data = await this.load();
    const target = data.target;
    if (!target || target.generation <= data.completedGeneration) return;
    if (!this.env.GEMINI_API_KEY) {
      data.status = "failed";
      data.lastErrorType = "missing_api_key";
      await this.complete(data, target.generation);
      return;
    }
    const now = Date.now();
    data.attemptStarts = data.attemptStarts.filter((start) =>
      now - start < 60_000
    );
    const allowedAt = Math.max(
      data.cooldownUntil,
      data.retryNotBefore,
      data.attemptStarts.length >= 10 ? data.attemptStarts[0] + 60_000 : now,
    );
    if (allowedAt > now) {
      await this.persistAndSchedule(data, allowedAt);
      return;
    }
    data.attemptStarts.push(now);
    data.attemptCount++;
    data.lastAttemptAt = now;
    data.status = "attempting";
    data.lastErrorType = null;
    data.lastErrorMessage = null;
    data.lastHttpStatus = null;
    data.lastProviderHttpStatus = null;
    data.lastSaveHttpStatus = null;
    data.lastDiagnosticPhase = "http";
    data.lastSseReadCompleted = null;
    data.lastSseCompletionConfirmed = null;
    data.lastSseEndMarkerSeen = null;
    data.lastModelFinishReason = null;
    data.lastCommentCount = null;
    data.lastCommentValidationReason = null;
    const preparedState = await this.saveWithLatestTarget(data);
    if (
      !preparedState.target ||
      preparedState.target.generation !== target.generation
    ) {
      preparedState.attemptStarts = preparedState.attemptStarts.filter((
        start,
      ) => start !== now);
      await this.saveWithLatestTarget(preparedState);
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, preparedState.cooldownUntil),
      );
      return;
    }
    let prompt: string;
    try {
      const input: AiRepliesRequest = {
        mode: "sharedAi",
        newsTitle: target.title,
        articleBody: target.facts.join("\n"),
        count: 10,
        context: [],
        replyRelations: [],
      };
      prompt = buildPrompt(input);
    } catch {
      await this.complete(data, target.generation);
      return;
    }
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.95,
              maxOutputTokens: 1200,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingLevel: "minimal" },
            },
          }),
        },
      );
    } catch {
      data.lastErrorType = "network_error";
      data.lastDiagnosticPhase = "http";
      await this.scheduleRetry(data, null);
      return;
    }
    if (!response.ok) {
      data.lastHttpStatus = response.status;
      data.lastProviderHttpStatus = response.status;
      data.lastDiagnosticPhase = "http";
      let providerMessage: unknown;
      try {
        const errorBody = await response.clone().json() as {
          error?: { message?: unknown };
        };
        providerMessage = errorBody.error?.message;
      } catch {
        providerMessage = null;
      }
      data.lastErrorMessage = sanitizeProviderErrorMessage(
        providerMessage,
        [target.title, ...target.facts],
      );
      const retryable = retryableStatus(response.status);
      if (retryable) {
        data.lastErrorType = response.status === 429
          ? "rate_limited"
          : "provider_http_error";
        const retryAt = response.status === 429
          ? await retryAtFor429(response, Date.now()) ?? Date.now() + 60_000
          : null;
        if (response.status === 429) {
          data.retryNotBefore = Math.max(
            data.retryNotBefore,
            retryAt ?? Date.now() + 60_000,
          );
        }
        await this.scheduleRetry(data, retryAt);
      } else {
        data.status = "failed";
        data.lastErrorType = "http_error";
        await this.complete(data, target.generation);
      }
      return;
    }
    data.lastHttpStatus = response.status;
    data.lastProviderHttpStatus = response.status;
    data.lastDiagnosticPhase = "sse";
    let stream: SseCollection;
    try {
      stream = await collectSseText(response);
    } catch (error) {
      data.parserSucceeded = false;
      const diagnosticType = (error as Error & { diagnosticType?: string })
        .diagnosticType;
      data.lastDiagnosticPhase = diagnosticType === "sse_event_parse_failed"
        ? "sse_event_parse"
        : "sse_read";
      data.lastSseReadCompleted = false;
      data.lastSseCompletionConfirmed = false;
      data.lastSseEndMarkerSeen = false;
      data.lastErrorType = diagnosticType === "sse_event_parse_failed"
        ? diagnosticType
        : "sse_read_failed";
      data.status = "failed";
      await this.complete(data, target.generation);
      return;
    }
    data.lastSseReadCompleted = stream.readCompleted;
    data.lastSseEndMarkerSeen = stream.endMarkerSeen;
    data.lastModelFinishReason = stream.finishReason;
    data.lastSseCompletionConfirmed = stream.endMarkerSeen ||
      stream.finishReason !== null;
    if (stream.eventCount === 0) {
      data.parserSucceeded = false;
      data.lastDiagnosticPhase = "sse";
      data.lastErrorType = "sse_no_data_events";
      data.status = "failed";
      await this.complete(data, target.generation);
      return;
    }
    data.lastDiagnosticPhase = "model_json";
    const inspection = inspectStrictReplies(stream.text, 10);
    if (!inspection.ok) {
      data.parserSucceeded = false;
      data.lastCommentCount = inspection.actualCount ?? null;
      data.lastCommentValidationReason = inspection.reason.startsWith("comment_")
        ? inspection.reason
        : null;
      data.lastDiagnosticPhase = inspection.reason === "comment_count_too_few" ||
          inspection.reason === "comment_count_too_many"
        ? "comment_count"
        : inspection.reason.startsWith("comment_")
        ? "comment_validation"
        : "json_parse";
      data.lastErrorType = inspection.reason;
      data.status = "failed";
      await this.complete(data, target.generation);
      return;
    }
    const replies = inspection.replies;
    data.lastCommentCount = replies.length;
    data.parserSucceeded = true;
    data.cooldownUntil = Date.now() + 60_000;
    data.saveAttempted = true;
    data.lastDiagnosticPhase = "save";
    const cachedReplies = replies.map((text) => ({
      text,
      type: "ai",
      name: "名無しのAIさん",
      id: crypto.randomUUID(),
      replyTo: null,
      origin: "sharedAi",
    }));
    try {
      const saved = await this.rpc<boolean>("save_topic_pregen_chunk", {
        p_topic_id: target.topicId,
        p_generation: target.generation,
        p_news_url: target.newsUrl,
        p_news_title: target.title,
        p_replies: cachedReplies,
      });
      data.saveSucceeded = saved;
      if (!saved) {
        data.lastDiagnosticPhase = "save";
        data.lastErrorType = "atomic_save_rejected";
        data.status = "failed";
        await this.complete(data, target.generation);
        return;
      }
    } catch (error) {
      data.lastDiagnosticPhase = "save";
      const httpStatus = (error as Error & { httpStatus?: number }).httpStatus;
      data.lastHttpStatus = httpStatus ?? null;
      data.lastSaveHttpStatus = httpStatus ?? null;
      if (
        httpStatus != null && httpStatus >= 400 && httpStatus < 500 &&
        httpStatus !== 429
      ) {
        data.lastErrorType = "atomic_save_http_error";
        data.status = "failed";
        await this.complete(data, target.generation);
      } else {
        data.lastErrorType = "atomic_save_error";
        data.status = "retry_wait";
        await this.scheduleRetry(data, null);
      }
      return;
    }
    data.completedGeneration = Math.max(
      data.completedGeneration,
      target.generation,
    );
    data.completedAt = Date.now();
    data.status = "completed";
    data.lastErrorType = null;
    data.lastDiagnosticPhase = "complete";
    await this.saveWithLatestTarget(data);
    const afterSave = await this.load();
    if (
      afterSave.target &&
      afterSave.target.generation > afterSave.completedGeneration
    ) {
      await this.state.storage.setAlarm(
        Math.max(Date.now() + 1, afterSave.cooldownUntil),
      );
    }
  }

  private async scheduleRetry(data: StateData, retryAt: number | null) {
    data.status = "retry_wait";
    await this.persistAndSchedule(
      data,
      nextAttemptTime(data.attemptStarts, Date.now(), retryAt),
    );
  }
  private async complete(data: StateData, generation: number) {
    data.completedGeneration = Math.max(data.completedGeneration, generation);
    data.completedAt = Date.now();
    await this.saveWithLatestTarget(data);
  }
  private async load(): Promise<StateData> {
    const stored = await this.state.storage.get<Partial<StateData>>("state");
    return {
      ...initialState(),
      ...stored,
      attemptCount: stored?.attemptCount ?? stored?.attemptStarts?.length ?? 0,
      diagnosticReplayCount: stored?.diagnosticReplayCount ?? 0,
      attemptStarts: Array.isArray(stored?.attemptStarts)
        ? stored.attemptStarts
        : [],
      retryNotBefore: stored?.retryNotBefore ?? 0,
    };
  }
  private async save(data: StateData) {
    await this.state.storage.put("state", data);
  }
  private async saveWithLatestTarget(data: StateData) {
    return await this.locked(async () => {
      const latest = await this.load();
      if (
        latest.target &&
        (!data.target || latest.target.generation > data.target.generation)
      ) {
        data.target = latest.target;
      }
      await this.save(data);
      return data;
    });
  }
  private async persistAndSchedule(data: StateData, desiredAt: number) {
    await this.locked(async () => {
      const latest = await this.load();
      const switched = latest.target && data.target &&
        latest.target.generation > data.target.generation;
      if (switched) data.target = latest.target;
      await this.save(data);
      await this.state.storage.setAlarm(
        switched
          ? Math.max(
            Date.now() + 1,
            data.cooldownUntil,
            data.retryNotBefore,
          )
          : desiredAt,
      );
    });
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.stateMutation;
    this.stateMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  private async rpc<T>(name: string, body: unknown): Promise<T> {
    const response = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw Object.assign(new Error(`rpc_${name}_failed`), {
        httpStatus: response.status,
      });
    }
    return await response.json() as T;
  }
}

type SseCollection = {
  text: string;
  eventCount: number;
  endMarkerSeen: boolean;
  finishReason: string | null;
  readCompleted: boolean;
};

async function collectSseText(response: Response): Promise<SseCollection> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw Object.assign(new Error("sse_read_failed"), {
      diagnosticType: "sse_read_failed",
    });
  }
  const parts: string[] = [];
  let eventCount = 0;
  let endMarkerSeen = false;
  let finishReason: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      endMarkerSeen = true;
      continue;
    }
    let event: {
      candidates?: Array<{
        finishReason?: unknown;
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    try {
      event = JSON.parse(payload);
    } catch {
      throw Object.assign(new Error("sse_event_parse_failed"), {
        diagnosticType: "sse_event_parse_failed",
      });
    }
    eventCount++;
    const candidate = event.candidates?.[0];
    if (
      typeof candidate?.finishReason === "string" &&
      /^[A-Za-z0-9_-]{1,40}$/.test(candidate.finishReason)
    ) finishReason = candidate.finishReason;
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return {
    text: parts.join(""),
    eventCount,
    endMarkerSeen,
    finishReason,
    readCompleted: true,
  };
}
