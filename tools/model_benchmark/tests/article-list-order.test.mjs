import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('UI list sorts old and new articles by published date and leaves unknown dates last', async () => {
  const html = await fs.readFile(path.join(root, 'web', 'index.html'), 'utf8');
  const helper = html.match(/function sortByPublishedAt\(items\)\{[^\n]+\}/)?.[0];
  assert.ok(helper, 'UI published-date sorter is present');
  const sortByPublishedAt = vm.runInNewContext(`(${helper})`);
  const input = [
    { article_id: 'old', published_at: '2026-09-07T13:06:00.000Z' },
    { article_id: 'unknown', published_at: null },
    { article_id: 'new', published_at: '2026-09-26 01:25:10' },
    { article_id: 'invalid', published_at: 'not a date' },
  ];

  assert.deepEqual(Array.from(sortByPublishedAt(input), article => article.article_id), ['new', 'old', 'unknown', 'invalid']);
  assert.deepEqual(input.map(article => article.article_id), ['old', 'unknown', 'new', 'invalid']);
});
