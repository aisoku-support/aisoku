begin;

create or replace function public.reserve_topic_embedding_quota(
  p_embedding_model text,
  p_quota_day_pt date,
  p_internal_limit integer default 990
)
returns table (allowed boolean, status text, used_today integer)
language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  insert into public.topic_embedding_quota_state(embedding_model, quota_day_pt)
  values (p_embedding_model, p_quota_day_pt)
  on conflict (embedding_model) do nothing;

  -- A non-exhausted state rolls over lazily at the first reservation of the
  -- new PT day. Exhausted states must continue through the probe path.
  update public.topic_embedding_quota_state
  set quota_day_pt = p_quota_day_pt,
      used_today = 0,
      quota_exhausted_at = null,
      reset_probe_started_at = null,
      first_success_after_reset = null,
      updated_at = now()
  where embedding_model = p_embedding_model
    and quota_day_pt <> p_quota_day_pt
    and quota_exhausted_at is null;

  return query
  update public.topic_embedding_quota_state s
  set used_today = s.used_today + 1, updated_at = now()
  where s.embedding_model = p_embedding_model
    and s.quota_day_pt = p_quota_day_pt
    and s.quota_exhausted_at is null
    and s.reset_probe_started_at is null
    and s.used_today < p_internal_limit
  returning true, 'reserved', s.used_today;

  if not found then
    return query select false, 'unavailable', s.used_today
      from public.topic_embedding_quota_state s
      where s.embedding_model = p_embedding_model;
  end if;
end; $$;

revoke all on function public.reserve_topic_embedding_quota(text, date, integer) from public, anon, authenticated;
grant execute on function public.reserve_topic_embedding_quota(text, date, integer) to service_role;

commit;
