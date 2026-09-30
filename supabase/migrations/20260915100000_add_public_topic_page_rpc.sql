begin;

create or replace function public.get_public_topic_page(
  p_category text,
  p_cursor_created_at timestamptz default null,
  p_cursor_topic_id uuid default null,
  p_limit integer default 50
)
returns table (
  topic_id uuid,
  category text,
  title text,
  description text,
  url text,
  source_name text,
  published_at timestamptz,
  created_at timestamptz,
  first_seen_at timestamptz,
  thread_title text,
  representative_title text,
  subject text,
  event text,
  facts text[],
  creation_mode text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select
    t.id,
    t.category,
    coalesce(t.thread_title, t.representative_title),
    coalesce(t.representative_description, ''),
    t.representative_url,
    coalesce(t.representative_source, ''),
    t.representative_published_at,
    t.created_at,
    t.first_seen_at,
    t.thread_title,
    t.representative_title,
    t.subject,
    t.event,
    t.facts,
    t.creation_mode
  from public.topics as t
  where t.category = p_category
    and t.thread_title_pending = false
    and t.facts is not null
    and cardinality(t.facts) >= 1
    and t.representative_published_at is not null
    and (
      p_cursor_created_at is null
      or (t.created_at, t.id) < (p_cursor_created_at, p_cursor_topic_id)
    )
  order by t.created_at desc, t.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

revoke all on function public.get_public_topic_page(text, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_public_topic_page(text, timestamptz, uuid, integer)
  to anon, authenticated;

commit;
