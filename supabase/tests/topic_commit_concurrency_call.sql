select * from public.commit_new_topic_384(
  'fixture-topic-concurrency-v1', '競合対象', '発表した', '競合対象 | 発表した', 'トレンド',
  'fixture concurrency', null, 'https://example.invalid/concurrency', 'fixture', now(), array['top'],
  'normal', 'new_topic',
  ('[' || array_to_string(array_fill(0.02::real, array[384]), ',') || ']')::extensions.halfvec,
  'gemini-embedding-2:384:v1', gen_random_uuid(), 'new_topic', null, null, null
);
