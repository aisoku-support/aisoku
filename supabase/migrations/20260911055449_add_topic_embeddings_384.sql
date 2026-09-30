-- Topic V1 embedding storage and recent cosine candidate search.
-- The vector dimension and embedding version are intentionally isolated for a future 768 table.
begin;

create table public.topic_embeddings_384 (
  topic_id uuid primary key references public.topics(id) on delete cascade,
  embedding extensions.halfvec(384) not null,
  embedding_version text not null,
  created_at timestamptz not null default now()
);

create index topic_embeddings_384_hnsw_idx
  on public.topic_embeddings_384
  using hnsw (embedding extensions.halfvec_cosine_ops);

create or replace function public.match_recent_topics_384(
  p_query_embedding extensions.halfvec(384),
  p_lookback_hours integer,
  p_candidate_limit integer,
  p_embedding_version text
)
returns table (
  topic_id uuid,
  similarity real,
  subject text,
  event text,
  category text,
  last_seen_at timestamptz
)
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_query_embedding is null then
    raise exception 'p_query_embedding must not be null';
  end if;
  if p_lookback_hours is null or p_lookback_hours < 1 then
    raise exception 'p_lookback_hours must be positive';
  end if;
  if p_candidate_limit is null or p_candidate_limit < 1 or p_candidate_limit > 10 then
    raise exception 'p_candidate_limit must be between 1 and 10';
  end if;
  if p_embedding_version is null or btrim(p_embedding_version) = '' then
    raise exception 'p_embedding_version must not be empty';
  end if;

  return query
  select
    t.id,
    (1 - (e.embedding operator(extensions.<=>) p_query_embedding))::real,
    t.subject,
    t.event,
    t.category,
    t.last_seen_at
  from public.topic_embeddings_384 e
  join public.topics t on t.id = e.topic_id
  where t.last_seen_at >= now() - make_interval(hours => p_lookback_hours)
    and e.embedding_version = p_embedding_version
  order by e.embedding operator(extensions.<=>) p_query_embedding
  limit p_candidate_limit;
end;
$$;

alter table public.topic_embeddings_384 enable row level security;
revoke all on public.topic_embeddings_384 from public, anon, authenticated;
revoke all on function public.match_recent_topics_384(extensions.halfvec, integer, integer, text)
  from public, anon, authenticated;
grant all on public.topic_embeddings_384 to service_role;
grant execute on function public.match_recent_topics_384(extensions.halfvec, integer, integer, text)
  to service_role;

commit;

;
