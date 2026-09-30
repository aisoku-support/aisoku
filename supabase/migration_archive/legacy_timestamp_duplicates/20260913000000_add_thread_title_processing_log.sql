begin;

alter table public.topic_processing_logs
  add column if not exists thread_title_status text,
  add column if not exists thread_title_attempts integer,
  add column if not exists thread_title_duration_ms integer;

alter table public.topic_processing_logs
  add constraint topic_processing_logs_thread_title_status_check
  check (thread_title_status is null or thread_title_status in ('success', 'timeout', 'invalid_json', 'empty', 'too_long', 'schema_invalid', 'rate_limit', 'http_5xx', 'network_error'));
alter table public.topic_processing_logs
  add constraint topic_processing_logs_thread_title_attempts_check
  check (thread_title_attempts is null or thread_title_attempts between 0 and 2);
alter table public.topic_processing_logs
  add constraint topic_processing_logs_thread_title_duration_ms_check
  check (thread_title_duration_ms is null or thread_title_duration_ms >= 0);

create index if not exists topic_processing_logs_thread_title_status_idx
  on public.topic_processing_logs(thread_title_status)
  where thread_title_status is not null;
commit;
