begin;

alter table public.topic_thread_title_queue
  add column retry_count smallint not null default 0
    check (retry_count between 0 and 1),
  add column recovery_attempted boolean not null default false;

create or replace function public.reserve_topic_thread_title_retry(
  p_claim_id uuid
)
returns table(allowed boolean, reason text, used_today integer, wait_ms integer)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_state public.topic_thread_title_quota_state%rowtype;
  v_claim_count integer;
  v_retry_count integer;
  v_wait_ms integer;
  v_used integer;
begin
  select count(*) into v_claim_count
  from public.topic_thread_title_queue q
  where q.claim_id = p_claim_id and q.status = 'claimed';
  if v_claim_count <> 4 then
    return query select false, 'claim_lost'::text, null::integer, 0;
    return;
  end if;

  select count(*) into v_retry_count
  from public.topic_thread_title_queue q
  where q.claim_id = p_claim_id and q.status = 'claimed'
    and q.retry_count >= 1;
  if v_retry_count > 0 then
    return query select false, 'retry_used'::text, null::integer, 0;
    return;
  end if;

  select s.* into v_state
  from public.topic_thread_title_quota_state s
  where s.singleton = true
  for update;

  if v_state.quota_day_pt <> v_day then
    if v_state.quota_exhausted_at is not null then
      return query select false, 'quota_reset_probe'::text, v_state.used_today, 0;
      return;
    end if;
    update public.topic_thread_title_quota_state s
    set quota_day_pt = v_day,
        used_today = 0,
        quota_exhausted_at = null,
        reset_probe_started_at = null,
        first_success_after_reset = null,
        updated_at = now()
    where s.singleton = true;
    v_state.used_today := 0;
  end if;

  if v_state.quota_exhausted_at is not null
    or v_state.used_today >= 490 then
    return query select false, 'quota_limit'::text, v_state.used_today, 0;
    return;
  end if;

  if v_state.last_request_started_at is not null
    and v_state.last_request_started_at > now() - interval '4.1 seconds' then
    v_wait_ms := greatest(
      1,
      ceil(extract(epoch from (
        v_state.last_request_started_at + interval '4.1 seconds' - now()
      )) * 1000)::integer
    );
    return query select false, 'request_interval'::text, v_state.used_today, v_wait_ms;
    return;
  end if;

  update public.topic_thread_title_quota_state s
  set used_today = s.used_today + 1,
      last_request_started_at = now(),
      updated_at = now()
  where s.singleton = true
  returning s.used_today into v_used;

  update public.topic_thread_title_queue q
  set retry_count = q.retry_count + 1
  where q.claim_id = p_claim_id and q.status = 'claimed'
    and q.retry_count = 0;
  get diagnostics v_retry_count = row_count;
  if v_retry_count <> 4 then
    raise exception 'thread_title_retry_claim_changed';
  end if;

  return query select true, 'reserved'::text, v_used, 0;
end;
$$;

create or replace function public.requeue_failed_thread_title_503_once()
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_requeued integer;
begin
  with eligible_batches as materialized (
    select b.id
    from public.topic_thread_title_batches b
    where b.http_status = 503
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

revoke all on function public.reserve_topic_thread_title_retry(uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_topic_thread_title_retry(uuid)
  to service_role;
revoke all on function public.requeue_failed_thread_title_503_once()
  from public, anon, authenticated;
grant execute on function public.requeue_failed_thread_title_503_once()
  to service_role;

alter table public.topic_observability_logs
  add column article_body_method varchar(24)
    check (article_body_method is null or article_body_method in ('none', 'readability')),
  add column article_body_readability varchar(16)
    check (article_body_readability is null or article_body_readability in ('not_run', 'failed', 'success')),
  add column article_body_chars integer check (article_body_chars is null or article_body_chars >= 0),
  add column article_body_redirected boolean;

alter table public.topic_observability_logs
  drop constraint topic_observability_logs_operation_check,
  add constraint topic_observability_logs_operation_check
    check (operation in ('stage1_attempt', 'vector_search', 'outbox_sync', 'article_body'));

alter table public.topic_observability_logs
  drop constraint topic_observability_logs_payload_check,
  add constraint topic_observability_logs_payload_check check (
    (operation = 'stage1_attempt' and model is not null and attempt_no is not null and model_role is not null)
    or (operation = 'vector_search' and article_id is not null and embedding_version is not null)
    or (operation = 'outbox_sync' and item_count is not null)
    or (operation = 'article_body' and article_id is not null and article_body_chars is not null)
  );

create index topic_observability_logs_article_body_created_idx
  on public.topic_observability_logs(created_at desc)
  where operation = 'article_body';

commit;
