import { FetchError, type FetchPage } from "./api.ts";
import type { Config } from "./config.ts";
import { type Article, deduplicate, normalize } from "./normalize.ts";
import type { RequestMode, SchedulerMode, V2State } from "./scheduler.ts";

export function createLog(started: number) {
  return {
    run_started_at: new Date(started).toISOString(),
    run_finished_at: "",
    hour_key: new Date(started).toISOString().slice(0, 13),
    trigger: "manual",
    scheduler_mode: "normal" as SchedulerMode,
    requested_requests: 0,
    successful_requests: 0,
    raw_fetched: 0,
    unique_in_run: 0,
    already_known: 0,
    new_articles: 0,
    stopped_by_error: false,
    error_request_index: null as number | null,
    error_type: null as string | null,
    error_status: null as number | null,
    error_code: null as string | null,
    error_message: null as string | null,
    elapsed_ms: 0,
    credits_counted: 0,
    daily_credits_used: 0,
    requests: [] as Record<string, unknown>[],
  };
}

function incrementModeCredit(
  state: V2State,
  mode: RequestMode,
  burst: boolean,
) {
  if (mode === "normal") {
    state.normal_credits_used =
      (state.normal_credits_used ?? state.daily_credits - 1) + 1;
  } else if (mode === "tech") {
    state.tech_credits_used = (state.tech_credits_used ?? 0) + 1;
    if (burst) {
      state.tech_burst_credits_used = (state.tech_burst_credits_used ?? 0) + 1;
    }
  } else {
    state.subculture_credits_used = (state.subculture_credits_used ?? 0) + 1;
    if (burst) {
      state.subculture_burst_credits_used =
        (state.subculture_burst_credits_used ?? 0) + 1;
    }
  }
}

function canStartMode(state: V2State, cfg: Config, mode: RequestMode): boolean {
  if (mode === "normal") return true;
  const total = mode === "tech"
    ? state.tech_credits_used ?? 0
    : state.subculture_credits_used ?? 0;
  const burst = mode === "tech"
    ? state.tech_burst_credits_used ?? 0
    : state.subculture_burst_credits_used ?? 0;
  const budget = mode === "tech" ? cfg.techBudget : cfg.subcultureBudget;
  return total - burst < budget;
}

function canUseBurst(state: V2State, cfg: Config, mode: RequestMode): boolean {
  const used = mode === "tech"
    ? state.tech_burst_credits_used ?? 0
    : state.subculture_burst_credits_used ?? 0;
  const reserve = mode === "tech"
    ? cfg.techBurstReserve
    : cfg.subcultureBurstReserve;
  return used < reserve;
}

export async function collect(
  fetchPage: FetchPage,
  cfg: Config,
  v2State: V2State,
  mode: SchedulerMode,
  requestModes: RequestMode[],
  isPotentialResetLag: boolean,
  allowBeyondDailyLimit = false,
  clock = Date.now,
  save?: (
    groups: Article[][],
  ) => Promise<{ new_articles: number; already_known: number }>,
  checkpoint?: (log: ReturnType<typeof createLog>) => Promise<void>,
  singleRequestMode = false,
) {
  const log = createLog(clock());
  log.scheduler_mode = mode;
  log.daily_credits_used = v2State.daily_credits;
  const articles: Article[] = [];

  modeLoop:
  for (const requestMode of requestModes) {
    if (!canStartMode(v2State, cfg, requestMode)) continue;
    let page: string | null = null;
    const pages = new Set<string>();
    const maxPages = Math.min(
      requestMode === "normal" ? 1 : cfg.maxBurstPages,
      cfg.requestsPerFetch,
    );

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const isBurstPage = pageIndex > 1;
      if (isBurstPage && !canUseBurst(v2State, cfg, requestMode)) break;

      const start = clock();
      const windowStart = start - cfg.rateLimitWindowMinutes * 60000;
      const recentInWindow = v2State.recent_fetches.filter((t) =>
        t > windowStart
      );
      if (
        recentInWindow.length >= cfg.rateLimitCredits ||
        (v2State.daily_credits >= cfg.dailyCreditLimit &&
          !allowBeyondDailyLimit)
      ) break modeLoop;

      const request: Record<string, unknown> = {
        request_index: log.requested_requests + 1,
        request_mode: requestMode,
        page_index: pageIndex,
        is_burst_page: isBurstPage,
        started_at: new Date(start).toISOString(),
        items: 0,
        new_items: 0,
        already_known_items: 0,
        status: "success",
        error_status: null,
        error_code: null,
        credits_counted: 1,
        daily_credits_used: 0,
        scheduler_mode: mode,
      };
      if (log.requested_requests >= cfg.requestsPerFetch) break modeLoop;
      log.requested_requests++;
      log.credits_counted++;
      v2State.daily_credits++;
      incrementModeCredit(v2State, requestMode, isBurstPage);
      v2State.recent_fetches.push(start);
      if (v2State.recent_fetches.length > 100) v2State.recent_fetches.shift();

      try {
        if (checkpoint) await checkpoint(log);
        const response = await fetchPage(page, requestMode);
        request.items = response.items.length;
        request.http_status = response.status;
        const remaining = cfg.maxItems - log.raw_fetched;
        const normalized = response.items.slice(0, remaining).map((raw) =>
          normalize(raw, cfg, new Date(clock()).toISOString())
        );
        log.raw_fetched += response.items.length;
        const runGroups = deduplicate(normalized);
        if (save && runGroups.length > 0) {
          const counts = await save(runGroups);
          request.new_items = counts.new_articles;
          request.already_known_items = counts.already_known;
          log.new_articles += counts.new_articles;
          log.already_known += counts.already_known;
          log.unique_in_run += runGroups.length;
        } else {
          articles.push(...normalized);
          request.new_items = runGroups.length;
          log.new_articles += runGroups.length;
        }

        log.successful_requests++;
        v2State.quota_exhausted_at = null;
        v2State.quota_reset_probe_started_at = null;
        v2State.previous_day_quota_exhausted = false;
        const nextPage = response.nextPage;
        const isBurst = requestMode !== "normal" &&
          response.items.length === cfg.burstMinItems &&
          Number(request.new_items) === cfg.burstMinNewItems;
        if (!nextPage || !isBurst || pages.has(nextPage)) page = null;
        else {
          pages.add(nextPage);
          page = nextPage;
        }
      } catch (error) {
        const e = error instanceof FetchError
          ? error
          : new FetchError("internal");
        if (e.type === "quota") {
          if (isPotentialResetLag || v2State.quota_reset_probe_started_at) {
            v2State.quota_reset_probe_started_at ??= clock();
          } else {
            v2State.quota_exhausted_at = clock();
            v2State.quota_reset_probe_started_at = null;
          }
        }
        Object.assign(log, {
          stopped_by_error: true,
          error_request_index: request.request_index,
          error_type: e.type,
          error_status: e.status,
          error_code: e.code,
          error_message: e.message,
        });
        Object.assign(request, {
          status: "error",
          error_type: e.type,
          error_status: e.status,
          error_code: e.code,
          network_cause: e.networkCause,
          network_cause_name: e.networkCauseName,
          network_category: e.networkCategory,
          endpoint_host: e.endpointHost,
          timeout_ms: e.timeoutMs,
        });
      } finally {
        Object.assign(request, {
          finished_at: new Date(clock()).toISOString(),
          elapsed_ms: clock() - start,
          daily_credits_used: v2State.daily_credits,
        });
        log.requests.push(request);
        log.daily_credits_used = v2State.daily_credits;
      }
      if (checkpoint) await checkpoint(log);
      if (log.stopped_by_error) break modeLoop;
      if (log.requested_requests >= cfg.requestsPerFetch) break modeLoop;
      if (!page || log.raw_fetched >= cfg.maxItems) break;
    }
  }

  if (!save) {
    const groups = deduplicate(articles);
    log.unique_in_run = groups.length;
    return { groups, log };
  }
  return { groups: [], log };
}
