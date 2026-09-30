-- Topic V1: keep category/model spaces isolated and persist independent PT-day quota state.
begin;

alter table public.topic_processing_logs
  add column if not exists embedding_model text;

alter table public.topic_embeddings_384
  add constraint topic_embeddings_384_version_not_blank
  check (btrim(embedding_version) <> '');

create table if not exists public.topic_embedding_quota_state (
  embedding_model text primary key,
  quota_day_pt date not null,
  used_today integer not null default 0 check (used_today >= 0),
  quota_exhausted_at timestamptz,
  reset_probe_started_at timestamptz,
  first_success_after_reset timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.topic_embedding_quota_state enable row level security;
revoke all on public.topic_embedding_quota_state from public, anon, authenticated;
grant all on public.topic_embedding_quota_state to service_role;

create or replace function public.match_recent_topics_384(
  p_query_embedding extensions.halfvec(384),
  p_lookback_hours integer,
  p_candidate_limit integer,
  p_embedding_version text,
  p_category text default null
)
returns table (topic_id uuid, similarity real, subject text, event text, category text,
  embedding_model text, last_seen_at timestamptz)
language plpgsql security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_query_embedding is null then raise exception 'p_query_embedding must not be null'; end if;
  if p_lookback_hours is null or p_lookback_hours < 1 then raise exception 'p_lookback_hours must be positive'; end if;
  if p_candidate_limit is null or p_candidate_limit < 1 or p_candidate_limit > 10 then raise exception 'invalid candidate limit'; end if;
  return query
  select t.id,
    (1 - (e.embedding operator(extensions.<=>) p_query_embedding))::real,
    t.subject, t.event, t.category,
    split_part(e.embedding_version, ':', 1), t.last_seen_at
  from public.topic_embeddings_384 e join public.topics t on t.id = e.topic_id
  where t.last_seen_at >= now() - make_interval(hours => p_lookback_hours)
    and e.embedding_version = p_embedding_version
    and (p_category is null or t.category = p_category)
  order by e.embedding operator(extensions.<=>) p_query_embedding
  limit p_candidate_limit;
end;
$$;

revoke all on function public.match_recent_topics_384(extensions.halfvec, integer, integer, text) from public, anon, authenticated;
revoke all on function public.match_recent_topics_384(extensions.halfvec, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.match_recent_topics_384(extensions.halfvec, integer, integer, text, text) to service_role;
commit;
