do $$
begin
  if (select count(*) from public.topic_articles where article_id = 'fixture-topic-concurrency-v1') <> 1 then raise exception 'concurrent article dedupe failed'; end if;
  if (select count(*) from public.topics where representative_article_id = 'fixture-topic-concurrency-v1') <> 1 then raise exception 'concurrent orphan topic detected'; end if;
  if (select count(*) from public.topic_embeddings_384 e join public.topics t on t.id = e.topic_id where t.representative_article_id = 'fixture-topic-concurrency-v1') <> 1 then raise exception 'concurrent embedding count invalid'; end if;
  if (select count(*) from public.topic_processing_logs where article_id = 'fixture-topic-concurrency-v1' and status = 'duplicate_skipped') <> 1 then raise exception 'duplicate outcome missing'; end if;
end;
$$;
