begin;

grant select (id, news_url),
  insert (news_url, news_title, updated_at, last_accessed_at),
  update (id)
  on table public.articles to service_role;

grant select (article_id, chunk_index),
  insert (article_id, chunk_index, replies, conversation_pattern, updated_at)
  on table public.thread_chunks to service_role;

commit;
