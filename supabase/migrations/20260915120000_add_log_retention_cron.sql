begin;

-- Retain scheduler and Topic processing logs for the seven-day policy window.
-- pg_cron job_run_details uses start_time as the execution timestamp.
select cron.schedule(
  'cleanup-log-retention',
  '0 3 * * *',
  $job$
    delete from cron.job_run_details
      where start_time < now() - interval '7 days';

    delete from public.topic_processing_logs
      where created_at < now() - interval '7 days';
  $job$
);

commit;
