begin;
do $$
declare
  v_id text := 'fixture-topic-enqueue-' || gen_random_uuid()::text;
begin
  if public.enqueue_topic_articles(array[v_id, v_id]) <> 1 then
    raise exception 'duplicate batch enqueue did not insert exactly one row';
  end if;
  if public.enqueue_topic_articles(array[v_id]) <> 0 then
    raise exception 'duplicate queue enqueue inserted another row';
  end if;
  if (select count(*) from public.topic_processing_queue where article_id = v_id) <> 1 then
    raise exception 'queue duplicate constraint failed';
  end if;
end;
$$;
rollback;
