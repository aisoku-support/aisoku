import fs from 'node:fs/promises';
import path from 'node:path';
const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/^([A-Za-z]):/, '$1:')), 'results');
const jsonPath = path.join(dir, 'real_news_embedding_comparison.json');
const mdPath = path.join(dir, 'real_news_embedding_comparison.md');
const x = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
x.started_at = '2026-09-26T06:05:48.914Z';
for (const m of Object.values(x.models)) {
  m.timing.observed_wall_time_ms = m.timing.total_ms;
  m.timing.mean_ms_per_article = m.timing.total_ms / x.dataset.included_articles;
  m.timing.mean_api_latency_ms_per_article = m.dimensions === 1536
    ? (m.timing.upsert_ms + m.timing.fetch_ms) / m.usage.query_articles
    : m.timing.batch_latencies_ms.reduce((s, v) => s + v, 0) / m.usage.input_articles;
}
x.models['gemini-embedding-001'].usage.counted_input_tokens = 22086;
x.models['gemini-embedding-001'].usage.total_input_tokens = null;
x.models['gemini-embedding-001'].usage.usage_metadata_available = false;
x.models['gemini-embedding-2'].usage.counted_input_tokens = 22086;
x.models['gemini-embedding-2'].usage.usage_metadata_available = true;
Object.assign(x.models.upstash_text_embedding_3_small.usage, {
  api_requests: 4,
  info_http_requests: 1,
  vector_upsert_records: 199,
  vectors_fetched_for_scoring: 199,
  vectors_deleted: 199,
  cleanup_verification_fetches: 1,
  unit_estimate_note: 'HTTP/API operation counts; not a billing-unit claim.'
});
x.api_attempt_diagnostics = {
  resolved_errors: [{
    service: 'Upstash Vector', endpoint: 'query-data in isolated test namespace', http_status: 400,
    request_shape: 'batch of 10 raw-text queries, topK=199 each', processed_queries: 0,
    provider_error_body_retained: false,
    cause: 'The endpoint rejected this request shape with HTTP 400; the provider message was not retained, so a more specific cause cannot be established.',
    resolution: 'Switched to fetching the 199 vectors by run-owned IDs and calculated all pairwise cosine similarities locally.',
    cleanup: 'The 199 vectors created by the failed attempt were deleted and absence was verified before continuing.'
  }],
  total_google_embedding_requests: 40,
  total_google_articles_embedded: 398,
  upstash_across_attempts: { info_requests: 2, upsert_requests: 2, upsert_records: 398, failed_query_requests: 1, processed_queries: 0, scoring_fetch_requests: 1, fetched_vectors: 199, delete_requests: 2, deleted_records: 398, cleanup_verification_fetches: 2, run_owned_vectors_remaining: 0 }
};
x.cleanup.total_run_owned_ids_deleted_across_attempts = 398;
x.cleanup.verified_absent = true;
await fs.writeFile(jsonPath, JSON.stringify(x, null, 2) + '\n', 'utf8');

let md = await fs.readFile(mdPath, 'utf8');
md = md.replace('2026-09-26T06:13:48.907Z', x.started_at);
md = md.replace('| gemini-embedding-001 | 384 | 199 | 20 | 116.4 ms |', `| gemini-embedding-001 | 384 | 199 | 20 | ${x.models['gemini-embedding-001'].timing.mean_ms_per_article.toFixed(1)} ms |`);
md = md.replace('| gemini-embedding-2 | 384 | 199 | 20 | 137.0 ms |', `| gemini-embedding-2 | 384 | 199 | 20 | ${x.models['gemini-embedding-2'].timing.mean_ms_per_article.toFixed(1)} ms |`);
md = md.replace('| upstash_text_embedding_3_small | 1536 | 199 | 3 | 15.3 ms |', `| upstash_text_embedding_3_small | 1536 | 199 | 4 | ${x.models.upstash_text_embedding_3_small.timing.mean_ms_per_article.toFixed(1)} ms |`);
md += `\n\n## API使用量と実行時の例外\n\nGoogle: Embedding 001とEmbedding 2を各199記事、各20 batchEmbedContents requestsで処理（計40 requests）。countTokens実測値は各22,086 tokens。Embedding 2の応答usageMetadata合計も22,086 tokens。Embedding 001応答にはusageMetadataがなく、API実使用量は応答から確認できないためcountTokens値を別記。429/503は発生せず。\n\nUpstash成功した最終試行: 199 upsert records、199 vectors fetch、199 records delete、cleanup verification fetchを実施。HTTP requestはinfo 1、upsert 1、score用fetch 1、delete 1、verification fetch 1。さらに初回にbatch query-data（10 query items、各topK=199）がHTTP 400となり、処理済みqueryは0件。エラー応答本文は保持していないため、HTTP 400より詳細な提供元原因は断定できない。初回試行で登録した199 IDも削除・不在確認後に、fetch vector方式へ切り替えた。今回のUpstash試行全体ではinfo 2、upsert 2（398 records）、query error 1（0 items）、score fetch 1（199 vectors）、delete 2（398 records）、cleanup verification fetch 2。残存IDは0。\n\nGoogleのEmbedding 001応答にはusageMetadataがなく、実課金額は確認できない。Google Embedding 2は22,086 input tokens。\n`;
await fs.writeFile(mdPath, md, 'utf8');
