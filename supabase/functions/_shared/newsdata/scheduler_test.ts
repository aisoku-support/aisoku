import { config } from "./config.ts";
import {
  decide,
  getNextFetchAtAfterRun,
  getQuotaDay,
  getScheduleInterval,
  initializeIndependentSchedule,
  type RequestMode,
  type V2State,
} from "./scheduler.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("Quota Day resets at 09:00 JST", () => {
  equal(
    getQuotaDay(new Date("2026-09-05T23:59:00Z").getTime(), "09:00"),
    "2026-09-05",
  );
  equal(
    getQuotaDay(new Date("2026-09-06T00:00:00Z").getTime(), "09:00"),
    "2026-09-06",
  );
  equal(config.quotaResetTime, "09:00");
});

Deno.test("normal schedule matches every JST time band", () => {
  const cases: Array<[string, number]> = [
    ["2026-09-06T00:00:00Z", 24], // 09:00
    ["2026-09-06T03:59:00Z", 24], // 12:59
    ["2026-09-06T04:00:00Z", 32], // 13:00
    ["2026-09-06T05:00:00Z", 60], // 14:00
    ["2026-09-06T08:00:00Z", 28], // 17:00
    ["2026-09-06T15:00:00Z", 28], // 00:00
    ["2026-09-06T16:00:00Z", 60], // 01:00
    ["2026-09-06T20:00:00Z", 40], // 05:00
    ["2026-09-06T22:00:00Z", 28], // 07:00
    ["2026-09-06T23:00:00Z", 30], // 08:00
    ["2026-09-07T00:00:00Z", 24], // 09:00
  ];
  for (const [time, minutes] of cases) {
    equal(getScheduleInterval(new Date(time).getTime(), config), minutes);
  }
});

Deno.test("mode intervals and daily credit allocations are fixed", () => {
  equal(
    [
      config.intervalSeconds,
      config.techIntervalMinutes,
      config.subcultureIntervalMinutes,
    ],
    [300, 120, 180],
  );
  equal(
    [
      config.normalBudget,
      config.techBudget,
      config.subcultureBudget,
      config.dailyCreditLimit,
      config.techBurstReserve,
      config.subcultureBurstReserve,
      config.rateLimitCredits,
      config.rateLimitWindowMinutes,
      config.requestsPerFetch,
      config.maxBurstPages,
    ],
    [80, 12, 8, 100, 0, 0, 30, 15, 1, 1],
  );
});

Deno.test("normal next fetch uses the configured interval with spare credits", () => {
  const now = new Date("2026-09-05T22:00:00Z").getTime(); // 07:00 JST
  const state: V2State = {
    quota_day: "2026-09-05",
    daily_credits: 10,
    normal_credits_used: 10,
    tech_credits_used: 0,
    subculture_credits_used: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    last_fetch_at: now - 40 * 60000,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
    next_normal_fetch_at: now,
  };

  const decision = decide(now, state, config);
  equal([decision.shouldFetch, decision.requestModes], [true, ["normal"]]);
  equal(
    getNextFetchAtAfterRun(now, state, config, "normal", decision.mode),
    now + 28 * 60000,
  );
});

Deno.test("daily and 15-minute credit limits stop dispatch", () => {
  const now = new Date("2026-09-06T01:00:00Z").getTime();
  const base: V2State = {
    quota_day: "2026-09-06",
    daily_credits: 10,
    normal_credits_used: 10,
    tech_credits_used: 0,
    subculture_credits_used: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    last_fetch_at: now - 60 * 60000,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
    next_normal_fetch_at: now,
    next_tech_fetch_at: now,
    next_subculture_fetch_at: now,
  };

  const dailyLimited = decide(now, { ...base, daily_credits: 100 }, config);
  equal([dailyLimited.shouldFetch, dailyLimited.mode], [false, "wait"]);

  const rateLimited = decide(
    now,
    { ...base, recent_fetches: Array(30).fill(now - 1000) },
    config,
  );
  equal([rateLimited.shouldFetch, rateLimited.mode], [
    false,
    "rate_limit_wait",
  ]);
});

Deno.test("only one due mode is selected according to rotation_index", () => {
  const now = new Date("2026-09-06T01:00:00Z").getTime();
  const base: V2State = {
    quota_day: "2026-09-06",
    daily_credits: 0,
    normal_credits_used: 0,
    tech_credits_used: 0,
    subculture_credits_used: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    last_fetch_at: now - 10 * 60000,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
    next_normal_fetch_at: now,
    next_tech_fetch_at: now,
    next_subculture_fetch_at: now,
  };
  const modes: RequestMode[] = ["normal", "tech", "subculture"];
  for (let rotation = 0; rotation < modes.length; rotation++) {
    const decision = decide(now, { ...base, rotation_index: rotation }, config);
    equal(decision.requestModes, [modes[rotation]]);
    equal(decision.requestModes.length <= 1, true);
  }
});

Deno.test("5-minute dispatcher simulation respects all three schedules and 100 credits", () => {
  const start = new Date("2026-09-06T00:00:00Z").getTime(); // 09:00 JST
  const end = start + 24 * 60 * 60000;
  const state: V2State = {
    quota_day: "2026-09-06",
    daily_credits: 0,
    normal_credits_used: 0,
    tech_credits_used: 0,
    subculture_credits_used: 0,
    tech_burst_credits_used: 0,
    subculture_burst_credits_used: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    last_fetch_at: null,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
    next_normal_fetch_at: start,
    next_tech_fetch_at: start,
    next_subculture_fetch_at: start,
    rotation_index: 0,
  };
  const counts: Record<RequestMode, number> = {
    normal: 0,
    tech: 0,
    subculture: 0,
  };

  for (let now = start; now < end; now += config.intervalSeconds * 1000) {
    const decision = decide(now, state, config);
    equal(decision.requestModes.length <= 1, true);
    const mode = decision.requestModes[0];
    if (!mode) continue;

    counts[mode]++;
    state.daily_credits++;
    if (mode === "normal") state.normal_credits_used!++;
    if (mode === "tech") state.tech_credits_used!++;
    if (mode === "subculture") state.subculture_credits_used!++;
    const next = getNextFetchAtAfterRun(
      now,
      state,
      config,
      mode,
      decision.mode,
    );
    if (mode === "normal") state.next_normal_fetch_at = next;
    if (mode === "tech") state.next_tech_fetch_at = next;
    if (mode === "subculture") state.next_subculture_fetch_at = next;
    state.rotation_index = (["normal", "tech", "subculture"] as RequestMode[])
      .indexOf(mode) + 1;
    state.rotation_index %= 3;
    state.recent_fetches.push(now);
    state.last_fetch_at = now;
    equal(state.daily_credits <= config.dailyCreditLimit, true);
  }

  equal(counts.tech, 12);
  equal(counts.subculture, 8);
  equal(counts.normal, 42);
  equal(state.daily_credits, 62);
});

Deno.test("legacy state initializes independent schedules once", () => {
  const now = new Date("2026-09-06T01:00:00Z").getTime();
  const state: V2State = {
    quota_day: "2026-09-06",
    daily_credits: 40,
    normal_credits_used: 40,
    tech_credits_used: 0,
    subculture_credits_used: 0,
    recent_fetches: [],
    quota_exhausted_at: null,
    last_fetch_at: now - 4 * 60 * 60 * 1000,
    first_success_after_quota_exhausted: null,
    quota_reset_probe_started_at: null,
    rotation_index: 2,
  };
  equal(initializeIndependentSchedule(now, state, config), true);
  equal(state.next_normal_fetch_at, now);
  equal(state.next_tech_fetch_at, now + 60000);
  equal(state.next_subculture_fetch_at, now + 120000);
  equal(decide(now, state, config).requestModes, ["normal"]);
  equal(initializeIndependentSchedule(now, state, config), false);
});
