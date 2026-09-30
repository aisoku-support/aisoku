begin;

do $$
declare
  v_model text := 'quota-test-' || gen_random_uuid()::text;
  v_other text := 'quota-test-other-' || gen_random_uuid()::text;
  v_result record;
begin
  insert into public.topic_embedding_quota_state
    (embedding_model, quota_day_pt, used_today, quota_exhausted_at)
  values (v_model, date '2026-01-14', 747, null),
         (v_other, date '2026-01-14', 900, now());

  select * into v_result from public.reserve_topic_embedding_quota(v_model, date '2026-01-15', 990);
  if not v_result.allowed or v_result.used_today <> 1 then
    raise exception 'non-exhausted PT rollover did not reserve on new day';
  end if;
  if (select quota_day_pt from public.topic_embedding_quota_state where embedding_model = v_model) <> date '2026-01-15'
     or (select used_today from public.topic_embedding_quota_state where embedding_model = v_model) <> 1 then
    raise exception 'non-exhausted PT rollover state is incorrect';
  end if;

  select * into v_result from public.reserve_topic_embedding_quota(v_other, date '2026-01-15', 990);
  if v_result.allowed or v_result.status <> 'unavailable' then
    raise exception 'exhausted PT rollover bypassed probe path';
  end if;
  if (select quota_day_pt from public.topic_embedding_quota_state where embedding_model = v_other) <> date '2026-01-14' then
    raise exception 'exhausted model was rolled over unexpectedly';
  end if;
end;
$$;

rollback;
