begin;

alter table public.topic_thread_title_queue enable row level security;
alter table public.topic_thread_title_quota_state enable row level security;
alter table public.topic_thread_title_batches enable row level security;

commit;
