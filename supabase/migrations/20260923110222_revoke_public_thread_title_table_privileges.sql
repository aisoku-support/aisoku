begin;

revoke all on table
  public.topic_thread_title_queue,
  public.topic_thread_title_quota_state,
  public.topic_thread_title_batches
from anon, authenticated;

commit;
