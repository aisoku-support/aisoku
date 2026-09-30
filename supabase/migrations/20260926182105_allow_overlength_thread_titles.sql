begin;

-- The 47-character target remains a prompt guideline. Generated titles longer
-- than that are retained; blank titles are still rejected by the constraint.
alter table public.topics
  drop constraint if exists topics_thread_title_check;

alter table public.topics
  add constraint topics_thread_title_check
  check (thread_title is null or char_length(thread_title) >= 1);

commit;
