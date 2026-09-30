begin;
create or replace function public.begin_topic_embedding_probe(p_embedding_model text, p_quota_day_pt date, p_probe_interval_seconds integer)
returns table (allowed boolean, probe boolean, status text) language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare v_state public.topic_embedding_quota_state%rowtype;
begin
  select * into v_state from public.topic_embedding_quota_state where embedding_model=p_embedding_model for update;
  if not found or v_state.quota_day_pt = p_quota_day_pt and v_state.quota_exhausted_at is null then return query select false,false,'reset_pending'; return; end if;
  if v_state.reset_probe_started_at is not null and extract(epoch from (now()-v_state.reset_probe_started_at)) < p_probe_interval_seconds then return query select false,false,'reset_pending'; return; end if;
  update public.topic_embedding_quota_state set reset_probe_started_at=now(), updated_at=now() where embedding_model=p_embedding_model;
  return query select true,true,'probe';
end; $$;
create or replace function public.complete_topic_embedding_probe(p_embedding_model text, p_quota_day_pt date, p_success boolean)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_success then update public.topic_embedding_quota_state set quota_day_pt=p_quota_day_pt, used_today=1, quota_exhausted_at=null, reset_probe_started_at=null, first_success_after_reset=now(), updated_at=now() where embedding_model=p_embedding_model;
  else update public.topic_embedding_quota_state set updated_at=now() where embedding_model=p_embedding_model; end if;
end; $$;
create or replace function public.fail_topic_embedding_probe(p_embedding_model text, p_quota_day_pt date, p_success boolean)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$ begin update public.topic_embedding_quota_state set reset_probe_started_at=now(), updated_at=now() where embedding_model=p_embedding_model; end; $$;
revoke all on function public.begin_topic_embedding_probe(text,date,integer), public.complete_topic_embedding_probe(text,date,boolean), public.fail_topic_embedding_probe(text,date,boolean) from public, anon, authenticated;
grant execute on function public.begin_topic_embedding_probe(text,date,integer), public.complete_topic_embedding_probe(text,date,boolean), public.fail_topic_embedding_probe(text,date,boolean) to service_role;
commit;

;
