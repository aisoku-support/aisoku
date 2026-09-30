-- The Topic title generation contract is 47 characters. The original remote
-- migration used 50, so enforce the current specification without replaying it.
begin;

alter table public.topics
  drop constraint if exists topics_thread_title_check;

alter table public.topics
  add constraint topics_thread_title_check
  check (thread_title is null or char_length(thread_title) between 1 and 47);

commit;
