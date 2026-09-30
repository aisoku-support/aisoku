delete from public.topic_processing_logs where article_id = 'fixture-topic-concurrency-v1';
delete from public.topics where representative_article_id = 'fixture-topic-concurrency-v1';
do $$
begin
  if exists (select 1 from public.topic_articles where article_id = 'fixture-topic-concurrency-v1')
    or exists (select 1 from public.topics where representative_article_id = 'fixture-topic-concurrency-v1')
    or exists (select 1 from public.topic_processing_logs where article_id = 'fixture-topic-concurrency-v1') then
    raise exception 'fixture cleanup failed';
  end if;
end;
$$;
