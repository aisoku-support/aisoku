begin;

create table public.topic_cache_publish_state (
  singleton boolean primary key default true check (singleton),
  completed_since_publish integer not null default 0 check (completed_since_publish between 0 and 9),
  updated_at timestamptz not null default now()
);

insert into public.topic_cache_publish_state (singleton) values (true);

alter table public.topic_cache_publish_state enable row level security;
revoke all on public.topic_cache_publish_state from public, anon, authenticated;
grant all on public.topic_cache_publish_state to service_role;

create or replace function public.record_topic_completion_for_cache()
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_completed integer;
begin
  select completed_since_publish into v_completed
  from public.topic_cache_publish_state
  where singleton = true
  for update;

  if v_completed >= 9 then
    update public.topic_cache_publish_state
    set completed_since_publish = 0, updated_at = now()
    where singleton = true;
    return true;
  end if;

  update public.topic_cache_publish_state
  set completed_since_publish = v_completed + 1, updated_at = now()
  where singleton = true;
  return false;
end;
$$;

revoke all on function public.record_topic_completion_for_cache() from public, anon, authenticated;
grant execute on function public.record_topic_completion_for_cache() to service_role;

commit;
