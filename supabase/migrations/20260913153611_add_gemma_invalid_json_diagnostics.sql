begin;

alter table public.topic_processing_logs
  add column if not exists gemma_http_status integer,
  add column if not exists gemma_finish_reason text,
  add column if not exists gemma_response_chars integer,
  add column if not exists gemma_response_tail_preview varchar(200),
  add column if not exists gemma_output_tokens integer,
  add column if not exists gemma_prompt_tokens integer,
  add column if not exists gemma_thinking_tokens integer,
  add column if not exists gemma_api_duration_ms integer;

alter table public.topic_processing_logs
  add constraint topic_processing_logs_gemma_http_status_check
    check (gemma_http_status is null or gemma_http_status between 100 and 599),
  add constraint topic_processing_logs_gemma_response_chars_check
    check (gemma_response_chars is null or gemma_response_chars >= 0),
  add constraint topic_processing_logs_gemma_output_tokens_check
    check (gemma_output_tokens is null or gemma_output_tokens >= 0),
  add constraint topic_processing_logs_gemma_prompt_tokens_check
    check (gemma_prompt_tokens is null or gemma_prompt_tokens >= 0),
  add constraint topic_processing_logs_gemma_thinking_tokens_check
    check (gemma_thinking_tokens is null or gemma_thinking_tokens >= 0),
  add constraint topic_processing_logs_gemma_api_duration_ms_check
    check (gemma_api_duration_ms is null or gemma_api_duration_ms >= 0);

comment on column public.topic_processing_logs.gemma_response_tail_preview is
  'Bounded to the final 160 Unicode code points of a Gemma response; never stores the full response.';

commit;
