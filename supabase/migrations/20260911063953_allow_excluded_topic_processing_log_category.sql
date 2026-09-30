begin;
alter table public.topic_processing_logs
  drop constraint topic_processing_logs_classified_category_check;
alter table public.topic_processing_logs
  add constraint topic_processing_logs_classified_category_check
  check (classified_category is null or classified_category in ('トレンド', 'エンタメ', 'サブカル', 'マネー', 'IT・ガジェット', '除外'));
commit;
