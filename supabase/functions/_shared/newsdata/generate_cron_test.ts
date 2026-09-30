import { config } from "./config.ts";
import { cronScheduleFromInterval, generateCronSql } from "./generate_cron.ts";

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

Deno.test("NewsData Cron generator uses a five-minute dispatcher and guards duplicates", () => {
  const schedule = cronScheduleFromInterval(config.intervalSeconds);
  const sql = generateCronSql(schedule);
  assert(schedule === "*/5 * * * *", `Unexpected schedule: ${schedule}`);
  assert(
    sql.includes("schedule := '*/5 * * * *'"),
    "Cron alteration schedule missing",
  );
  assert(
    sql.includes("'update-newsdata', '*/5 * * * *'"),
    "Cron creation schedule missing",
  );
  assert(
    sql.includes("if v_job_count > 1 then"),
    "Duplicate job guard missing",
  );
  assert(
    sql.includes(
      "v_job_count <> 1 or not coalesce(v_is_expected_active, false)",
    ),
    "One active job verification missing",
  );
  assert(
    (sql.match(/perform cron\.schedule\(/g) ?? []).length === 1,
    "Unexpected Cron creation count",
  );
});
