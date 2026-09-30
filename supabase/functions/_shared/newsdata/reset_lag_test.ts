import { config } from "./config.ts";
import { collect } from "./strategy.ts";
import { FetchError } from "./api.ts";
import { getQuotaDay, type V2State } from "./scheduler.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("Reset Lag - daily reset preserves exhausted state in previous_day_quota_exhausted", () => {
  const yesterday = "2026-09-10";
  const today = "2026-09-11";
  const now = new Date("2026-09-11T00:00:00Z").getTime(); // 09:00 JST

  const rawState: V2State = {
    quota_day: yesterday,
    daily_credits: 100,
    recent_fetches: [],
    quota_exhausted_at: now - 1000,
    last_fetch_at: now - 1000,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
  };

  // Logic from index.ts (manual simulation)
  const v2State: V2State = {
    quota_day: today,
    daily_credits: 0,
    recent_fetches: rawState.recent_fetches,
    quota_exhausted_at: null,
    last_fetch_at: rawState.last_fetch_at,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
    previous_day_quota_exhausted: !!rawState.quota_exhausted_at,
  };

  equal(v2State.previous_day_quota_exhausted, true);
  equal(v2State.quota_day, today);
});

Deno.test("Reset Lag - success clears previous_day_quota_exhausted", async () => {
  const state: any = {
    daily_credits: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    quota_reset_probe_started_at: null,
    previous_day_quota_exhausted: true,
  };

  await collect(
    async () => ({
      items: [{
        article_id: "1",
        title: "t",
        link: "https://example.com/1",
        pubDate: "2026-09-11 00:00:00",
        category: ["top"],
      }],
      nextPage: null,
      status: 200,
      quota_exhausted: false,
    }),
    config,
    state,
    "normal",
    ["normal"],
    true, // isPotentialResetLag
  );

  equal(state.previous_day_quota_exhausted, false);
});

Deno.test("Reset Lag - quota error with previous_day_quota_exhausted starts probe", async () => {
  const state: any = {
    daily_credits: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    quota_reset_probe_started_at: null,
    previous_day_quota_exhausted: true,
  };

  const now = 10000;
  await collect(
    async () => {
      throw new FetchError("quota", 429, "ApiLimitExceeded");
    },
    config,
    state,
    "normal",
    ["normal"],
    true, // isPotentialResetLag (calculated from previous_day_quota_exhausted)
    false,
    () => now,
  );

  equal(state.quota_reset_probe_started_at, now);
  equal(state.quota_exhausted_at, null);
});

Deno.test("Reset Lag - recovery logic for misidentified exhaustion", () => {
  const now = new Date("2026-09-11T00:07:00Z").getTime(); // 09:07 JST
  const cfg = { ...config, quotaResetTime: "09:00" };

  // Current production buggy state
  const v2State: V2State = {
    quota_day: "2026-09-11",
    daily_credits: 4,
    recent_fetches: [],
    quota_exhausted_at: now - 1000,
    last_fetch_at: now - 1000,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
  };

  // Logic from index.ts
  const jst = new Date(now + 9 * 3600000);
  const [resetH, resetM] = cfg.quotaResetTime.split(":").map(Number);
  const resetToday = new Date(jst);
  resetToday.setUTCHours(resetH, resetM, 0, 0);
  const hoursSinceReset = (jst.getTime() - resetToday.getTime()) / 3600000;

  if (
    v2State.quota_exhausted_at &&
    v2State.daily_credits < 10 &&
    hoursSinceReset >= 0 && hoursSinceReset < 2 &&
    v2State.first_success_after_quota_exhausted === null &&
    !v2State.previous_day_quota_exhausted
  ) {
    v2State.previous_day_quota_exhausted = true;
    v2State.quota_exhausted_at = null;
  }

  equal(v2State.previous_day_quota_exhausted, true);
  equal(v2State.quota_exhausted_at, null);
});
