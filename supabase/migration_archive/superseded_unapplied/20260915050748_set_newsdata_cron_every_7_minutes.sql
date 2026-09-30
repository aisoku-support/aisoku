-- Change the existing NewsData dispatcher to hourly without creating a duplicate job.
do $$
declare
  v_job_id bigint;
  v_job_count integer;
begin
  select count(*), min(jobid)
    into v_job_count, v_job_id
  from cron.job
  where jobname = 'update-newsdata';

  if v_job_count <> 1 then
    raise exception 'Expected exactly one update-newsdata cron job, found %', v_job_count;
  end if;

  perform cron.alter_job(
    job_id := v_job_id,
    schedule := '*/7 * * * *'
  );
end;
$$;
