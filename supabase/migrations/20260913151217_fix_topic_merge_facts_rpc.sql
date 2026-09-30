begin;

create or replace function public.commit_topic_merge(
  p_article_id text,
  p_topic_id uuid,
  p_source text,
  p_published_at timestamptz,
  p_similarity real,
  p_source_category text[],
  p_classified_category text,
  p_embedding_version text,
  p_batch_id uuid,
  p_facts text[]
)
returns table(topic_id uuid, outcome text)
language plpgsql
security invoker
set search_path=pg_catalog,public
as $$
declare
  v_existing uuid;
  v_facts text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_article_id, 0));

  select ta.topic_id
  into v_existing
  from public.topic_articles ta
  where ta.article_id = p_article_id;

  if v_existing is not null then
    update public.topic_processing_queue
    set terminal_status = 'completed', processed_at = now()
    where article_id = p_article_id;
    return query select v_existing, 'duplicate_skipped'::text;
    return;
  end if;

  update public.topics
  set facts = public.normalize_topic_facts(facts || coalesce(p_facts, '{}')),
      article_count = article_count + 1,
      last_seen_at = greatest(last_seen_at, coalesce(p_published_at, now()))
  where id = p_topic_id
  returning facts into v_facts;

  if not found then
    raise exception 'target topic not found';
  end if;

  insert into public.topic_articles(topic_id, article_id, source, published_at, similarity, match_method, source_category, classified_category)
  values(p_topic_id, p_article_id, p_source, p_published_at, p_similarity, 'similarity_merge', p_source_category, p_classified_category);

  insert into public.topic_processing_logs(article_id, topic_id, candidate_topic_id, status, stage, embedding_version, similarity, source_category, classified_category, batch_id, fact_count, topic_fact_count, publishable)
  values(p_article_id, p_topic_id, p_topic_id, 'merged', 'topic_commit', p_embedding_version, p_similarity, p_source_category, p_classified_category, p_batch_id, cardinality(public.normalize_topic_facts(p_facts)), cardinality(v_facts), cardinality(v_facts) >= 1);

  update public.topic_processing_queue
  set terminal_status = 'completed', processed_at = now()
  where article_id = p_article_id;
  return query select p_topic_id, 'merged'::text;
end;
$$;

revoke all on function public.commit_topic_merge(text, uuid, text, timestamptz, real, text[], text, text, uuid, text[]) from public, anon, authenticated;
grant execute on function public.commit_topic_merge(text, uuid, text, timestamptz, real, text[], text, text, uuid, text[]) to service_role;

drop function public.commit_topic_merge(text, uuid, text, timestamptz, real, text[], text, text, uuid);

commit;
