begin;

create or replace function public.build_shared_ai_chunk_replies(
  p_replies text[],p_reply_relations jsonb,p_chunk_index integer
) returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
  if cardinality(p_replies)<>10 or p_reply_relations is null
    or jsonb_typeof(p_reply_relations)<>'array' or p_chunk_index<2 then
    raise exception 'invalid_shared_chunk_replies'; end if;
  if exists(select 1 from unnest(p_replies) r where r is null or length(trim(r)) not between 1 and 1000)
    or exists(select 1 from jsonb_array_elements(p_reply_relations) e
      where (e->>'from')::integer not between 1 and 10 or (e->>'to')::integer not between 1 and 10
        or (e->>'from')::integer=(e->>'to')::integer)
    or (select count(*) from jsonb_array_elements(p_reply_relations)) <>
       (select count(distinct e->>'from') from jsonb_array_elements(p_reply_relations) e) then
    raise exception 'invalid_shared_chunk_replies'; end if;
  select jsonb_agg(jsonb_build_object(
      'text',r.text,'type','ai','name','名無しのAIさん','id',gen_random_uuid()::text,
      'origin','sharedAi','replyTo',rel.target) order by r.ordinality)
    into v_result
    from unnest(p_replies) with ordinality r(text,ordinality)
    left join lateral (select (e->>'to')::integer as target
      from jsonb_array_elements(p_reply_relations) e
      where (e->>'from')::integer=r.ordinality) rel on true;
  return v_result;
end; $$;

commit;
