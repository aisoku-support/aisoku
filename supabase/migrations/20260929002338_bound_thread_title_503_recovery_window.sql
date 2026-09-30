begin;

drop function public.requeue_failed_thread_title_503_once();

create function public.requeue_failed_thread_title_503_once(
  p_since timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_requeued integer;
begin
  if p_since is null or p_since < now() - interval '24 hours'
    or p_since > now() then
    raise exception 'thread_title_recovery_window_invalid';
  end if;

  with eligible_batches as materialized (
    select b.id
    from public.topic_thread_title_batches b
    where b.created_at >= p_since
      and b.created_at <= now()
      and b.http_status = 503
      and b.batch_size = 4
      and b.failure_count = 4
      and (
        select count(*)
        from public.topic_thread_title_queue q
        join public.topics t on t.id = q.topic_id
        where q.claim_id = b.id
          and q.status = 'failed'
          and q.failure_status = 'http_5xx'
          and q.retry_count = 0
          and q.recovery_attempted = false
          and t.thread_title is null
          and t.thread_title_pending = false
      ) = 4
    order by b.created_at
    for update of b skip locked
  ),
  eligible_topics as materialized (
    select q.topic_id
    from public.topic_thread_title_queue q
    join eligible_batches b on b.id = q.claim_id
    join public.topics t on t.id = q.topic_id
    where q.status = 'failed'
      and q.failure_status = 'http_5xx'
      and q.retry_count = 0
      and q.recovery_attempted = false
      and t.thread_title is null
      and t.thread_title_pending = false
  ),
  requeued as (
    update public.topic_thread_title_queue q
    set status = 'pending',
        claim_id = null,
        claimed_at = null,
        finalized_at = null,
        failure_status = null,
        recovery_attempted = true
    from eligible_topics e
    where q.topic_id = e.topic_id
    returning q.topic_id
  ),
  restored_topics as (
    update public.topics t
    set thread_title_pending = true
    from requeued r
    where t.id = r.topic_id
    returning t.id
  )
  select count(*) into v_requeued from restored_topics;
  return v_requeued;
end;
$$;

revoke all on function public.requeue_failed_thread_title_503_once(timestamptz)
  from public, anon, authenticated;
grant execute on function public.requeue_failed_thread_title_503_once(timestamptz)
  to service_role;

commit;
