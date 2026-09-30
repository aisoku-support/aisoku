begin;
update public.topic_embedding_quota_state
set embedding_model = 'gemini-embedding-001'
where embedding_model = 'gemini-embedding-1'
  and not exists (select 1 from public.topic_embedding_quota_state where embedding_model = 'gemini-embedding-001');
update public.topic_embeddings_384
set embedding_version = replace(embedding_version, 'gemini-embedding-1:', 'gemini-embedding-001:')
where embedding_version like 'gemini-embedding-1:%';
update public.topic_processing_logs
set embedding_model = 'gemini-embedding-001', embedding_version = replace(embedding_version, 'gemini-embedding-1:', 'gemini-embedding-001:')
where embedding_model = 'gemini-embedding-1' or embedding_version like 'gemini-embedding-1:%';
commit;

;
