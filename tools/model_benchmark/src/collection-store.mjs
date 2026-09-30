import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MIN_BODY_CHARS = 300;
const MIN_UNIQUE_CHARS = 40;
const BOILERPLATE_MARKERS = /関連記事|あわせて読みたい|おすすめ記事|人気記事|記事ランキング|こちらもおすすめ|スポンサーリンク|広告|続きを読む|次の記事|前の記事/g;

export function assessCollectionBody(extraction) {
  const cleaned = String(extraction?.cleaned_body ?? '').replace(/\s+/g, ' ').trim();
  const uniqueChars = new Set(cleaned.replace(/\s/g, '')).size;
  const status = Number(extraction?.http_status);
  const markers = [...cleaned.matchAll(BOILERPLATE_MARKERS)];
  const markerChars = markers.reduce((sum, match) => sum + match[0].length, 0);
  const reasons = [];
  if (extraction?.extraction_method === 'description_fallback' || extraction?.failure_reason) reasons.push('extraction_failed');
  if (!(status >= 200 && status < 300)) reasons.push('http_failed');
  if (cleaned.length < MIN_BODY_CHARS) reasons.push('body_too_short');
  if (uniqueChars < MIN_UNIQUE_CHARS) reasons.push('low_text_diversity');
  if ((markers.length >= 5 || markers.length >= 3 && markerChars / Math.max(cleaned.length, 1) >= 0.2)) reasons.push('boilerplate_heavy');
  return {
    cleaned,
    reasons,
    quality: {
      passed: reasons.length === 0,
      min_chars: MIN_BODY_CHARS,
      unique_chars: uniqueChars,
      min_unique_chars: MIN_UNIQUE_CHARS,
      boilerplate_markers: markers.length,
      http_success: status >= 200 && status < 300,
    },
  };
}

export function collectionDuplicateKeys(article) {
  const keys = [];
  if (article?.source?.source_id) keys.push(`id:${article.source.source_id}`);
  const url = article?.source?.normalized_url ?? article?.source?.url;
  if (url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      for (const name of [...parsed.searchParams.keys()]) {
        if (/^(utm(?:_.+)?|fbclid|gclid|ref)$/i.test(name)) parsed.searchParams.delete(name);
      }
      parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
      keys.push(`url:${parsed.href.toLowerCase()}`);
    } catch {}
  }
  const title = String(article?.title ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  if (title.length >= 12) keys.push(`title:${title}`);
  const text = String(article?.extracted_body ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.length >= MIN_BODY_CHARS) keys.push(`body:${createHash('sha256').update(text).digest('hex')}`);
  return keys;
}

export function isCollectionDuplicate(article, knownKeys) {
  return collectionDuplicateKeys(article).some(key => knownKeys.has(key));
}

export function addCollectionDuplicateKeys(article, knownKeys) {
  for (const key of collectionDuplicateKeys(article)) knownKeys.add(key);
}

export async function createCollectionRun(root, now = new Date()) {
  const runId = `${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const directory = path.join(root, 'results', 'collection-runs');
  await fs.mkdir(directory, { recursive: true });
  const progress = {
    run_id: runId,
    started_at: now.toISOString(),
    approved_max_search_calls: 5,
    approved_max_article_page_requests: 50,
    search_api_calls: 0,
    article_page_requests: 0,
    attempted_categories: [],
    outcomes: [],
    finished: false,
  };
  const file = path.join(directory, `${runId}.json`);
  await fs.writeFile(file, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
  return { file, progress };
}

export async function saveCollectionRun(file, progress) {
  await fs.writeFile(file, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Persist every accepted article in a category batch, even when it is below its target. */
export async function persistAcceptedCategoryBatch(root, currentArticleCount, category, acceptedArticles, targetCount = 6) {
  const articlesDir = path.join(root, 'dataset', 'articles');
  await fs.mkdir(articlesDir, { recursive: true });
  const articles = acceptedArticles.map((article, index) => ({
    ...article,
    article_id: `article-${String(currentArticleCount + index + 1).padStart(3, '0')}`,
  }));

  for (const article of articles) {
    const file = path.join(articlesDir, `${article.article_id}.json`);
    await fs.writeFile(file, `${JSON.stringify(article, null, 2)}\n`, 'utf8');
  }

  if (articles.length) {
    const csvPath = path.join(root, 'dataset', 'articles.csv');
    const rows = articles.map(article => [
      article.article_id,
      article.title,
      article.origin,
      article.source?.source_id,
      article.added_at,
    ].map(csvEscape).join(','));
    await fs.appendFile(csvPath, `${rows.join('\n')}\n`, 'utf8');
  }

  return {
    category,
    articles,
    persisted: articles.length,
    target_count: targetCount,
    target_met: articles.length >= targetCount,
  };
}
