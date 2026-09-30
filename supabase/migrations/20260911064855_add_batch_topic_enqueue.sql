begin;
create or replace function public.enqueue_topic_articles(p_article_ids text[])
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer;
begin
  if p_article_ids is null or cardinality(p_article_ids) < 1 or cardinality(p_article_ids) > 10 then
    raise exception 'article_ids must contain between 1 and 10 items';
  end if;
  if exists (select 1 from unnest(p_article_ids) id where id is null or btrim(id) = '') then
    raise exception 'article_id must not be empty';
  end if;

  insert into public.topic_processing_queue(article_id)
  select distinct id from unnest(p_article_ids) id
  on conflict (article_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;
revoke all on function public.enqueue_topic_articles(text[]) from public, anon, authenticated;
grant execute on function public.enqueue_topic_articles(text[]) to service_role;
commit;
