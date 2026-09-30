begin;

create table public.shared_ai_chunk_generations (
  article_id bigint not null references public.articles(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 2),
  request_id uuid not null unique,
  status text not null check (status in ('running','saved','failed')),
  expires_at timestamptz not null,
  conversation_pattern text not null check (conversation_pattern in
    ('independent','singleReply','doubleReply','chain3','branch','mixed')),
  primary_chunk_index integer,
  late_saves jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(article_id,chunk_index)
);
alter table public.shared_ai_chunk_generations enable row level security;
revoke all on public.shared_ai_chunk_generations from public,anon,authenticated;
grant all on public.shared_ai_chunk_generations to service_role;

-- Reserve the requested slot before the provider request. Legacy clients use a
-- direct insert without generation_attempt; ignore it while the server owns it.
create or replace function public.lock_shared_chunk_article() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform 1 from public.articles where id=new.article_id for update;
  if new.generation_attempt is null and exists (
    select 1 from public.shared_ai_chunk_generations g
    where g.article_id=new.article_id and g.chunk_index=new.chunk_index
      and g.status='running' and g.expires_at>now()
  ) then return null; end if;
  return new;
end; $$;

create function public.claim_shared_ai_chunk_generation(
  p_news_url text,p_news_title text,p_chunk_index integer,
  p_request_id uuid,p_conversation_pattern text
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_article bigint; v_job public.shared_ai_chunk_generations%rowtype;
  v_created boolean:=false; v_max integer; v_replies jsonb;
begin
  if p_news_url is null or length(p_news_url)>4000 or p_news_title is null
    or length(p_news_title)>300 or p_chunk_index<2 or p_chunk_index>100000
    or p_request_id is null or p_conversation_pattern not in
      ('independent','singleReply','doubleReply','chain3','branch','mixed') then
    raise exception 'invalid_shared_chunk_claim'; end if;
  insert into public.articles(news_url,news_title) values(p_news_url,p_news_title)
    on conflict(news_url) do nothing;
  select id into v_article from public.articles where news_url=p_news_url for update;
  select replies into v_replies from public.thread_chunks
    where article_id=v_article and chunk_index=p_chunk_index;
  if found then return jsonb_build_object('status','ready','chunkIndex',p_chunk_index,'replies',v_replies); end if;
  select coalesce(max(chunk_index),0) into v_max from public.thread_chunks where article_id=v_article;
  if p_chunk_index>v_max+1 then return jsonb_build_object('status','gap','nextChunkIndex',v_max+1); end if;
  insert into public.shared_ai_chunk_generations(article_id,chunk_index,request_id,status,
    expires_at,conversation_pattern)
  values(v_article,p_chunk_index,p_request_id,'running',now()+interval '60 seconds',p_conversation_pattern)
  on conflict(article_id,chunk_index) do nothing returning true into v_created;
  select * into v_job from public.shared_ai_chunk_generations
    where article_id=v_article and chunk_index=p_chunk_index for update;
  if v_job.status='saved' then
    select replies into v_replies from public.thread_chunks where article_id=v_article
      and chunk_index=v_job.primary_chunk_index;
    return jsonb_build_object('status','ready','chunkIndex',v_job.primary_chunk_index,'replies',v_replies);
  end if;
  if v_created then return jsonb_build_object('status','claimed','articleId',v_article); end if;
  if v_job.status='running' and v_job.expires_at>now() then
    return jsonb_build_object('status','running','expiresAt',v_job.expires_at);
  end if;
  update public.shared_ai_chunk_generations set request_id=p_request_id,status='running',
    expires_at=now()+interval '60 seconds',conversation_pattern=p_conversation_pattern,updated_at=now()
    where article_id=v_article and chunk_index=p_chunk_index;
  return jsonb_build_object('status','claimed','articleId',v_article,'recovered',true);
end; $$;

create function public.build_shared_ai_chunk_replies(
  p_replies text[],p_reply_relations jsonb,p_chunk_index integer
) returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
  if cardinality(p_replies)<>10 or p_reply_relations is null
    or jsonb_typeof(p_reply_relations)<>'array' or p_chunk_index<2 then
    raise exception 'invalid_shared_chunk_replies'; end if;
  if exists(select 1 from unnest(p_replies) r where r is null or length(trim(r)) not between 1 and 1000)
    or exists(select 1 from jsonb_array_elements(p_reply_relations) e
      where (e->>'from')::integer not between 1 and 10 or (e->>'to')::integer not between 1 and 10
        or (e->>'from')::integer=(e->>'to')::integer)
    or (select count(*) from jsonb_array_elements(p_reply_relations)) <>
       (select count(distinct e->>'from') from jsonb_array_elements(p_reply_relations) e) then
    raise exception 'invalid_shared_chunk_replies'; end if;
  select jsonb_agg(jsonb_build_object(
      'text',r.text,'type','ai','name','名無しのAIさん','id',gen_random_uuid()::text,
  'origin','sharedAi','replyTo',rel.target) order by r.ordinality)
    into v_result
    from unnest(p_replies) with ordinality r(text,ordinality)
    left join lateral (select (e->>'to')::integer as target
      from jsonb_array_elements(p_reply_relations) e
      where (e->>'from')::integer=r.ordinality) rel on true;
  return v_result;
end; $$;

-- Article based overload for follow-up chunks, which may not have a Topic row.
-- It keeps append_shared_ai_chunk's idempotent attempt key and article lock.
create function public.append_shared_ai_chunk(
  p_article_id bigint,p_attempt text,p_replies jsonb,p_pattern text
) returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_index integer;
begin
  if p_attempt is null or length(p_attempt)>160 or jsonb_typeof(p_replies) is distinct from 'array'
    or jsonb_array_length(p_replies)<>10 or p_pattern not in
      ('independent','singleReply','doubleReply','chain3','branch','mixed') then
    raise exception 'invalid_replies'; end if;
  if exists(select 1 from jsonb_array_elements(p_replies) with ordinality x(value,ordinality) where
    x.value->>'origin' is distinct from 'sharedAi' or x.value->>'type' is distinct from 'ai'
    or jsonb_typeof(x.value->'text') is distinct from 'string'
    or length(trim(x.value->>'text')) not between 1 and 1000
    or (x.value->'replyTo' is not null and x.value->'replyTo'<>'null'::jsonb and
      (jsonb_typeof(x.value->'replyTo')<>'number'
       or (x.value->>'replyTo')::integer not between 1 and 10
       or (x.value->>'replyTo')::integer=x.ordinality::integer))) then
    raise exception 'invalid_reply'; end if;
  perform 1 from public.articles where id=p_article_id for update;
  if not found then raise exception 'article_missing'; end if;
  select chunk_index into v_index from public.thread_chunks
    where generation_attempt=p_attempt and article_id=p_article_id;
  if found then return v_index; end if;
  select coalesce(max(chunk_index),0)+1 into v_index from public.thread_chunks where article_id=p_article_id;
  insert into public.thread_chunks(article_id,chunk_index,replies,conversation_pattern,generation_attempt)
    values(p_article_id,v_index,p_replies,p_pattern,p_attempt);
  return v_index;
end; $$;

create function public.complete_shared_ai_chunk_primary(
  p_article_id bigint,p_chunk_index integer,p_request_id uuid,p_model text,
  p_replies text[],p_reply_relations jsonb
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_job public.shared_ai_chunk_generations%rowtype; v_index integer; v_max integer;
  v_attempt text; v_rows jsonb;
begin
  perform 1 from public.articles where id=p_article_id for update;
  select * into v_job from public.shared_ai_chunk_generations
    where article_id=p_article_id and chunk_index=p_chunk_index for update;
  if not found or v_job.request_id<>p_request_id then return jsonb_build_object('status','not_owner'); end if;
  if v_job.status='saved' then
    select replies into v_rows from public.thread_chunks where article_id=p_article_id and chunk_index=v_job.primary_chunk_index;
    return jsonb_build_object('status','saved','chunkIndex',v_job.primary_chunk_index,'replies',v_rows);
  end if;
  if v_job.status<>'running' or v_job.expires_at<=now() then return jsonb_build_object('status','expired'); end if;
  select coalesce(max(chunk_index),0) into v_max from public.thread_chunks where article_id=p_article_id;
  if v_max+1<>p_chunk_index then return jsonb_build_object('status','conflict','nextChunkIndex',v_max+1); end if;
  if p_model not in ('groq-120b','google-gemma','cloudflare-gemma','gemini-3.1','openrouter-nemotron') then
    raise exception 'invalid_shared_ai_model'; end if;
  v_attempt:='shared-primary:'||p_request_id::text||':'||p_model;
  v_rows:=public.build_shared_ai_chunk_replies(p_replies,p_reply_relations,p_chunk_index);
  v_index:=public.append_shared_ai_chunk(p_article_id,v_attempt,v_rows,v_job.conversation_pattern);
  update public.shared_ai_chunk_generations set status='saved',primary_chunk_index=v_index,
    expires_at=now()+interval '60 seconds',updated_at=now()
    where article_id=p_article_id and chunk_index=p_chunk_index and request_id=p_request_id;
  return jsonb_build_object('status','saved','chunkIndex',v_index,'replies',v_rows);
end; $$;

create function public.append_shared_ai_late_result(
  p_article_id bigint,p_chunk_index integer,p_request_id uuid,p_model text,
  p_replies text[],p_reply_relations jsonb
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_job public.shared_ai_chunk_generations%rowtype; v_index integer; v_max integer;
  v_attempt text; v_rows jsonb; v_existing integer;
begin
  if p_model not in ('groq-120b','google-gemma','cloudflare-gemma','gemini-3.1','openrouter-nemotron') then
    raise exception 'invalid_shared_ai_model'; end if;
  perform 1 from public.articles where id=p_article_id for update;
  select * into v_job from public.shared_ai_chunk_generations
    where article_id=p_article_id and chunk_index=p_chunk_index for update;
  if not found or v_job.status<>'saved' then return jsonb_build_object('status','primary_not_saved'); end if;
  v_attempt:='shared-late:'||p_request_id::text||':'||p_model;
  select chunk_index into v_existing from public.thread_chunks
    where generation_attempt=v_attempt;
  if found then return jsonb_build_object('status','already_saved','chunkIndex',v_existing); end if;
  select coalesce(max(chunk_index),0)+1 into v_index from public.thread_chunks where article_id=p_article_id;
  v_rows:=public.build_shared_ai_chunk_replies(p_replies,p_reply_relations,v_index);
  v_index:=public.append_shared_ai_chunk(p_article_id,v_attempt,v_rows,v_job.conversation_pattern);
  update public.shared_ai_chunk_generations set late_saves=late_saves||jsonb_build_object(p_model,v_index),updated_at=now()
    where article_id=p_article_id and chunk_index=p_chunk_index;
  return jsonb_build_object('status','saved','chunkIndex',v_index);
end; $$;

create function public.fail_shared_ai_chunk_generation(
  p_article_id bigint,p_chunk_index integer,p_request_id uuid
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  update public.shared_ai_chunk_generations set status='failed',expires_at=now(),updated_at=now()
    where article_id=p_article_id and chunk_index=p_chunk_index and request_id=p_request_id and status='running';
  return found;
end; $$;

revoke all on function public.claim_shared_ai_chunk_generation(text,text,integer,uuid,text),
  public.build_shared_ai_chunk_replies(text[],jsonb,integer),
  public.append_shared_ai_chunk(bigint,text,jsonb,text),
  public.complete_shared_ai_chunk_primary(bigint,integer,uuid,text,text[],jsonb),
  public.append_shared_ai_late_result(bigint,integer,uuid,text,text[],jsonb),
  public.fail_shared_ai_chunk_generation(bigint,integer,uuid)
  from public,anon,authenticated;
grant execute on function public.claim_shared_ai_chunk_generation(text,text,integer,uuid,text),
  public.build_shared_ai_chunk_replies(text[],jsonb,integer),
  public.append_shared_ai_chunk(bigint,text,jsonb,text),
  public.complete_shared_ai_chunk_primary(bigint,integer,uuid,text,text[],jsonb),
  public.append_shared_ai_late_result(bigint,integer,uuid,text,text[],jsonb),
  public.fail_shared_ai_chunk_generation(bigint,integer,uuid)
  to service_role;
commit;
