-- Store the immutable Gemma-generated display title for newly created Topics.
begin;

alter table public.topics
  add column thread_title text check (thread_title is null or char_length(thread_title) between 1 and 47);

create function public.commit_new_topic_384(
  p_article_id text, p_subject text, p_event text, p_topic_text text, p_category text,
  p_thread_title text, p_representative_title text, p_representative_description text,
  p_representative_url text, p_representative_source text, p_representative_published_at timestamptz,
  p_source_category text[], p_creation_mode text, p_match_method text,
  p_embedding extensions.halfvec(384), p_embedding_version text, p_batch_id uuid,
  p_log_status text, p_error_type text default null, p_candidate_topic_id uuid default null,
  p_candidate_similarity real default null
)
returns table(topic_id uuid, outcome text)
language plpgsql security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_topic_id uuid;
  v_seen_at timestamptz := coalesce(p_representative_published_at, now());
begin
  if p_article_id is null or btrim(p_article_id) = '' then raise exception 'article_id must not be empty'; end if;
  if p_subject is null or btrim(p_subject) = '' then raise exception 'subject must not be empty'; end if;
  if p_event is null or btrim(p_event) = '' then raise exception 'event must not be empty'; end if;
  if p_topic_text is null or btrim(p_topic_text) = '' then raise exception 'topic_text must not be empty'; end if;
  if p_creation_mode not in ('normal', 'gemma_failed', 'embedding_failed', 'vector_search_failed') then raise exception 'invalid creation_mode'; end if;
  if p_match_method not in ('new_topic', 'fallback_singleton') then raise exception 'invalid match_method'; end if;
  if p_log_status not in ('new_topic', 'failed_gemma', 'failed_embedding', 'failed_search') then raise exception 'invalid log status'; end if;
  if p_thread_title is not null and (btrim(p_thread_title) = '' or char_length(p_thread_title) > 47) then raise exception 'invalid thread_title'; end if;
  if p_creation_mode = 'normal' and (p_embedding is null or p_embedding_version is null or btrim(p_embedding_version) = '') then raise exception 'normal topic requires embedding and version'; end if;
  if p_creation_mode <> 'normal' and p_embedding is not null then raise exception 'fallback topic must not store embedding'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_article_id, 0));
  select ta.topic_id into v_topic_id from public.topic_articles ta where ta.article_id = p_article_id;
  if v_topic_id is not null then
    insert into public.topic_processing_logs(article_id, topic_id, status, stage, error_type, embedding_version, source_category, classified_category, batch_id)
    values (p_article_id, v_topic_id, 'duplicate_skipped', 'topic_commit', 'duplicate_article', p_embedding_version, p_source_category, p_category, p_batch_id);
    update public.topic_processing_queue set terminal_status = 'completed', processed_at = now() where article_id = p_article_id;
    return query select v_topic_id, 'duplicate_skipped'::text;
    return;
  end if;

  insert into public.topics(subject, event, topic_text, category, thread_title, representative_article_id,
    representative_title, representative_description, representative_url, representative_source,
    representative_published_at, first_seen_at, last_seen_at, article_count, creation_mode)
  values (p_subject, p_event, p_topic_text, p_category, p_thread_title, p_article_id, p_representative_title,
    p_representative_description, p_representative_url, p_representative_source,
    p_representative_published_at, v_seen_at, v_seen_at, 1, p_creation_mode)
  returning id into v_topic_id;

  insert into public.topic_articles(topic_id, article_id, source, published_at, similarity, match_method, source_category, classified_category)
  values (v_topic_id, p_article_id, p_representative_source, p_representative_published_at, null, p_match_method, p_source_category, p_category);
  if p_embedding is not null then
    insert into public.topic_embeddings_384(topic_id, embedding, embedding_version)
    values (v_topic_id, p_embedding, p_embedding_version);
  end if;
  insert into public.topic_processing_logs(article_id, topic_id, candidate_topic_id, status, stage, error_type, embedding_version, similarity, source_category, classified_category, batch_id)
  values (p_article_id, v_topic_id, p_candidate_topic_id, p_log_status, 'topic_commit', p_error_type, p_embedding_version, p_candidate_similarity, p_source_category, p_category, p_batch_id);
  update public.topic_processing_queue set terminal_status = case when p_match_method = 'fallback_singleton' then 'fallback_singleton' else 'completed' end, processed_at = now() where article_id = p_article_id;
  return query select v_topic_id, p_log_status;
end;
$$;

revoke all on function public.commit_new_topic_384(text, text, text, text, text, text, text, text, text, text, timestamptz, text[], text, text, extensions.halfvec, text, uuid, text, text, uuid, real) from public, anon, authenticated;
grant execute on function public.commit_new_topic_384(text, text, text, text, text, text, text, text, text, text, timestamptz, text[], text, text, extensions.halfvec, text, uuid, text, text, uuid, real) to service_role;

commit;
