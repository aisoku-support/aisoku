begin;

-- The current Topic commit RPC overload is intentionally worker-only.
revoke all on function public.commit_new_topic_384(
  text, text, text, text, text, text, text[], text, text, text, text,
  timestamptz, text[], text, text, extensions.halfvec, text, uuid, text,
  text, uuid, real
) from public, anon, authenticated;
grant execute on function public.commit_new_topic_384(
  text, text, text, text, text, text, text[], text, text, text, text,
  timestamptz, text[], text, text, extensions.halfvec, text, uuid, text,
  text, uuid, real
) to service_role;

-- Thread-title RPCs run as SECURITY INVOKER and need worker-only table access.
grant all on public.topic_thread_title_queue,
  public.topic_thread_title_quota_state,
  public.topic_thread_title_batches
to service_role;

commit;
