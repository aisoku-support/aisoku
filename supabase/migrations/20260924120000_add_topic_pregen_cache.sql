begin;

alter table public.topics add column topic_pregen_pending boolean not null default false;
alter table public.topics alter column topic_pregen_pending set default true;

create table public.topic_pregen_target (
  singleton boolean primary key default true check (singleton),
  generation bigint not null default 0,
  topic_id uuid,
  updated_at timestamptz not null default now()
);

alter table public.topic_pregen_target enable row level security;
revoke all on public.topic_pregen_target from public, anon, authenticated;
grant all on public.topic_pregen_target to service_role;

create or replace function public.get_topic_pregen_inputs(p_topic_ids uuid[])
returns table(topic_id uuid, title text, facts jsonb, news_url text)
language sql security invoker set search_path = pg_catalog, public as $$
  select t.id, t.thread_title, to_jsonb(t.facts), t.representative_url
  from public.topics t
  join public.topic_thread_title_queue q on q.topic_id=t.id and q.status='success'
  where t.id = any(p_topic_ids)
    and t.thread_title_pending = false
    and t.topic_pregen_pending = true
    and t.thread_title is not null
    and t.representative_url is not null
    and jsonb_typeof(to_jsonb(t.facts))='array'
    and jsonb_array_length(to_jsonb(t.facts)) > 0
  order by t.created_at desc, t.id desc
  limit 1;
$$;
revoke all on function public.get_topic_pregen_inputs(uuid[]) from public, anon, authenticated;
grant execute on function public.get_topic_pregen_inputs(uuid[]) to service_role;

create or replace function public.register_topic_pregen_target(p_topic_id uuid)
returns table(generation bigint, topic_id uuid, title text, facts jsonb, news_url text)
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_generation bigint;
begin
  insert into public.topic_pregen_target(singleton) values (true) on conflict do nothing;
  perform 1 from public.topic_pregen_target where singleton=true for update;
  if not exists (
    select 1 from public.topics t where t.id=p_topic_id
      and t.topic_pregen_pending=true and t.thread_title_pending=false
      and t.thread_title is not null and t.representative_url is not null
      and jsonb_typeof(to_jsonb(t.facts))='array' and jsonb_array_length(to_jsonb(t.facts)) > 0
  ) then return; end if;
  if exists (
    select 1 from public.topic_pregen_target s
    join public.topics current_topic on current_topic.id=s.topic_id
    join public.topics incoming_topic on incoming_topic.id=p_topic_id
    where s.singleton=true and (current_topic.created_at, current_topic.id) > (incoming_topic.created_at, incoming_topic.id)
  ) then return; end if;
  update public.topic_pregen_target s set generation=s.generation+1, topic_id=p_topic_id, updated_at=now()
    where s.singleton=true returning s.generation into v_generation;
  update public.topics set topic_pregen_pending=false where id=p_topic_id;
  return query select v_generation,t.id,t.thread_title,to_jsonb(t.facts),t.representative_url
    from public.topics t where t.id=p_topic_id and t.thread_title_pending=false
      and t.thread_title is not null and t.representative_url is not null
      and jsonb_typeof(to_jsonb(t.facts))='array' and jsonb_array_length(to_jsonb(t.facts)) > 0;
end; $$;
revoke all on function public.register_topic_pregen_target(uuid) from public, anon, authenticated;
grant execute on function public.register_topic_pregen_target(uuid) to service_role;

create or replace function public.save_topic_pregen_chunk(
  p_topic_id uuid, p_generation bigint, p_news_url text, p_news_title text, p_replies jsonb
) returns boolean
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_current public.topic_pregen_target%rowtype; v_article_id bigint;
begin
  if p_topic_id is null then return false; end if;
  select * into v_current from public.topic_pregen_target where singleton=true for update;
  if not found or v_current.topic_id is distinct from p_topic_id
    or v_current.generation is distinct from p_generation then return false; end if;
  if jsonb_typeof(p_replies) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_replies) <> 10 then return false; end if;
  insert into public.articles(news_url,news_title,updated_at,last_accessed_at)
    values (p_news_url,p_news_title,now(),now()) on conflict(news_url) do nothing;
  select id into v_article_id from public.articles where news_url=p_news_url for update;
  if exists(select 1 from public.thread_chunks where article_id=v_article_id and chunk_index=1) then return false; end if;
  insert into public.thread_chunks(article_id,chunk_index,replies,conversation_pattern,updated_at)
    values (v_article_id,1,p_replies,'independent',now());
  return true;
end; $$;
revoke all on function public.save_topic_pregen_chunk(uuid,bigint,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.save_topic_pregen_chunk(uuid,bigint,text,text,jsonb) to service_role;

commit;
