begin;

create or replace function public.claim_topic_thread_title_batch(p_claim_id uuid, p_limit integer default 4)
returns table(topic_id uuid, subject text, event text, probe boolean, quota_day_pt date, used_today integer)
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_state public.topic_thread_title_quota_state%rowtype;
  v_probe boolean := false;
  v_count integer;
begin
  insert into public.topic_thread_title_quota_state(singleton, quota_day_pt)
  values (true, v_day) on conflict (singleton) do nothing;
  select s.* into v_state
    from public.topic_thread_title_quota_state as s
    where s.singleton = true for update;

  if v_state.quota_day_pt <> v_day then
    if v_state.quota_exhausted_at is not null then
      v_probe := true;
      if v_state.reset_probe_started_at is not null
         and v_state.reset_probe_started_at > now() - interval '5 minutes' then return; end if;
      update public.topic_thread_title_quota_state as s
        set reset_probe_started_at = now(), updated_at = now()
        where s.singleton = true;
    else
      update public.topic_thread_title_quota_state as s
        set quota_day_pt = v_day, used_today = 0, quota_exhausted_at = null,
            reset_probe_started_at = null, first_success_after_reset = null, updated_at = now()
        where s.singleton = true;
    end if;
  elsif v_state.used_today >= 490 or v_state.quota_exhausted_at is not null then return;
  end if;
  if v_state.last_request_started_at is not null
     and v_state.last_request_started_at > now() - interval '4.1 seconds' then return; end if;
  select count(*) into v_count from public.topic_thread_title_queue as q_count
    where q_count.status = 'pending';
  if v_count < p_limit then return; end if;

  update public.topic_thread_title_queue as q_claim
    set status = 'claimed', claim_id = p_claim_id, claimed_at = now()
    where q_claim.topic_id in (
      select q_pending.topic_id
      from public.topic_thread_title_queue as q_pending
      where q_pending.status = 'pending'
      order by q_pending.queued_at
      for update skip locked
      limit p_limit
    );
  if (select count(*) from public.topic_thread_title_queue as q_check
      where q_check.claim_id = p_claim_id and q_check.status = 'claimed') <> p_limit then return; end if;

  update public.topic_thread_title_quota_state as s
    set used_today = case when v_probe then 1 else s.used_today + 1 end,
        last_request_started_at = now(), updated_at = now()
    where s.singleton = true returning s.used_today into v_count;
  return query
    select q_result.topic_id, t.subject, t.event, v_probe, v_day, v_count
    from public.topic_thread_title_queue as q_result
    join public.topics as t on t.id = q_result.topic_id
    where q_result.claim_id = p_claim_id and q_result.status = 'claimed'
    order by q_result.queued_at;
end; $$;

revoke all on function public.claim_topic_thread_title_batch(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_topic_thread_title_batch(uuid, integer) to service_role;

commit;
