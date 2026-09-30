-- Separate from shared AI cache, reply reports and RSS. Client SDK telemetry;
-- paid values are estimates supplied by the SDK, not a settlement ledger.
-- Apply atomically. Re-running stops at CREATE TABLE without altering existing data.
begin;

create table public.monetization_events (
  event_id uuid primary key,
  entity_id uuid not null,
  kind text not null check (kind in (
    'ad_slot_created', 'ad_load_requested', 'ad_loaded', 'ad_load_failed',
    'ad_impression', 'ad_paid', 'ad_link_updated',
    'generation_started', 'generation_completed', 'contribution'
  )),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  is_test boolean not null,
  data jsonb not null check (jsonb_typeof(data) = 'object')
);

create unique index monetization_once_per_entity_event
  on public.monetization_events(entity_id, kind)
  where kind <> 'ad_link_updated';
create index monetization_events_time on public.monetization_events(occurred_at);
create index monetization_events_data on public.monetization_events using gin(data);
alter table public.monetization_events enable row level security;
revoke all on public.monetization_events from public, anon, authenticated;

create function public.record_monetization_events(p_events jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  e jsonb;
  d jsonb;
  k text;
  field_name text;
  allowed_keys text[] := array[
    'adInstanceId','adFormat','screen','placement','category','position',
    'adOpportunityId','threadAdSequence','threadSessionId',
    'replacedNormalAdInstanceId','sharedGenerationId','localGenerationId',
    'contributionId','valueMicros','currency','precision','errorCode',
    'generationId','model','generationType','inputTokens','outputTokens',
    'thoughtTokens','apiCost','costCurrency','success'
  ];
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'Invalid telemetry batch';
  end if;
  if jsonb_array_length(p_events) > 50 then
    raise exception 'Invalid telemetry batch';
  end if;
  for e in select value from jsonb_array_elements(p_events) loop
    d := e->'data'; k := e->>'kind';
    if d is null or jsonb_typeof(d) <> 'object' or octet_length(d::text) > 4096
      or exists (select 1 from jsonb_object_keys(d) as fields(key) where not key = any(allowed_keys)) then
      raise exception 'Invalid telemetry data';
    end if;
    foreach field_name in array array[
      'adOpportunityId','threadSessionId','replacedNormalAdInstanceId',
      'sharedGenerationId','localGenerationId','contributionId','generationId'
    ] loop
      perform (d->>field_name)::uuid;
    end loop;
    foreach field_name in array array['position','threadAdSequence'] loop
      if (d->>field_name)::integer < 0 then raise exception 'Invalid numeric measurement'; end if;
    end loop;
    foreach field_name in array array['inputTokens','outputTokens','thoughtTokens'] loop
      if (d->>field_name)::bigint < 0 then raise exception 'Invalid numeric measurement'; end if;
    end loop;
    perform (d->>'success')::boolean;
    if (d->>'apiCost')::numeric < 0 then raise exception 'Invalid API cost'; end if;
    if k like 'ad_%' then
      if d->>'adInstanceId' is distinct from e->>'entityId'
        or coalesce(d->>'adFormat','') not in ('banner','native')
        or coalesce(d->>'screen','') not in ('news','thread')
        or coalesce(d->>'placement','') not in ('fixedBanner','newsTop','newsInterval','normalComment','postContribution') then
        raise exception 'Invalid ad identity';
      end if;
      if k = 'ad_paid' and (
        coalesce(d->>'valueMicros','') !~ '^[0-9]+(\.[0-9]+)?$'
        or coalesce(d->>'currency','') !~ '^[A-Z]{3}$'
        or coalesce(d->>'precision','') not in ('unknown','estimated','publisherProvided','precise')
      ) then raise exception 'Invalid paid event'; end if;
    elsif k like 'generation_%' then
      if d->>'generationId' is distinct from e->>'entityId'
        or coalesce(d->>'generationType','') not in ('sharedAi','localAi') then
        raise exception 'Invalid generation identity';
      end if;
    elsif k = 'contribution' then
      if d->>'contributionId' is distinct from e->>'entityId' then
        raise exception 'Invalid contribution identity';
      end if;
    end if;
    insert into public.monetization_events(event_id, entity_id, kind, occurred_at, is_test, data)
    values ((e->>'eventId')::uuid, (e->>'entityId')::uuid, k,
      (e->>'occurredAt')::timestamptz, (e->>'isTest')::boolean, d)
    on conflict do nothing;
  end loop;
end;
$$;
revoke all on function public.record_monetization_events(jsonb) from public;
grant execute on function public.record_monetization_events(jsonb) to anon, authenticated;

create view public.ad_instance_metrics with (security_invoker = true) as
with identities as (
  select distinct on (entity_id) entity_id, is_test, data
  from public.monetization_events where kind like 'ad_%'
  order by entity_id, (data->>'localGenerationId' is not null) desc,
    occurred_at desc, received_at desc, event_id desc
), lifecycle as (
  select entity_id,
    bool_or(kind = 'ad_load_requested') as load_requested,
    bool_or(kind = 'ad_loaded') as loaded,
    bool_or(kind = 'ad_load_failed') as load_failed,
    bool_or(kind = 'ad_impression') as impression
  from public.monetization_events where kind like 'ad_%' group by entity_id
)
select i.entity_id as ad_instance_id, i.is_test,
  i.data->>'adFormat' as ad_format, i.data->>'screen' as screen,
  i.data->>'placement' as placement, i.data->>'category' as category,
  (i.data->>'position')::integer as position,
  (i.data->>'adOpportunityId')::uuid as ad_opportunity_id,
  (i.data->>'threadAdSequence')::integer as thread_ad_sequence,
  (i.data->>'threadSessionId')::uuid as thread_session_id,
  (i.data->>'sharedGenerationId')::uuid as shared_generation_id,
  (i.data->>'localGenerationId')::uuid as local_generation_id,
  (i.data->>'contributionId')::uuid as contribution_id,
  (i.data->>'replacedNormalAdInstanceId')::uuid as replaced_normal_ad_instance_id,
  l.load_requested, l.loaded, l.load_failed, l.impression,
  (p.data->>'valueMicros')::numeric as value_micros,
  p.data->>'currency' as currency, p.data->>'precision' as precision
from identities i join lifecycle l using(entity_id)
left join public.monetization_events p on p.entity_id = i.entity_id and p.kind = 'ad_paid';

create view public.ai_generation_metrics with (security_invoker = true) as
select s.entity_id as generation_id, s.is_test, s.occurred_at as requested_at,
  s.data->>'model' as model, s.data->>'generationType' as generation_type,
  (s.data->>'contributionId')::uuid as contribution_id,
  (c.data->>'inputTokens')::bigint as input_tokens,
  (c.data->>'outputTokens')::bigint as output_tokens,
  (c.data->>'thoughtTokens')::bigint as thought_tokens,
  (c.data->>'apiCost')::numeric as api_cost, c.data->>'costCurrency' as cost_currency,
  (c.data->>'success')::boolean as success
from public.monetization_events s left join public.monetization_events c
  on s.entity_id = c.entity_id and c.kind = 'generation_completed'
where s.kind = 'generation_started';

revoke all on public.ad_instance_metrics, public.ai_generation_metrics from public, anon, authenticated;
grant select on public.monetization_events, public.ad_instance_metrics, public.ai_generation_metrics to service_role;

commit;;
