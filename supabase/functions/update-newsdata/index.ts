import { createApi } from "../_shared/newsdata/api.ts";
import { keys, resolveConfig } from "../_shared/newsdata/config.ts";
import { collect } from "../_shared/newsdata/strategy.ts";
import {
  acquire,
  getV2State,
  Redis,
  release,
  saveArticles,
  saveLog,
  saveV2State,
} from "../_shared/newsdata/store.ts";
import { enqueueNewArticlesSafely } from "../_shared/newsdata/topic_enqueue.ts";
import {
  decide,
  getNextFetchAtAfterRun,
  getQuotaDay,
  initializeIndependentSchedule,
  type RequestMode,
  type V2State,
} from "../_shared/newsdata/scheduler.ts";

Deno.serve(async (request: Request) => {
  const secret = Deno.env.get("NEWSDATA_JOB_SECRET");
  if (!secret || request.headers.get("x-newsdata-job-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  let trigger: string;
  try {
    const body = await request.json();
    if (!["cron", "manual", "manual_test"].includes(body.trigger)) {
      throw new Error();
    }
    trigger = body.trigger;
  } catch {
    return new Response("Invalid trigger", { status: 400 });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const redis = new Redis(
    Deno.env.get("UPSTASH_REDIS_REST_URL")!,
    Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
  );

  try {
    // 1. Resolve Config and State
    const cfg = resolveConfig(
      await redis.command<string | null>("GET", keys.settings),
    );

    const rawState = await getV2State(redis);
    const quotaDay = getQuotaDay(now, cfg.quotaResetTime);
    const wasExhausted = !!rawState?.quota_exhausted_at;

    const v2State: V2State = rawState && rawState.quota_day === quotaDay
      ? rawState
      : {
        quota_day: quotaDay,
        daily_credits: 0,
        recent_fetches: rawState?.recent_fetches || [],
        quota_exhausted_at: null, // Reset for new quota day
        last_fetch_at: rawState?.last_fetch_at || null,
        first_success_after_quota_exhausted: null,
        quota_reset_probe_started_at: null, // Reset for new quota day
        next_normal_fetch_at: null,
        next_tech_fetch_at: null,
        next_subculture_fetch_at: null,
        last_normal_fetch_at: null,
        last_tech_fetch_at: null,
        last_subculture_fetch_at: null,
        normal_credits_used: 0,
        tech_credits_used: 0,
        subculture_credits_used: 0,
        tech_burst_credits_used: 0,
        subculture_burst_credits_used: 0,
        previous_day_quota_exhausted: !!rawState?.quota_exhausted_at,
        rotation_index: rawState?.rotation_index || 0,
      };

    if (v2State.rotation_index === undefined) v2State.rotation_index = 0;
    v2State.normal_credits_used ??= v2State.daily_credits;
    v2State.tech_credits_used ??= 0;
    v2State.subculture_credits_used ??= 0;
    v2State.tech_burst_credits_used ??= 0;
    v2State.subculture_burst_credits_used ??= 0;

    // 旧stateに独立時刻がない場合だけ、初回Dispatcherで移行して保存する。
    // staleな共通last_fetch_atから3モードを同時実行させない。
    const migratedIndependentSchedule = rawState &&
        rawState.quota_day === quotaDay
      ? initializeIndependentSchedule(now, v2State, cfg)
      : false;

    let stateChanged = migratedIndependentSchedule;

    // 一般化したリカバリロジック:
    // 本日すでに quota_exhausted_at が設定されているが、当日クレジット消費が少なく、
    // かつリセット時刻から6時間以内、かつ本日一度も成功していない場合、
    // 前日のリセット遅延による誤判定とみなしてリカバリする。
    const jst = new Date(now + 9 * 3600000);
    const [resetH, resetM] = cfg.quotaResetTime.split(":").map(Number);
    const resetToday = new Date(jst);
    resetToday.setUTCHours(resetH, resetM, 0, 0);
    const hoursSinceReset = (jst.getTime() - resetToday.getTime()) / 3600000;

    if (
      v2State.quota_exhausted_at &&
      v2State.daily_credits < 10 &&
      hoursSinceReset >= 0 && hoursSinceReset < 6 &&
      v2State.first_success_after_quota_exhausted === null &&
      !v2State.previous_day_quota_exhausted
    ) {
      v2State.previous_day_quota_exhausted = true;
      v2State.quota_exhausted_at = null;
      stateChanged = true;
    }

    if (stateChanged) await saveV2State(redis, v2State);

    const isPotentialResetLag = v2State.previous_day_quota_exhausted === true &&
      v2State.first_success_after_quota_exhausted === null;

    // 2. Decide
    const decision = decide(now, v2State, cfg);

    // Manual trigger bypasses scheduler decision (but still respects locks and credit counts)
    if (
      !decision.shouldFetch &&
      (trigger === "cron" || decision.mode === "disabled")
    ) {
      // Dispatcher Wait: Minimal logging/redis access
      // We don't save a job log for every minute skip unless it's a mode change or specific event.
      // But the prompt says "必要であれば異常・モード切替・実API request時のみ詳細ログを残してください。"
      if (
        rawState?.quota_exhausted_at !== v2State.quota_exhausted_at
      ) {
        // Log special events
      }
      return Response.json({
        state: "wait",
        mode: decision.mode,
        nextFetchAt: decision.nextFetchAt,
      });
    }

    // 3. Execution Lock
    let locked = false;
    if (!(locked = await acquire(redis, cfg, id, now))) {
      return Response.json({ state: "skipped_duplicate" });
    }

    try {
      const base = {
        run_id: id,
        trigger,
        run_started_at: new Date(now).toISOString(),
      };

      const apiKey = Deno.env.get("NEWSDATA_API_KEY");
      if (!apiKey) throw new Error("Missing API configuration");

      let topicEnqueued = 0;
      let topicEnqueueFailed = 0;
      const { log } = await collect(
        createApi(apiKey, cfg),
        cfg,
        v2State,
        decision.mode,
        decision.requestModes.length > 0
          ? decision.requestModes
          : [decision.requestMode],
        isPotentialResetLag,
        decision.allowBeyondDailyLimit,
        undefined, // use default clock
        async (groups) => {
          const saved = await saveArticles(redis, groups, cfg);
          const topic = await enqueueNewArticlesSafely(saved.new_article_ids);
          topicEnqueued += topic.topic_enqueued;
          topicEnqueueFailed += topic.topic_enqueue_failed;
          if (topic.topic_enqueue_failed > 0) {
            console.error("[NewsData] Topic enqueue failure", {
              runId: id,
              count: topic.topic_enqueue_failed,
            });
          }
          return saved;
        },
        (snapshot) =>
          saveLog(
            redis,
            id,
            { ...snapshot, ...base, state: "running" },
            cfg,
            now,
          ),
        trigger === "manual_test",
      );

      Object.assign(log, base);
      Object.assign(log, {
        topic_enqueued: topicEnqueued,
        topic_enqueue_failed: topicEnqueueFailed,
      });

      const executedModes = new Set(
        log.requests.map((entry) => entry.request_mode as RequestMode),
      );
      for (const requestMode of executedModes) {
        const modeOrder: RequestMode[] = ["normal", "tech", "subculture"];
        v2State.rotation_index = (modeOrder.indexOf(requestMode) + 1) %
          modeOrder.length;
        const next = getNextFetchAtAfterRun(
          now,
          v2State,
          cfg,
          requestMode,
          decision.mode,
        );
        if (requestMode === "normal") {
          v2State.next_normal_fetch_at = next;
          v2State.last_normal_fetch_at = now;
        } else if (requestMode === "tech") {
          v2State.next_tech_fetch_at = next;
          v2State.last_tech_fetch_at = now;
        } else {
          v2State.next_subculture_fetch_at = next;
          v2State.last_subculture_fetch_at = now;
        }
      }

      // Update first_success_after_quota_exhausted
      if (wasExhausted && !v2State.quota_exhausted_at) {
        v2State.first_success_after_quota_exhausted = now;
      }

      log.run_finished_at = new Date().toISOString();
      log.elapsed_ms = Date.now() - now;

      v2State.last_fetch_at = now;
      Object.assign(log, {
        quota_day: v2State.quota_day,
        next_fetch_at: v2State.next_normal_fetch_at ?? null,
        next_tech_fetch_at: v2State.next_tech_fetch_at ?? null,
        next_subculture_fetch_at: v2State.next_subculture_fetch_at ?? null,
        normal_credits_used: v2State.normal_credits_used,
        tech_credits_used: v2State.tech_credits_used,
        subculture_credits_used: v2State.subculture_credits_used,
      });
      await saveV2State(redis, v2State);

      await saveLog(
        redis,
        id,
        { ...log, state: log.stopped_by_error ? "error" : "completed" },
        cfg,
        now,
      );

      return Response.json({ run_id: id, ...log });
    } finally {
      if (locked) await release(redis, id);
    }
  } catch (err) {
    console.error("[NewsData] job failure", id, err);
    return Response.json({ run_id: id, error: "infrastructure" }, {
      status: 500,
    });
  }
});
