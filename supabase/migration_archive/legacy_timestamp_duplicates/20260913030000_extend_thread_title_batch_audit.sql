begin;
alter table public.topic_thread_title_batches
  add column if not exists claim_id uuid,
  add column if not exists request_started_at timestamptz,
  add column if not exists request_finished_at timestamptz,
  add column if not exists finish_reason text,
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists thinking_tokens integer,
  add column if not exists probe boolean not null default false,
  add column if not exists failure_types jsonb;
create unique index if not exists topic_thread_title_batches_claim_id_idx on public.topic_thread_title_batches(claim_id) where claim_id is not null;
commit;
