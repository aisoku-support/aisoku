import { topicConfig, type EmbeddingModel } from "./config.ts";
import type { SupabaseConfig } from "./queue.ts";

export type QuotaStatus = "available" | "exhausted" | "reset_pending";
export type QuotaState = { quota_day_pt: string; used_today: number; quota_exhausted_at: string | null; reset_probe_started_at: string | null; first_success_after_reset: string | null };
export const PT_TIME_ZONE = "America/Los_Angeles";

export function quotaDayPt(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function quotaStatus(state: QuotaState | null, now = new Date()): QuotaStatus {
  if (!state) return "available";
  const today = quotaDayPt(now);
  if (state.quota_day_pt !== today) {
    return state.quota_exhausted_at ? "reset_pending" : "available";
  }
  if (state.quota_exhausted_at) return "exhausted";
  if (state.reset_probe_started_at && !state.first_success_after_reset) return "reset_pending";
  return state.used_today >= topicConfig.embeddingInternalRpdLimit ? "exhausted" : "available";
}

export function classifyEmbedding429(body: unknown): "rpd" | "rpm" | "tpm" | "unknown" {
  const text = JSON.stringify(body ?? {}).toLowerCase();
  if (/daily|day|rpd|per.?day|quota.*exhaust|daily_limit/.test(text)) return "rpd";
  if (/tpm|tokens?.*minute|per.?minute.*token/.test(text)) return "tpm";
  if (/rpm|requests.?minute|request.*per.?minute/.test(text)) return "rpm";
  return "unknown";
}

export function isProbeDue(state: QuotaState, now = Date.now()) {
  return !state.reset_probe_started_at || now - Date.parse(state.reset_probe_started_at) >= topicConfig.embeddingResetProbeIntervalMs;
}

export function modelForQuota(model: EmbeddingModel) { return model; }

function dbHeaders(config: SupabaseConfig) {
  return { Authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey, "Content-Type": "application/json" };
}

export async function loadQuotaState(config: SupabaseConfig, model: EmbeddingModel): Promise<QuotaState | null> {
  const response = await fetch(`${config.url}/rest/v1/topic_embedding_quota_state?embedding_model=eq.${encodeURIComponent(model)}&select=quota_day_pt,used_today,quota_exhausted_at,reset_probe_started_at,first_success_after_reset`, { headers: dbHeaders(config) });
  if (!response.ok) throw new Error(`quota_state_read_failed:${response.status}`);
  const rows = await response.json() as QuotaState[];
  return rows[0] ?? null;
}

export async function reserveQuota(config: SupabaseConfig, model: EmbeddingModel, now = new Date()): Promise<{ allowed: boolean; status: string }> {
  const state = await loadQuotaState(config, model);
  const status = quotaStatus(state, now);
  if (status !== "available") return { allowed: false, status };
  const response = await fetch(`${config.url}/rest/v1/rpc/reserve_topic_embedding_quota`, { method: "POST", headers: dbHeaders(config), body: JSON.stringify({ p_embedding_model: model, p_quota_day_pt: quotaDayPt(now), p_internal_limit: topicConfig.embeddingInternalRpdLimit }) });
  if (!response.ok) throw new Error(`quota_reserve_failed:${response.status}`);
  const rows = await response.json() as Array<{ allowed: boolean; status: string }>;
  return rows[0] ?? { allowed: false, status: "unavailable" };
}

export async function markRpdExhausted(config: SupabaseConfig, model: EmbeddingModel) {
  const response = await fetch(`${config.url}/rest/v1/topic_embedding_quota_state?embedding_model=eq.${encodeURIComponent(model)}`, { method: "PATCH", headers: { ...dbHeaders(config), Prefer: "return=minimal" }, body: JSON.stringify({ quota_exhausted_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  if (!response.ok) throw new Error(`quota_exhausted_mark_failed:${response.status}`);
}

export type EmbeddingAttempt = { allowed: boolean; probe: boolean; status: string };
async function quotaRpc(config: SupabaseConfig, name: string, body: Record<string, unknown>) {
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, { method: "POST", headers: dbHeaders(config), body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`quota_rpc_failed:${name}:${response.status}`);
  const rows = await response.json() as Array<EmbeddingAttempt>;
  return rows[0] ?? { allowed: false, probe: false, status: "unavailable" };
}
export async function beginEmbeddingAttempt(config: SupabaseConfig, model: EmbeddingModel, now = new Date()): Promise<EmbeddingAttempt> {
  const state = await loadQuotaState(config, model);
  if (quotaStatus(state, now) === "reset_pending") {
    return await quotaRpc(config, "begin_topic_embedding_probe", { p_embedding_model: model, p_quota_day_pt: quotaDayPt(now), p_probe_interval_seconds: topicConfig.embeddingResetProbeIntervalMs / 1000 });
  }
  return { ...(await reserveQuota(config, model, now)), probe: false };
}
export async function completeEmbeddingProbe(config: SupabaseConfig, model: EmbeddingModel, success: boolean) {
  await quotaRpc(config, success ? "complete_topic_embedding_probe" : "fail_topic_embedding_probe", { p_embedding_model: model, p_quota_day_pt: quotaDayPt(), p_success: success });
}
