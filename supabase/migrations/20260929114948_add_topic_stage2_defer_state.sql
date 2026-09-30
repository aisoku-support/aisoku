begin;

alter table public.topic_processing_queue
  add column available_at timestamptz,
  add column stage2_attempt_count smallint not null default 0
    check (stage2_attempt_count between 0 and 4);

create index topic_processing_queue_available_claim_idx
  on public.topic_processing_queue (coalesce(available_at, queued_at), article_id)
  where processed_at is null and terminal_status is null;

create or replace function public.claim_topic_processing_articles(
  p_limit integer, p_worker_id text, p_claim_id uuid, p_lease_seconds integer
)
returns setof public.topic_processing_queue
language plpgsql security invoker set search_path = pg_catalog, public
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then raise exception 'p_limit must be between 1 and 10'; end if;
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'p_worker_id must not be empty'; end if;
  if p_claim_id is null then raise exception 'p_claim_id must not be null'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 then raise exception 'p_lease_seconds must be positive'; end if;

  return query
  with candidates as (
    select q.article_id
    from public.topic_processing_queue q
    where q.processed_at is null and q.terminal_status is null
      and (q.available_at is null or q.available_at <= now())
      and (q.claimed_at is null or (q.claimed_at < now() - make_interval(secs => p_lease_seconds) and q.external_api_started_at is null))
    order by coalesce(q.available_at, q.queued_at), q.queued_at, q.article_id
    for update skip locked limit p_limit
  ), claimed as (
    update public.topic_processing_queue q
    set claimed_at = now(), claim_id = p_claim_id, worker_id = p_worker_id
    from candidates c where q.article_id = c.article_id returning q.*
  )
  select c.* from claimed c order by coalesce(c.available_at, c.queued_at), c.queued_at, c.article_id;
end;
$$;

commit;
