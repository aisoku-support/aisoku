import { strictEqual } from "node:assert";
import { classifyEmbedding429, quotaDayPt, quotaStatus } from "./quota.ts";

Deno.test("PT quota day follows PST and PDT boundaries", () => {
  strictEqual(quotaDayPt(new Date("2026-01-15T07:59:59Z")), "2026-01-14");
  strictEqual(quotaDayPt(new Date("2026-01-15T08:00:00Z")), "2026-01-15");
  strictEqual(quotaDayPt(new Date("2026-07-15T06:59:59Z")), "2026-07-14");
  strictEqual(quotaDayPt(new Date("2026-07-15T07:00:00Z")), "2026-07-15");
});
Deno.test("previous-day exhausted becomes reset pending", () => {
  strictEqual(
    quotaStatus({
      quota_day_pt: "2026-01-14",
      used_today: 990,
      quota_exhausted_at: "2026-01-15T00:00:00Z",
      reset_probe_started_at: null,
      first_success_after_reset: null,
    }, new Date("2026-01-15T08:00:00Z")),
    "reset_pending",
  );
});
Deno.test("previous-day non-exhausted becomes available for normal rollover", () => {
  strictEqual(
    quotaStatus({
      quota_day_pt: "2026-01-14",
      used_today: 747,
      quota_exhausted_at: null,
      reset_probe_started_at: null,
      first_success_after_reset: null,
    }, new Date("2026-01-15T08:00:00Z")),
    "available",
  );
});
Deno.test("429 classification does not treat unknown/rpm/tpm as RPD", () => {
  strictEqual(
    classifyEmbedding429({
      reason: "RATE_LIMIT_EXCEEDED",
      metadata: { quotaMetric: "requests_per_minute" },
    }),
    "rpm",
  );
  strictEqual(classifyEmbedding429({ reason: "token_per_minute" }), "tpm");
  strictEqual(
    classifyEmbedding429({ reason: "RATE_LIMIT_EXCEEDED" }),
    "unknown",
  );
  strictEqual(classifyEmbedding429({ reason: "daily quota exhausted" }), "rpd");
});
