-- Run after Topic V1 migrations. All fixture rows are rolled back.
begin;

do $$
declare
  v_topic_article text := 'fixture-topic-facts-source-' || gen_random_uuid()::text;
  v_merge_article text := 'fixture-topic-facts-merge-' || gen_random_uuid()::text;
  v_topic uuid;
begin
  insert into public.topic_processing_queue(article_id)
  values (v_topic_article), (v_merge_article);

  select topic_id into v_topic
  from public.commit_new_topic_384(
    v_topic_article, 'fixture subject', 'fixture event', 'fixture subject | fixture event',
    'IT・ガジェット', null, array['existing fact'], 'fixture title', 'fixture description',
    'https://example.invalid/topic-facts-source', 'fixture', now(), array['technology'],
    'normal', 'new_topic', null, 'gemini-embedding-2:384:v1', gen_random_uuid(),
    'new_topic', null, null, null
  );

  perform public.commit_topic_merge(
    v_merge_article, v_topic, 'fixture', now() + interval '1 minute', 0.95,
    array['technology'], 'IT・ガジェット', 'gemini-embedding-2:384:v1', gen_random_uuid(),
    array['  existing fact  ', '', 'new fact', 'new fact']
  );

  if not exists (
    select 1 from public.topics
    where id = v_topic and article_count = 2
      and facts = array['existing fact', 'new fact']
  ) then
    raise exception 'facts merge was not normalized and aggregated';
  end if;

  if not exists (
    select 1 from public.topic_processing_logs
    where article_id = v_merge_article and status = 'merged'
      and fact_count = 2 and topic_fact_count = 2 and publishable
  ) then
    raise exception 'facts merge audit log missing';
  end if;

  if not exists (
    select 1 from public.topic_processing_queue
    where article_id = v_merge_article and terminal_status = 'completed'
      and processed_at is not null
  ) then
    raise exception 'facts merge queue was not completed';
  end if;

  perform public.commit_topic_merge(
    v_merge_article, v_topic, 'fixture', now() + interval '2 minutes', 0.95,
    array['technology'], 'IT・ガジェット', 'gemini-embedding-2:384:v1', gen_random_uuid(),
    array['ignored duplicate fact']
  );

  if (select article_count from public.topics where id = v_topic) <> 2 then
    raise exception 'duplicate merge changed article count';
  end if;
end;
$$;

rollback;
