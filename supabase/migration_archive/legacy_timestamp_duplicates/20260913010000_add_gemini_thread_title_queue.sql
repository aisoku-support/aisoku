begin;

create table public.topic_thread_title_queue (
  topic_id uuid primary key references public.topics(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','claimed','success','failed')),
  queued_at timestamptz not null default now(), claimed_at timestamptz, claim_id uuid,
  finalized_at timestamptz, failure_status text
);
alter table public.topics add column thread_title_pending boolean not null default false;
create index topic_thread_title_queue_pending_idx on public.topic_thread_title_queue (queued_at) where status = 'pending';
create or replace function public.enqueue_topic_thread_title() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if new.creation_mode <> 'gemma_failed' and nullif(btrim(new.subject),'') is not null and nullif(btrim(new.event),'') is not null then
    update public.topics set thread_title_pending=true where id=new.id;
    insert into public.topic_thread_title_queue(topic_id) values(new.id) on conflict do nothing;
  end if;
  return new;
end; $$;
create trigger topics_enqueue_thread_title after insert on public.topics for each row execute function public.enqueue_topic_thread_title();

create table public.topic_thread_title_quota_state (
  singleton boolean primary key default true check (singleton), quota_day_pt date not null,
  used_today integer not null default 0, quota_exhausted_at timestamptz, reset_probe_started_at timestamptz,
  first_success_after_reset timestamptz, last_request_started_at timestamptz, updated_at timestamptz not null default now()
);
create table public.topic_thread_title_batches (
  id uuid primary key, model text not null, thinking_level text not null, batch_size integer not null,
  http_status integer, attempts integer not null default 1, duration_ms integer, quota_day_pt date, used_today_at_request integer,
  success_count integer, failure_count integer, created_at timestamptz not null default now()
);

create or replace function public.claim_topic_thread_title_batch(p_claim_id uuid, p_limit integer default 4)
returns table(topic_id uuid, subject text, event text, probe boolean, quota_day_pt date, used_today integer)
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_day date := (now() at time zone 'America/Los_Angeles')::date; v_state public.topic_thread_title_quota_state%rowtype; v_probe boolean := false; v_count integer;
begin
  insert into public.topic_thread_title_quota_state(singleton, quota_day_pt) values(true, v_day) on conflict(singleton) do nothing;
  select * into v_state from public.topic_thread_title_quota_state where singleton=true for update;
  if v_state.quota_day_pt <> v_day then
    if v_state.quota_exhausted_at is not null then
      v_probe := true;
      if v_state.reset_probe_started_at is not null and v_state.reset_probe_started_at > now() - interval '5 minutes' then return; end if;
      update public.topic_thread_title_quota_state set reset_probe_started_at=now(), updated_at=now() where singleton=true;
    else update public.topic_thread_title_quota_state set quota_day_pt=v_day, used_today=0, quota_exhausted_at=null, reset_probe_started_at=null, first_success_after_reset=null, updated_at=now() where singleton=true; end if;
  elsif v_state.used_today >= 490 or v_state.quota_exhausted_at is not null then return; end if;
  if v_state.last_request_started_at is not null and v_state.last_request_started_at > now() - interval '4.1 seconds' then return; end if;
  select count(*) into v_count from public.topic_thread_title_queue where status='pending'; if v_count < p_limit then return; end if;
  update public.topic_thread_title_queue q set status='claimed', claim_id=p_claim_id, claimed_at=now() where q.topic_id in (select topic_id from public.topic_thread_title_queue where status='pending' order by queued_at for update skip locked limit p_limit);
  if (select count(*) from public.topic_thread_title_queue where claim_id=p_claim_id and status='claimed') <> p_limit then return; end if;
  update public.topic_thread_title_quota_state set used_today=case when v_probe then 1 else used_today+1 end, last_request_started_at=now(), updated_at=now() where singleton=true returning used_today into v_count;
  return query select q.topic_id,t.subject,t.event,v_probe,v_day,v_count from public.topic_thread_title_queue q join public.topics t on t.id=q.topic_id where q.claim_id=p_claim_id and q.status='claimed' order by q.queued_at;
end; $$;

create or replace function public.finalize_topic_thread_title_batch(p_claim_id uuid, p_results jsonb, p_probe boolean, p_http_status integer, p_duration_ms integer)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r jsonb; v_success integer:=0; v_fail integer:=0; v_day date := (now() at time zone 'America/Los_Angeles')::date;
begin
  for r in select * from jsonb_array_elements(p_results) loop
    if r->>'status'='success' then update public.topics set thread_title=r->>'title' where id=(r->>'id')::uuid; v_success:=v_success+1; else v_fail:=v_fail+1; end if;
    update public.topics set thread_title_pending=false where id=(r->>'id')::uuid;
    update public.topic_thread_title_queue set status=case when r->>'status'='success' then 'success' else 'failed' end, finalized_at=now(), failure_status=case when r->>'status'='success' then null else r->>'status' end where topic_id=(r->>'id')::uuid and claim_id=p_claim_id;
  end loop;
  if p_probe and p_http_status=429 then update public.topics set thread_title_pending=true where id in (select topic_id from public.topic_thread_title_queue where claim_id=p_claim_id); update public.topic_thread_title_queue set status='pending',claim_id=null,claimed_at=null,finalized_at=null,failure_status=null where claim_id=p_claim_id; return; end if;
  if p_probe and v_success>0 then update public.topic_thread_title_quota_state set quota_day_pt=v_day, quota_exhausted_at=null, reset_probe_started_at=null, first_success_after_reset=now(), updated_at=now() where singleton=true; end if;
  if p_http_status=429 and not p_probe then update public.topic_thread_title_quota_state set quota_exhausted_at=now(),updated_at=now() where singleton=true; end if;
end; $$;

revoke all on function public.claim_topic_thread_title_batch(uuid,integer), public.finalize_topic_thread_title_batch(uuid,jsonb,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_topic_thread_title_batch(uuid,integer), public.finalize_topic_thread_title_batch(uuid,jsonb,boolean,integer,integer) to service_role;
commit;
