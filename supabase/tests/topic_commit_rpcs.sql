-- Run after Topic V1 migrations. All fixture rows are rolled back.
begin;
do $$
declare
  v_article text := 'fixture-topic-commit-' || gen_random_uuid()::text;
  v_topic uuid;
  v_duplicate uuid;
  v_gemma_article text := 'fixture-gemma-' || gen_random_uuid()::text;
  v_embedding_article text := 'fixture-embedding-' || gen_random_uuid()::text;
  v_search_article text := 'fixture-search-' || gen_random_uuid()::text;
  v_excluded_article text := 'fixture-excluded-' || gen_random_uuid()::text;
  v_vector extensions.halfvec(384) := ('[' || array_to_string(array_fill(0.01::real, array[384]), ',') || ']')::extensions.halfvec;
begin
  insert into public.topic_processing_queue(article_id) values (v_article), (v_gemma_article), (v_embedding_article), (v_search_article), (v_excluded_article);
  select topic_id into v_topic from public.commit_new_topic_384(v_article, '対象', '発表した', '対象 | 発表した', 'トレンド', 'fixture title', null, 'https://example.invalid/a', 'fixture', now(), array['top'], 'normal', 'new_topic', v_vector, 'gemini-embedding-2:384:v1', gen_random_uuid(), 'new_topic', null, null, null);
  if not exists (select 1 from public.topics where id = v_topic and article_count = 1 and creation_mode = 'normal') then raise exception 'new topic missing'; end if;
  if not exists (select 1 from public.topic_embeddings_384 where topic_id = v_topic and embedding_version = 'gemini-embedding-2:384:v1') then raise exception 'embedding missing'; end if;
  if not exists (select 1 from public.topic_processing_queue where article_id = v_article and terminal_status = 'completed' and processed_at is not null) then raise exception 'normal queue not completed'; end if;
  if not exists (select 1 from public.match_recent_topics_384(v_vector, 24, 1, 'gemini-embedding-2:384:v1') where topic_id = v_topic and similarity >= 0.99) then raise exception 'vector search did not find new topic'; end if;
  select topic_id into v_duplicate from public.commit_new_topic_384(v_article, '別対象', '別イベント', '別対象 | 別イベント', 'トレンド', 'duplicate', null, 'https://example.invalid/b', 'fixture', now(), array['top'], 'normal', 'new_topic', v_vector, 'gemini-embedding-2:384:v1', gen_random_uuid(), 'new_topic', null, null, null);
  if v_duplicate <> v_topic then raise exception 'duplicate did not retain original topic'; end if;
  if (select count(*) from public.topics where representative_article_id = v_article) <> 1 then raise exception 'orphan duplicate topic created'; end if;
  perform public.commit_topic_merge(v_article || '-merge', v_topic, 'fixture', now() + interval '1 minute', 0.95, array['technology'], 'IT・ガジェット', 'gemini-embedding-2:384:v1', gen_random_uuid());
  if not exists (select 1 from public.topics where id = v_topic and article_count = 2 and category = 'トレンド' and representative_article_id = v_article) then raise exception 'merge mutated fixed fields or count failed'; end if;
  if (select count(*) from public.topic_embeddings_384 where topic_id = v_topic) <> 1 then raise exception 'merge changed embedding'; end if;

  perform public.commit_new_topic_384(v_gemma_article, 'Gemma失敗記事', '単独記事', 'Gemma失敗記事 | 単独記事', 'トレンド', 'fixture', null, 'https://example.invalid/g', 'fixture', now(), array['top'], 'gemma_failed', 'fallback_singleton', null, 'gemini-embedding-2:384:v1', gen_random_uuid(), 'failed_gemma', 'invalid_json', null, null);
  perform public.commit_new_topic_384(v_embedding_article, '対象', '発表した', '対象 | 発表した', 'IT・ガジェット', 'fixture', null, 'https://example.invalid/e', 'fixture', now(), array['technology'], 'embedding_failed', 'fallback_singleton', null, 'gemini-embedding-2:384:v1', gen_random_uuid(), 'failed_embedding', 'dimension_mismatch', null, null);
  perform public.commit_new_topic_384(v_search_article, '対象', '発表した', '対象 | 発表した', 'トレンド', 'fixture', null, 'https://example.invalid/s', 'fixture', now(), array['top'], 'vector_search_failed', 'fallback_singleton', null, 'gemini-embedding-2:384:v1', gen_random_uuid(), 'failed_search', 'vector_rpc_failed', null, null);
  if (select count(*) from public.topics where representative_article_id in (v_gemma_article, v_embedding_article, v_search_article) and creation_mode in ('gemma_failed', 'embedding_failed', 'vector_search_failed')) <> 3 then raise exception 'singleton fallback missing'; end if;
  if exists (select 1 from public.topic_embeddings_384 e join public.topics t on t.id = e.topic_id where t.representative_article_id in (v_gemma_article, v_embedding_article, v_search_article)) then raise exception 'singleton stored embedding'; end if;
  if (select count(*) from public.topic_processing_queue where article_id in (v_gemma_article, v_embedding_article, v_search_article) and terminal_status = 'fallback_singleton' and processed_at is not null) <> 3 then raise exception 'singleton queue not finalized'; end if;
  perform public.finalize_topic_excluded(v_excluded_article, gen_random_uuid());
  if exists (select 1 from public.topic_articles where article_id = v_excluded_article) then raise exception 'excluded topic created'; end if;
  if not exists (select 1 from public.topic_processing_queue where article_id = v_excluded_article and terminal_status = 'excluded' and processed_at is not null) then raise exception 'excluded queue not finalized'; end if;
end;
$$;
rollback;
