-- Topic facts are aggregated at Topic level.  Keep article provenance out of V1.
begin;

alter table public.topics add column facts text[] not null default '{}';
alter table public.topic_processing_logs add column fact_count integer;
alter table public.topic_processing_logs add column topic_fact_count integer;
alter table public.topic_processing_logs add column publishable boolean;
alter table public.topic_processing_queue drop constraint if exists topic_processing_queue_terminal_status_check;
alter table public.topic_processing_queue add constraint topic_processing_queue_terminal_status_check check (terminal_status is null or terminal_status in ('completed','excluded','excluded_missing_title','excluded_missing_description','excluded_invalid_article','already_processed','failed_gemma','failed_embedding','failed_search','failed_db','fallback_singleton'));
alter table public.topic_processing_logs drop constraint if exists topic_processing_logs_status_check;
alter table public.topic_processing_logs add constraint topic_processing_logs_status_check check (status in (
  'merged','new_topic','excluded','excluded_missing_title','excluded_missing_description',
  'excluded_invalid_article','already_processed','failed_gemma','failed_embedding','failed_search','failed_db','duplicate_skipped'
));

create or replace function public.normalize_topic_facts(p_facts text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(value order by first_pos), '{}')
  from (
    select value, min(pos) as first_pos
    from unnest(coalesce(p_facts, '{}')) with ordinality as x(raw, pos)
    cross join lateral (select btrim(raw) as value) v
    where v.value <> '' group by value
  ) s
$$;

create or replace function public.enqueue_topic_thread_title() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if new.creation_mode <> 'gemma_failed' and cardinality(new.facts) >= 1
     and nullif(btrim(new.subject),'') is not null and nullif(btrim(new.event),'') is not null then
    update public.topics set thread_title_pending=true where id=new.id;
    insert into public.topic_thread_title_queue(topic_id) values(new.id) on conflict do nothing;
  end if;
  return new;
end; $$;

create or replace function public.enqueue_topic_thread_title_on_facts() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if old.thread_title is null and not old.thread_title_pending and old.creation_mode <> 'gemma_failed'
     and cardinality(old.facts) < 1 and cardinality(new.facts) >= 1 then
    update public.topics set thread_title_pending=true where id=new.id;
    insert into public.topic_thread_title_queue(topic_id) values(new.id) on conflict do nothing;
  end if;
  return new;
end; $$;
create trigger topics_enqueue_thread_title_on_facts after update of facts on public.topics for each row execute function public.enqueue_topic_thread_title_on_facts();

create or replace function public.commit_new_topic_384(
  p_article_id text, p_subject text, p_event text, p_topic_text text, p_category text, p_thread_title text,
  p_facts text[], p_representative_title text, p_representative_description text, p_representative_url text,
  p_representative_source text, p_representative_published_at timestamptz, p_source_category text[],
  p_creation_mode text, p_match_method text, p_embedding extensions.halfvec(384), p_embedding_version text,
  p_batch_id uuid, p_log_status text, p_error_type text default null, p_candidate_topic_id uuid default null,
  p_candidate_similarity real default null
) returns table(topic_id uuid, outcome text) language plpgsql security invoker set search_path=pg_catalog,public,extensions as $$
declare v_topic_id uuid; v_seen_at timestamptz:=coalesce(p_representative_published_at,now()); v_facts text[]:=public.normalize_topic_facts(p_facts);
begin
  if p_article_id is null or btrim(p_article_id)='' or p_subject is null or btrim(p_subject)='' or p_event is null or btrim(p_event)='' or p_topic_text is null or btrim(p_topic_text)='' then raise exception 'invalid topic input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_article_id,0)); select ta.topic_id into v_topic_id from public.topic_articles ta where ta.article_id=p_article_id;
  if v_topic_id is not null then update public.topic_processing_queue set terminal_status='completed',processed_at=now() where article_id=p_article_id; return query select v_topic_id,'duplicate_skipped'::text; return; end if;
  insert into public.topics(subject,event,topic_text,category,thread_title,facts,representative_article_id,representative_title,representative_description,representative_url,representative_source,representative_published_at,first_seen_at,last_seen_at,article_count,creation_mode)
  values(p_subject,p_event,p_topic_text,p_category,p_thread_title,v_facts,p_article_id,p_representative_title,p_representative_description,p_representative_url,p_representative_source,p_representative_published_at,v_seen_at,v_seen_at,1,p_creation_mode) returning id into v_topic_id;
  insert into public.topic_articles(topic_id,article_id,source,published_at,similarity,match_method,source_category,classified_category) values(v_topic_id,p_article_id,p_representative_source,p_representative_published_at,null,p_match_method,p_source_category,p_category);
  if p_embedding is not null then insert into public.topic_embeddings_384(topic_id,embedding,embedding_version) values(v_topic_id,p_embedding,p_embedding_version); end if;
  insert into public.topic_processing_logs(article_id,topic_id,candidate_topic_id,status,stage,error_type,embedding_version,similarity,source_category,classified_category,batch_id,fact_count,topic_fact_count,publishable) values(p_article_id,v_topic_id,p_candidate_topic_id,p_log_status,'topic_commit',p_error_type,p_embedding_version,p_candidate_similarity,p_source_category,p_category,p_batch_id,cardinality(v_facts),cardinality(v_facts),cardinality(v_facts)>=1);
  update public.topic_processing_queue set terminal_status=case when p_match_method='fallback_singleton' then 'fallback_singleton' else 'completed' end,processed_at=now() where article_id=p_article_id; return query select v_topic_id,p_log_status;
end; $$;

create or replace function public.commit_topic_merge(p_article_id text,p_topic_id uuid,p_source text,p_published_at timestamptz,p_similarity real,p_source_category text[],p_classified_category text,p_embedding_version text,p_batch_id uuid,p_facts text[])
returns table(topic_id uuid,outcome text) language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_existing uuid; v_facts text[]; begin
  perform pg_advisory_xact_lock(hashtextextended(p_article_id,0)); select topic_id into v_existing from public.topic_articles where article_id=p_article_id;
  if v_existing is not null then update public.topic_processing_queue set terminal_status='completed',processed_at=now() where article_id=p_article_id; return query select v_existing,'duplicate_skipped'::text; return; end if;
  update public.topics set facts=public.normalize_topic_facts(facts || coalesce(p_facts,'{}')),article_count=article_count+1,last_seen_at=greatest(last_seen_at,coalesce(p_published_at,now())) where id=p_topic_id returning facts into v_facts;
  if not found then raise exception 'target topic not found'; end if;
  insert into public.topic_articles(topic_id,article_id,source,published_at,similarity,match_method,source_category,classified_category) values(p_topic_id,p_article_id,p_source,p_published_at,p_similarity,'similarity_merge',p_source_category,p_classified_category);
  insert into public.topic_processing_logs(article_id,topic_id,candidate_topic_id,status,stage,embedding_version,similarity,source_category,classified_category,batch_id,fact_count,topic_fact_count,publishable) values(p_article_id,p_topic_id,p_topic_id,'merged','topic_commit',p_embedding_version,p_similarity,p_source_category,p_classified_category,p_batch_id,cardinality(public.normalize_topic_facts(p_facts)),cardinality(v_facts),cardinality(v_facts)>=1);
  update public.topic_processing_queue set terminal_status='completed',processed_at=now() where article_id=p_article_id; return query select p_topic_id,'merged'::text;
end; $$;

grant execute on function public.commit_new_topic_384(text,text,text,text,text,text,text[],text,text,text,text,timestamptz,text[],text,text,extensions.halfvec,text,uuid,text,text,uuid,real) to service_role;
grant execute on function public.commit_topic_merge(text,uuid,text,timestamptz,real,text[],text,text,uuid,text[]) to service_role;
commit;
