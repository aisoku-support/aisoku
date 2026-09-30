-- Topic V1 foundation. Embeddings/vector are intentionally separate.
begin;

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  event text not null,
  topic_text text not null,
  category text not null check (category in ('トレンド', 'エンタメ', 'サブカル', 'マネー', 'IT・ガジェット')),
  representative_article_id text not null,
  representative_title text not null,
  representative_description text,
  representative_url text not null,
  representative_source text,
  representative_published_at timestamptz,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  article_count integer not null default 1 check (article_count >= 1),
  creation_mode text not null check (creation_mode in ('normal', 'gemma_failed', 'embedding_failed', 'vector_search_failed')),
  created_at timestamptz not null default now(),
  check (last_seen_at >= first_seen_at)
);

create index topics_last_seen_at_idx on public.topics(last_seen_at);
create index topics_category_last_seen_at_idx on public.topics(category, last_seen_at);

create table public.topic_articles (
  topic_id uuid not null references public.topics(id) on delete cascade,
  article_id text not null,
  source text,
  published_at timestamptz,
  similarity real,
  match_method text not null check (match_method in ('new_topic', 'similarity_merge', 'fallback_singleton')),
  source_category text[],
  classified_category text check (classified_category is null or classified_category in ('トレンド', 'エンタメ', 'サブカル', 'マネー', 'IT・ガジェット')),
  created_at timestamptz not null default now(),
  primary key (topic_id, article_id),
  unique (article_id),
  check (similarity is null or (similarity >= -1 and similarity <= 1)),
  check (match_method <> 'similarity_merge' or similarity is not null)
);

create index topic_articles_topic_id_idx on public.topic_articles(topic_id);
create index topic_articles_created_at_idx on public.topic_articles(created_at);

create table public.topic_processing_logs (
  id uuid primary key default gen_random_uuid(),
  article_id text not null,
  topic_id uuid references public.topics(id) on delete set null,
  candidate_topic_id uuid references public.topics(id) on delete set null,
  status text not null check (status in ('merged', 'new_topic', 'excluded', 'failed_gemma', 'failed_embedding', 'failed_search', 'failed_db', 'duplicate_skipped')),
  stage text not null check (char_length(stage) between 1 and 64),
  error_type text check (error_type is null or char_length(error_type) <= 64),
  error_message varchar(500),
  embedding_version text,
  similarity real check (similarity is null or (similarity >= -1 and similarity <= 1)),
  source_category text[],
  classified_category text check (classified_category is null or classified_category in ('トレンド', 'エンタメ', 'サブカル', 'マネー', 'IT・ガジェット')),
  batch_id uuid,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index topic_processing_logs_created_at_idx on public.topic_processing_logs(created_at);
create index topic_processing_logs_status_idx on public.topic_processing_logs(status);
create index topic_processing_logs_article_id_idx on public.topic_processing_logs(article_id);
create index topic_processing_logs_batch_id_idx on public.topic_processing_logs(batch_id);
create index topic_processing_logs_classified_category_idx on public.topic_processing_logs(classified_category);

create table public.topic_processing_queue (
  article_id text primary key,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  claim_id uuid,
  worker_id text,
  processing_started_at timestamptz,
  external_api_started_at timestamptz,
  processed_at timestamptz,
  terminal_status text check (terminal_status is null or terminal_status in ('completed', 'excluded', 'failed_gemma', 'failed_embedding', 'failed_search', 'failed_db', 'fallback_singleton')),
  created_at timestamptz not null default now()
);

create index topic_processing_queue_claim_idx on public.topic_processing_queue(queued_at)
  where processed_at is null and terminal_status is null;
create index topic_processing_queue_claimed_idx on public.topic_processing_queue(claimed_at)
  where processed_at is null and terminal_status is null and external_api_started_at is null;

create or replace function public.enqueue_topic_article(p_article_id text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public
as $$
begin
  if p_article_id is null or btrim(p_article_id) = '' then
    raise exception 'article_id must not be empty';
  end if;
  insert into public.topic_processing_queue(article_id) values (p_article_id)
    on conflict (article_id) do nothing;
  return found;
end;
$$;

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
      and (q.claimed_at is null or (q.claimed_at < now() - make_interval(secs => p_lease_seconds) and q.external_api_started_at is null))
    order by q.queued_at, q.article_id
    for update skip locked limit p_limit
  ), claimed as (
    update public.topic_processing_queue q
    set claimed_at = now(), claim_id = p_claim_id, worker_id = p_worker_id
    from candidates c where q.article_id = c.article_id returning q.*
  )
  select * from claimed order by queued_at, article_id;
end;
$$;

alter table public.topics enable row level security;
alter table public.topic_articles enable row level security;
alter table public.topic_processing_logs enable row level security;
alter table public.topic_processing_queue enable row level security;

revoke all on public.topics, public.topic_articles, public.topic_processing_logs, public.topic_processing_queue from public, anon, authenticated;
revoke all on function public.enqueue_topic_article(text) from public, anon, authenticated;
revoke all on function public.claim_topic_processing_articles(integer, text, uuid, integer) from public, anon, authenticated;
grant all on public.topics, public.topic_articles, public.topic_processing_logs, public.topic_processing_queue to service_role;
grant execute on function public.enqueue_topic_article(text) to service_role;
grant execute on function public.claim_topic_processing_articles(integer, text, uuid, integer) to service_role;

commit;

;
