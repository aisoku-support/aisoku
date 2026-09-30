-- These SECURITY DEFINER functions are internal maintenance/monitoring APIs.
-- Keep service_role access while removing inherited/public API execution access.
revoke execute on function public.cleanup_news_cache(bigint) from public, anon, authenticated;
revoke execute on function public.get_database_size_bytes() from public, anon, authenticated;

grant execute on function public.cleanup_news_cache(bigint) to service_role;
grant execute on function public.get_database_size_bytes() to service_role;
