-- Run against a disposable database after the V1 migration, as an administrator.
-- All test rows are rolled back. No pgTAP extension required.
begin;
do $$
declare
  ad_id uuid := gen_random_uuid();
  shared_id uuid := gen_random_uuid();
  local_id uuid := gen_random_uuid();
  opportunity_id uuid := gen_random_uuid();
  data jsonb;
  payload jsonb;
  field_name text;
begin
  data := jsonb_build_object('adInstanceId', ad_id, 'adFormat', 'native',
    'screen', 'thread', 'placement', 'postContribution',
    'adOpportunityId', opportunity_id, 'sharedGenerationId', shared_id,
    'localGenerationId', local_id, 'valueMicros', 1000,
    'currency', 'USD', 'precision', 'precise');
  payload := jsonb_build_object('eventId', gen_random_uuid(), 'entityId', ad_id,
    'kind', 'ad_paid', 'occurredAt', now(), 'isTest', true, 'data', data);
  perform public.record_monetization_events(jsonb_build_array(payload));
  perform public.record_monetization_events(jsonb_build_array(payload));
  payload := jsonb_set(payload, '{eventId}', to_jsonb(gen_random_uuid()));
  perform public.record_monetization_events(jsonb_build_array(payload));
  if (select count(*) from public.monetization_events where entity_id = ad_id and kind = 'ad_paid') <> 1 then
    raise exception 'paid event deduplication failed';
  end if;
  if (select sum(value_micros) from public.ad_instance_metrics where ad_instance_id = ad_id) <> 1000 then
    raise exception 'physical revenue duplicated by multiple relationships';
  end if;
  if not exists (select 1 from public.ad_instance_metrics where ad_instance_id = ad_id
    and shared_generation_id = shared_id and local_generation_id = local_id and not impression) then
    raise exception 'relations or impression/revenue separation failed';
  end if;
  if has_table_privilege('anon', 'public.monetization_events', 'SELECT') then
    raise exception 'raw telemetry must not be publicly readable';
  end if;
  foreach field_name in array array['position', 'threadAdSequence'] loop
    begin
      perform public.record_monetization_events(jsonb_build_array(
        jsonb_set(payload, array['data', field_name], '2147483648'::jsonb)));
      raise exception 'out-of-range integer accepted: %', field_name;
    exception when numeric_value_out_of_range then
      null;
    end;
  end loop;
  begin
    perform public.record_monetization_events(null);
    raise exception 'SQL NULL batch accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid telemetry batch' then raise; end if;
  end;
  if has_table_privilege('authenticated', 'public.monetization_events', 'INSERT')
    or has_table_privilege('anon', 'public.ad_instance_metrics', 'SELECT')
    or has_table_privilege('authenticated', 'public.ai_generation_metrics', 'SELECT') then
    raise exception 'telemetry permissions too broad';
  end if;
  if not has_function_privilege('anon', 'public.record_monetization_events(jsonb)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.record_monetization_events(jsonb)', 'EXECUTE') then
    raise exception 'telemetry RPC must be callable';
  end if;
end;
$$;
rollback;
