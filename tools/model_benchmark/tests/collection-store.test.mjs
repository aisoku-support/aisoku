import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addCollectionDuplicateKeys, assessCollectionBody, createCollectionRun, isCollectionDuplicate, persistAcceptedCategoryBatch, saveCollectionRun } from '../src/collection-store.mjs';

test('accepts a useful extracted body below 1,200 characters', () => {
  const body = 'この記事ではニュースの背景と関係者の説明を整理します。具体的な日付や数字も示し、これからの影響について複数の観点から解説しています。'.repeat(5);
  const assessed = assessCollectionBody({ cleaned_body: body, extraction_method: 'readability', http_status: 200 });
  assert.ok(body.length < 1200);
  assert.equal(assessed.quality.passed, true);
});

test('rejects failed extraction and related-link-heavy text', () => {
  const failed = assessCollectionBody({ cleaned_body: '記事本文'.repeat(100), extraction_method: 'description_fallback', http_status: 200 });
  const noisy = assessCollectionBody({ cleaned_body: ('関連記事 あわせて読みたい おすすめ記事 人気記事 広告 ').repeat(20), extraction_method: 'readability', http_status: 200 });
  assert.ok(failed.reasons.includes('extraction_failed'));
  assert.ok(noisy.reasons.includes('boilerplate_heavy'));
});

test('detects duplicate article IDs, canonical URLs, titles, and bodies', () => {
  const known = new Set();
  const original = { title: '同じニュースの記事タイトル', source: { source_id: 'nd-1', url: 'https://news.example.jp/story/?utm=1' }, extracted_body: '本文'.repeat(200) };
  addCollectionDuplicateKeys(original, known);
  assert.equal(isCollectionDuplicate({ title: '別タイトル', source: { source_id: 'nd-2', url: 'https://news.example.jp/story' } }, known), true);
  assert.equal(isCollectionDuplicate({ ...original, source: { source_id: 'nd-2', url: 'https://another.example.jp/story' } }, known), true);
});

test('creates an independent per-run audit without changing the previous usage record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-benchmark-collection-run-'));
  try {
    const legacyPath = path.join(root, 'dataset', 'latest-collection-usage.json');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{"finished":true,"search_api_calls":5}\n');
    const first = await createCollectionRun(root, new Date('2026-09-26T00:00:00.000Z'));
    const second = await createCollectionRun(root, new Date('2026-09-26T00:00:00.000Z'));
    assert.notEqual(first.progress.run_id, second.progress.run_id);
    assert.equal(first.progress.search_api_calls, 0);
    first.progress.search_api_calls = 1;
    await saveCollectionRun(first.file, first.progress);
    assert.equal(JSON.parse(await fs.readFile(legacyPath, 'utf8')).search_api_calls, 5);
    assert.equal(JSON.parse(await fs.readFile(second.file, 'utf8')).search_api_calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('persists accepted articles even when the category target is not met', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-benchmark-collection-'));
  try {
    const articlesDir = path.join(root, 'dataset', 'articles');
    await fs.mkdir(articlesDir, { recursive: true });
    const legacy = { article_id: 'article-001', title: 'legacy', source: { source_id: 'legacy-source' } };
    await fs.writeFile(path.join(articlesDir, 'article-001.json'), `${JSON.stringify(legacy)}\n`);
    const csvPath = path.join(root, 'dataset', 'articles.csv');
    await fs.writeFile(csvPath, 'article_id,title,origin,source_id,added_at\narticle-001,legacy,initial,legacy-source,2026-09-20\n');

    const batch = await persistAcceptedCategoryBatch(root, 1, 'trend', [
      { title: 'accepted one', origin: 'newsdata', added_at: '2026-09-26', source: { source_id: 'source-1' }, extracted_body: 'body one' },
      { title: 'accepted two', origin: 'newsdata', added_at: '2026-09-26', source: { source_id: 'source-2' }, extracted_body: 'body two' },
      { title: 'accepted three', origin: 'newsdata', added_at: '2026-09-26', source: { source_id: 'source-3' }, extracted_body: 'body three' },
    ], 6);

    assert.equal(batch.target_met, false);
    assert.equal(batch.persisted, 3);
    assert.equal(batch.articles[0].article_id, 'article-002');
    assert.equal(batch.articles[2].article_id, 'article-004');
    assert.equal(JSON.parse(await fs.readFile(path.join(articlesDir, 'article-001.json'), 'utf8')).title, 'legacy');
    assert.equal(JSON.parse(await fs.readFile(path.join(articlesDir, 'article-002.json'), 'utf8')).extracted_body, 'body one');
    assert.equal((await fs.readFile(csvPath, 'utf8')).trim().split(/\r?\n/).length, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
