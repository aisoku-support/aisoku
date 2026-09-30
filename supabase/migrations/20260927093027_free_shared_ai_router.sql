begin;

create table public.shared_ai_jobs (
  topic_id uuid primary key references public.topics(id) on delete cascade,
  owner uuid not null,
  expires_at timestamptz not null,
  status text not null check (status in ('running','finished'))
);
create table public.shared_ai_attempts (
  topic_id uuid not null references public.topics(id) on delete cascade,
  model text not null check(model in ('groq-120b','google-gemma','cloudflare-gemma','gemini-3.1','openrouter-nemotron')),
  attempt_id uuid not null unique,
  status text not null check (status in ('sent','unknown','failed','saved')),
  started_at timestamptz not null default now(),
  primary key(topic_id,model)
);
alter table public.thread_chunks add column generation_attempt text;
create unique index thread_chunks_generation_attempt_key
  on public.thread_chunks(generation_attempt) where generation_attempt is not null;
alter table public.shared_ai_jobs enable row level security;
alter table public.shared_ai_attempts enable row level security;
revoke all on public.shared_ai_jobs,public.shared_ai_attempts from public,anon,authenticated;
grant all on public.shared_ai_jobs,public.shared_ai_attempts to service_role;

-- Serialize with all cache inserts, including the unchanged Flutter follow-up path.
create function public.lock_shared_chunk_article() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  perform 1 from public.articles where id=new.article_id for update;
  return new;
end; $$;
revoke all on function public.lock_shared_chunk_article() from public,anon,authenticated;
create trigger lock_shared_chunk_article before insert on public.thread_chunks
  for each row execute function public.lock_shared_chunk_article();

create function public.append_shared_ai_chunk(
  p_topic_id uuid,p_attempt text,p_replies jsonb
) returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_article bigint; v_index integer; v_url text; v_title text;
begin
  if p_attempt is null or length(p_attempt)>160 then raise exception 'invalid_attempt'; end if;
  if jsonb_typeof(p_replies) is distinct from 'array' then raise exception 'invalid_replies'; end if;
  if jsonb_array_length(p_replies)<>10 then raise exception 'invalid_count'; end if;
  if exists(select 1 from jsonb_array_elements(p_replies) r where
    r->>'origin' is distinct from 'sharedAi' or r->>'type' is distinct from 'ai'
    or jsonb_typeof(r->'text') is distinct from 'string'
    or length(trim(r->>'text')) not between 1 and 1000
    or (r->'replyTo' is not null and r->'replyTo'<>'null'::jsonb))
    then raise exception 'invalid_reply'; end if;
  select representative_url,coalesce(thread_title,representative_title)
    into v_url,v_title from public.topics where id=p_topic_id;
  if v_url is null then raise exception 'topic_missing'; end if;
  insert into public.articles(news_url,news_title) values(v_url,v_title) on conflict(news_url) do nothing;
  select id into v_article from public.articles where news_url=v_url for update;
  select chunk_index into v_index from public.thread_chunks
    where generation_attempt=p_attempt and article_id=v_article;
  if found then return v_index; end if;
  select coalesce(max(chunk_index),0)+1 into v_index from public.thread_chunks where article_id=v_article;
  insert into public.thread_chunks(article_id,chunk_index,replies,conversation_pattern,generation_attempt)
    values(v_article,v_index,p_replies,'independent',p_attempt);
  return v_index;
end; $$;

create or replace function public.save_topic_pregen_chunk(
  p_topic_id uuid,p_generation bigint,p_news_url text,p_news_title text,p_replies jsonb
) returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_current public.topic_pregen_target%rowtype;
begin
  select * into v_current from public.topic_pregen_target where singleton=true for update;
  if not found or v_current.topic_id is distinct from p_topic_id
    or v_current.generation is distinct from p_generation then return false; end if;
  -- Preserve the existing /rpc-check contract: invalid or empty saves return false.
  if jsonb_typeof(p_replies) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_replies)<>10 then return false; end if;
  perform public.append_shared_ai_chunk(p_topic_id,'pregen:'||p_topic_id||':'||p_generation,p_replies);
  return true;
end; $$;

create function public.claim_shared_ai_job(p_topic_id uuid,p_owner uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_job public.shared_ai_jobs%rowtype; v_topic public.topics%rowtype;
begin
  select * into v_topic from public.topics where id=p_topic_id
    and thread_title_pending=false and representative_published_at is not null
    and representative_url is not null;
  if not found then return jsonb_build_object('status','not_found'); end if;
  insert into public.articles(news_url,news_title) values(v_topic.representative_url,coalesce(v_topic.thread_title,v_topic.representative_title)) on conflict(news_url) do nothing;
  insert into public.shared_ai_jobs values(p_topic_id,p_owner,now()+interval '135 seconds','running')
    on conflict do nothing;
  select * into v_job from public.shared_ai_jobs where topic_id=p_topic_id for update;
  if exists(select 1 from public.articles a join public.thread_chunks c on c.article_id=a.id
    where a.news_url=v_topic.representative_url and c.chunk_index=1) then
    return jsonb_build_object('status','ready','chunkIndex',1);
  end if;
  if v_job.owner<>p_owner and v_job.status='running' and v_job.expires_at>now() then
    return jsonb_build_object('status','running');
  end if;
  if (select count(*) from public.shared_ai_attempts where topic_id=p_topic_id)=5 then
    return jsonb_build_object('status','exhausted');
  end if;
  if v_job.status='finished' and v_job.expires_at>now() then
    return jsonb_build_object('status','deferred','retryAfterSeconds',60);
  end if;
  update public.shared_ai_attempts set status='unknown' where topic_id=p_topic_id and status='sent';
  update public.shared_ai_jobs set owner=p_owner,expires_at=now()+interval '135 seconds',status='running'
    where topic_id=p_topic_id;
  return jsonb_build_object('status','claimed','topic',jsonb_build_object(
    'title',coalesce(v_topic.thread_title,v_topic.representative_title),
    'description',coalesce(v_topic.representative_description,''),
    'subject',v_topic.subject,'event',v_topic.event,'facts',v_topic.facts),
    'attempted',coalesce((select jsonb_agg(model) from public.shared_ai_attempts where topic_id=p_topic_id),'[]'::jsonb));
end; $$;

create function public.begin_shared_ai_attempt(p_topic_id uuid,p_owner uuid,p_model text,p_attempt_id uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  perform 1 from public.shared_ai_jobs where topic_id=p_topic_id and owner=p_owner
    and status='running' and expires_at>now() for update;
  if not found then return false; end if;
  -- Same article lock as the append RPC makes the saved-chunk check atomic.
  perform 1 from public.articles a join public.topics t on t.representative_url=a.news_url
    where t.id=p_topic_id for update of a;
  if exists(select 1 from public.topics t join public.articles a on a.news_url=t.representative_url
    join public.thread_chunks c on c.article_id=a.id where t.id=p_topic_id and c.chunk_index=1)
    then return false; end if;
  insert into public.shared_ai_attempts(topic_id,model,attempt_id,status)
    values(p_topic_id,p_model,p_attempt_id,'sent') on conflict do nothing;
  return found;
end; $$;

create function public.complete_shared_ai_attempt(p_topic_id uuid,p_attempt_id uuid,p_replies jsonb default null)
returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_index integer;
begin
  perform 1 from public.shared_ai_attempts where topic_id=p_topic_id and attempt_id=p_attempt_id for update;
  if not found then raise exception 'attempt_missing'; end if;
  if p_replies is null then
    update public.shared_ai_attempts set status='failed' where attempt_id=p_attempt_id and status in ('sent','unknown');
    return null;
  end if;
  v_index:=public.append_shared_ai_chunk(p_topic_id,'router:'||p_attempt_id,p_replies);
  update public.shared_ai_attempts set status='saved' where attempt_id=p_attempt_id;
  return v_index;
end; $$;

create function public.finish_shared_ai_job(p_topic_id uuid,p_owner uuid)
returns void language sql security invoker set search_path=pg_catalog,public as $$
  update public.shared_ai_jobs set status='finished',expires_at=now()+interval '60 seconds' where topic_id=p_topic_id and owner=p_owner;
$$;

create function public.shared_ai_chunk_ready(p_topic_id uuid)
returns boolean language sql security invoker set search_path=pg_catalog,public as $$
  select exists(select 1 from public.topics t join public.articles a on a.news_url=t.representative_url
    join public.thread_chunks c on c.article_id=a.id where t.id=p_topic_id and c.chunk_index=1);
$$;
revoke all on function public.shared_ai_chunk_ready(uuid) from public,anon,authenticated;
grant execute on function public.shared_ai_chunk_ready(uuid) to service_role;

revoke all on function public.append_shared_ai_chunk(uuid,text,jsonb),
  public.claim_shared_ai_job(uuid,uuid),public.begin_shared_ai_attempt(uuid,uuid,text,uuid),
  public.complete_shared_ai_attempt(uuid,uuid,jsonb),public.finish_shared_ai_job(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.append_shared_ai_chunk(uuid,text,jsonb),
  public.claim_shared_ai_job(uuid,uuid),public.begin_shared_ai_attempt(uuid,uuid,text,uuid),
  public.complete_shared_ai_attempt(uuid,uuid,jsonb),public.finish_shared_ai_job(uuid,uuid)
  to service_role;
commit;
