begin;

alter table public.topic_observability_logs
  add column diagnostic_details jsonb
    constraint topic_observability_logs_diagnostic_details_check
    check (
      diagnostic_details is null or (
        jsonb_typeof(diagnostic_details) = 'object'
        and pg_column_size(diagnostic_details) <= 4096
      )
    );

alter table public.topic_observability_logs
  drop constraint topic_observability_logs_operation_check,
  add constraint topic_observability_logs_operation_check
    check (operation in (
      'stage1_attempt',
      'stage2_attempt',
      'vector_search',
      'outbox_sync',
      'article_body'
    ));

alter table public.topic_observability_logs
  drop constraint topic_observability_logs_model_check,
  add constraint topic_observability_logs_model_check
    check (
      model is null or model in (
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-20b',
        'gemma-4-26b-a4b-it'
      )
    );

alter table public.topic_observability_logs
  drop constraint topic_observability_logs_payload_check,
  add constraint topic_observability_logs_payload_check check (
    (operation = 'stage1_attempt' and model is not null and attempt_no is not null and model_role is not null)
    or (operation = 'stage2_attempt' and batch_id is not null and model is not null)
    or (operation = 'vector_search' and article_id is not null and embedding_version is not null)
    or (operation = 'outbox_sync' and item_count is not null)
    or (operation = 'article_body' and article_id is not null and article_body_chars is not null)
  );

commit;
