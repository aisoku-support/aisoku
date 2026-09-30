begin;

-- Server-owned shared chunk RPCs run as service_role and read stored replies
-- from thread_chunks. Keep the grant limited to the required column.
grant select (replies) on table public.thread_chunks to service_role;

commit;
