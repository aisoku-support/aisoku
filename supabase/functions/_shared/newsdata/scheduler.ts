import type { Config } from "./config.ts";

export interface V2State {
  quota_day: string;
  daily_credits: number;
  recent_fetches: number[];
  quota_exhausted_at: number | null;
  last_fetch_at: number | null;
  first_success_after_quota_exhausted: number | null;
  quota_reset_probe_started_at: number | null;
  next_normal_fetch_at?: number | null;
  next_tech_fetch_at?: number | null;
  next_subculture_fetch_at?: number | null;
  last_normal_fetch_at?: number | null;
  last_tech_fetch_at?: number | null;
  last_subculture_fetch_at?: number | null;
  normal_credits_used?: number;
  tech_credits_used?: number;
  subculture_credits_used?: number;
  tech_burst_credits_used?: number;
  subculture_burst_credits_used?: number;
  previous_day_quota_exhausted?: boolean;
  // 次に選ぶ取得モードの位置。normal → tech → subculture の循環に使う。
  rotation_index?: number;
}

export type RequestMode = "normal" | "subculture" | "tech";

export type SchedulerMode =
  | "normal"
  | "burn_down"
  | "early_burn_down"
  | "rate_limit_wait"
  | "quota_exhausted"
  | "quota_reset_probe"
  | "quota_reset_probe_failed"
  | "disabled"
  | "skipped_duplicate"
  | "wait";

export interface ScheduleDecision {
  shouldFetch: boolean;
  mode: SchedulerMode;
  requestMode: RequestMode;
  requestModes: RequestMode[];
  nextFetchAt: number | null;
  allowBeyondDailyLimit: boolean;
  reason?: string;
}

export function getJstDate(now: number): Date {
  return new Date(now + 9 * 3600000);
}

export function getQuotaDay(now: number, resetTimeStr: string): string {
  const jst = getJstDate(now);
  const [resetHour, resetMin] = resetTimeStr.split(":").map(Number);
  const date = new Date(jst);
  if (
    jst.getUTCHours() < resetHour ||
    (jst.getUTCHours() === resetHour && jst.getUTCMinutes() < resetMin)
  ) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().split("T")[0];
}

export function parseTime(timeStr: string, baseDate: Date): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  const d = new Date(baseDate);
  d.setUTCHours(hours, minutes, 0, 0);
  return d.getTime();
}

export function getScheduleInterval(now: number, cfg: Config): number {
  const jst = getJstDate(now);
  const timeNum = jst.getUTCHours() * 100 + jst.getUTCMinutes();
  for (const entry of cfg.schedule) {
    const [startH, startM] = entry.start.split(":").map(Number);
    const [endH, endM] = entry.end.split(":").map(Number);
    const startNum = startH * 100 + startM;
    const endNum = endH * 100 + endM;
    if (startNum < endNum) {
      if (timeNum >= startNum && timeNum < endNum) return entry.intervalMinutes;
    } else if (timeNum >= startNum || timeNum < endNum) {
      return entry.intervalMinutes;
    }
  }
  return 15;
}

function used(state: V2State, mode: RequestMode): number {
  if (mode === "normal") {
    return state.normal_credits_used ?? state.daily_credits;
  }
  return mode === "tech"
    ? state.tech_credits_used ?? 0
    : state.subculture_credits_used ?? 0;
}

function nextStored(
  state: V2State,
  mode: RequestMode,
): number | null | undefined {
  if (mode === "normal") return state.next_normal_fetch_at;
  return mode === "tech"
    ? state.next_tech_fetch_at
    : state.next_subculture_fetch_at;
}

function baseDueAt(
  now: number,
  state: V2State,
  cfg: Config,
  mode: RequestMode,
): number {
  const stored = nextStored(state, mode);
  if (stored === null) return now;
  if (stored !== undefined) return stored;
  const interval = mode === "normal"
    ? getScheduleInterval(now, cfg)
    : mode === "tech"
    ? cfg.techIntervalMinutes
    : cfg.subcultureIntervalMinutes;
  return state.last_fetch_at == null
    ? now
    : state.last_fetch_at + interval * 60000;
}

/** 旧V2 stateを、独立スケジュールへ一度だけ移行する。 */
export function initializeIndependentSchedule(
  now: number,
  state: V2State,
  cfg: Config,
): boolean {
  const baseline = state.last_fetch_at ?? now;
  const normalAt = baseline + getScheduleInterval(baseline, cfg) * 60000;
  const techAt = baseline + cfg.techIntervalMinutes * 60000;
  const subcultureAt = baseline + cfg.subcultureIntervalMinutes * 60000;
  let changed = false;
  if (state.next_normal_fetch_at === undefined) {
    state.next_normal_fetch_at = Math.max(now, normalAt);
    changed = true;
  }
  if (state.next_tech_fetch_at === undefined) {
    // 長時間停止後も3モードを同一Dispatcherで同時実行しない。
    state.next_tech_fetch_at = Math.max(now + 60000, techAt);
    changed = true;
  }
  if (state.next_subculture_fetch_at === undefined) {
    state.next_subculture_fetch_at = Math.max(now + 120000, subcultureAt);
    changed = true;
  }
  if (state.last_normal_fetch_at === undefined) {
    state.last_normal_fetch_at = state.last_fetch_at;
    changed = true;
  }
  if (state.last_tech_fetch_at === undefined) {
    state.last_tech_fetch_at = state.last_fetch_at;
    changed = true;
  }
  if (state.last_subculture_fetch_at === undefined) {
    state.last_subculture_fetch_at = state.last_fetch_at;
    changed = true;
  }
  return changed;
}

export function getNextFetchAtAfterRun(
  now: number,
  state: V2State,
  cfg: Config,
  requestMode: RequestMode,
  schedulerMode: SchedulerMode,
): number {
  if (requestMode === "tech") return now + cfg.techIntervalMinutes * 60000;
  if (requestMode === "subculture") {
    return now + cfg.subcultureIntervalMinutes * 60000;
  }
  if (schedulerMode !== "burn_down" && schedulerMode !== "early_burn_down") {
    return now + getScheduleInterval(now, cfg) * 60000;
  }

  const jst = getJstDate(now);
  const target = parseTime(cfg.targetExhaustTime, jst);
  const reset = parseTime(cfg.quotaResetTime, jst);
  const remaining = schedulerMode === "burn_down"
    ? cfg.dailyCreditLimit - state.daily_credits
    : cfg.normalBudget - used(state, "normal");
  if (remaining <= 0) {
    if (jst.getTime() < target) return now + (target - jst.getTime());
    return now + (jst.getTime() < reset ? 2 : 15) * 60000;
  }
  return now + Math.max(1, Math.floor((target - jst.getTime()) / remaining));
}

function result(
  shouldFetch: boolean,
  mode: SchedulerMode,
  requestModes: RequestMode[],
  nextFetchAt: number | null,
  allowBeyondDailyLimit = false,
): ScheduleDecision {
  return {
    shouldFetch,
    mode,
    requestMode: requestModes[0] ?? "normal",
    requestModes,
    nextFetchAt,
    allowBeyondDailyLimit,
  };
}

export function decide(
  now: number,
  state: V2State,
  cfg: Config,
): ScheduleDecision {
  const quotaDay = getQuotaDay(now, cfg.quotaResetTime);
  if (!cfg.enabled) return result(false, "disabled", [], null);
  if (state.quota_exhausted_at && state.quota_day === quotaDay) {
    return result(false, "quota_exhausted", [], null);
  }

  const windowStart = now - cfg.rateLimitWindowMinutes * 60000;
  const recentInWindow = state.recent_fetches.filter((t) => t > windowStart);
  if (recentInWindow.length >= cfg.rateLimitCredits) {
    return result(
      false,
      "rate_limit_wait",
      [],
      Math.min(...recentInWindow) + cfg.rateLimitWindowMinutes * 60000,
    );
  }

  if (state.quota_reset_probe_started_at && state.quota_day === quotaDay) {
    const elapsed = now - state.quota_reset_probe_started_at;
    if (elapsed > 3600000) {
      return result(false, "quota_reset_probe_failed", [], null);
    }
    const nextProbeAt = (state.last_fetch_at ?? 0) + 5 * 60000;
    const due = now >= nextProbeAt;
    return result(
      due,
      "quota_reset_probe",
      due ? ["normal"] : [],
      due ? null : nextProbeAt,
    );
  }

  const jst = getJstDate(now);
  const jstTime = jst.getTime();
  const todayReset = parseTime(cfg.quotaResetTime, jst);
  const interval = getScheduleInterval(now, cfg);
  const remainingDaily = cfg.dailyCreditLimit - state.daily_credits;
  const remainingNormal = cfg.normalBudget - used(state, "normal");

  let mode: SchedulerMode = "normal";
  // 通常スケジュールのみを使用する。quota日切替と09:00 Probeは上記で維持する。
  const allowBeyondDailyLimit = false;
  if (remainingDaily <= 0 && !allowBeyondDailyLimit) {
    return result(false, "wait", [], now + 15 * 60000);
  }

  const normalDueAt = baseDueAt(now, state, cfg, "normal");

  const candidates: Array<[RequestMode, number]> = [];
  if (remainingNormal > 0 && now >= normalDueAt) {
    candidates.push(["normal", normalDueAt]);
  }
  {
    const techDueAt = baseDueAt(now, state, cfg, "tech");
    const subcultureDueAt = baseDueAt(now, state, cfg, "subculture");
    if (
      used(state, "tech") - (state.tech_burst_credits_used ?? 0) <
        cfg.techBudget &&
      now >= techDueAt
    ) candidates.push(["tech", techDueAt]);
    if (
      used(state, "subculture") - (state.subculture_burst_credits_used ?? 0) <
        cfg.subcultureBudget &&
      now >= subcultureDueAt
    ) candidates.push(["subculture", subcultureDueAt]);
  }

  const priority: RequestMode[] = ["normal", "tech", "subculture"];
  const dueModes = new Set(candidates.map(([candidateMode]) => candidateMode));
  const rotationStart = ((state.rotation_index ?? 0) % priority.length +
    priority.length) % priority.length;
  let selectedMode: RequestMode | undefined;
  for (let offset = 0; offset < priority.length; offset++) {
    const candidate = priority[(rotationStart + offset) % priority.length];
    if (dueModes.has(candidate)) {
      selectedMode = candidate;
      break;
    }
  }
  const requestModes = selectedMode ? [selectedMode] : [];
  const future: number[] = [];
  if (remainingNormal > 0) future.push(normalDueAt);
  {
    if (
      used(state, "tech") - (state.tech_burst_credits_used ?? 0) <
        cfg.techBudget
    ) future.push(baseDueAt(now, state, cfg, "tech"));
    if (
      used(state, "subculture") -
          (state.subculture_burst_credits_used ?? 0) <
        cfg.subcultureBudget
    ) future.push(baseDueAt(now, state, cfg, "subculture"));
  }
  return result(
    requestModes.length > 0,
    mode,
    requestModes,
    requestModes.length > 0
      ? Math.min(...candidates.map(([, at]) => at))
      : future.length > 0
      ? Math.min(...future)
      : null,
    allowBeyondDailyLimit,
  );
}
