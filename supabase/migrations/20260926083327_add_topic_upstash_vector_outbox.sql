begin;

create table public.topic_vector_outbox (
  topic_id uuid primary key references public.topics(id) on delete cascade,
  topic_text text not null,
  subject text not null,
  event text not null,
  category text not null,
  last_seen_at timestamptz not null,
  claim_token uuid,
  claimed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index topic_vector_outbox_claim_idx on public.topic_vector_outbox(updated_at);
alter table public.topic_vector_outbox enable row level security;
revoke all on public.topic_vector_outbox from public, anon, authenticated;
grant all on public.topic_vector_outbox to service_role;

create or replace function public.enqueue_topic_vector_outbox() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if new.creation_mode = 'normal'
     and nullif(btrim(new.subject),'') is not null
     and nullif(btrim(new.event),'') is not null
     and nullif(btrim(new.category),'') is not null then
    insert into public.topic_vector_outbox(topic_id,topic_text,subject,event,category,last_seen_at,claim_token,claimed_at,updated_at)
    values(new.id, new.subject || ' | ' || new.event, new.subject, new.event, new.category, new.last_seen_at, null, null, now())
    on conflict(topic_id) do update set topic_text=excluded.topic_text, subject=excluded.subject, event=excluded.event, category=excluded.category,
      last_seen_at=excluded.last_seen_at, claim_token=null, claimed_at=null, updated_at=now();
  end if;
  return new;
end; $$;
create trigger topics_enqueue_vector_outbox_insert after insert on public.topics
for each row execute function public.enqueue_topic_vector_outbox();
create trigger topics_enqueue_vector_outbox_update after update of subject,event,topic_text,category,last_seen_at on public.topics
for each row when (new.creation_mode='normal') execute function public.enqueue_topic_vector_outbox();

create or replace function public.enqueue_recent_topic_vectors(p_lookback_hours integer default 24)
returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  insert into public.topic_vector_outbox(topic_id,topic_text,subject,event,category,last_seen_at)
  select t.id, t.subject || ' | ' || t.event, t.subject, t.event, t.category, t.last_seen_at
  from public.topics t join public.topic_embeddings_384 e on e.topic_id=t.id
  where t.creation_mode='normal' and t.last_seen_at >= now()-make_interval(hours => p_lookback_hours)
    and nullif(btrim(t.subject),'') is not null and nullif(btrim(t.event),'') is not null
    and nullif(btrim(t.category),'') is not null
  on conflict(topic_id) do update set topic_text=excluded.topic_text,subject=excluded.subject,event=excluded.event,category=excluded.category,
    last_seen_at=excluded.last_seen_at,claim_token=null,claimed_at=null,updated_at=now();
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

create or replace function public.claim_topic_vector_outbox(p_limit integer default 100)
returns table(topic_id uuid,topic_text text,subject text,event text,category text,last_seen_at timestamptz,claim_token uuid)
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_token uuid:=gen_random_uuid();
begin
  return query with claimed as (
    select o.topic_id from public.topic_vector_outbox o
    where o.claim_token is null or o.claimed_at < now()-interval '5 minutes'
    order by o.updated_at limit least(greatest(p_limit,1),100) for update skip locked
  ) update public.topic_vector_outbox o set claim_token=v_token,claimed_at=now()
    from claimed c where o.topic_id=c.topic_id
    returning o.topic_id,o.topic_text,o.subject,o.event,o.category,o.last_seen_at,o.claim_token;
end; $$;

create or replace function public.ack_topic_vector_outbox(p_claim_token uuid)
returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  delete from public.topic_vector_outbox where claim_token=p_claim_token;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
create or replace function public.release_topic_vector_outbox(p_claim_token uuid)
returns integer language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  update public.topic_vector_outbox set claim_token=null,claimed_at=null,updated_at=now() where claim_token=p_claim_token;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
create or replace function public.topic_vector_outbox_status()
returns table(pending bigint,oldest_updated_at timestamptz)
language sql security invoker set search_path=pg_catalog,public as $$
  select count(*),min(updated_at) from public.topic_vector_outbox
$$;

revoke all on function public.enqueue_recent_topic_vectors(integer), public.claim_topic_vector_outbox(integer), public.ack_topic_vector_outbox(uuid), public.release_topic_vector_outbox(uuid), public.topic_vector_outbox_status() from public,anon,authenticated;
grant execute on function public.enqueue_recent_topic_vectors(integer), public.claim_topic_vector_outbox(integer), public.ack_topic_vector_outbox(uuid), public.release_topic_vector_outbox(uuid), public.topic_vector_outbox_status() to service_role;
commit;
