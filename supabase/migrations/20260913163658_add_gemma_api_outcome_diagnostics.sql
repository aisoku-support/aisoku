begin;

alter table public.topic_processing_logs
  add column if not exists gemma_block_reason text,
  add column if not exists gemma_api_completed boolean;

comment on column public.topic_processing_logs.gemma_api_completed is
  'True when Gemma returned an HTTP-success response that reached parser validation; false for transport/HTTP failures.';

commit;
