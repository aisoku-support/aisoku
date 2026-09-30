import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBenchmarkPrompt, execute, saveResult } from '../src/benchmark-core.mjs';

const article = { article_id: 'article-test', title: 'Sample title', description: 'Short summary', extracted_body: 'x'.repeat(1600) };

test('facts generation uses the saved extracted article body', () => {
  const built = buildBenchmarkPrompt('facts prompt', article, 'facts', { includeFullText: true, bodyMaxChars: 1200 });
  assert.match(built.text, /EXTRACTED_BODY/);
  assert.equal(built.input.mode, 'full_text');
  assert.equal(built.input.body_chars, 1200);
  assert.equal(built.input.truncated, true);
});

test('comments prompt uses selected saved facts and records their mode', () => {
  const facts = ['Fact A', 'Fact B'];
  const built = buildBenchmarkPrompt('comments prompt', article, 'comments', { facts, factsMode: 'common_facts_to_comments' });
  assert.match(built.text, /NEWS_FACTS/);
  assert.match(built.text, /Fact A/);
  assert.doesNotMatch(built.text, /EXTRACTED_BODY/);
  assert.equal(built.input.mode, 'common_facts_to_comments');
  assert.equal(built.input.facts_count, 2);
});

test('mock facts run persists reusable facts with model, prompt and generation settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-benchmark-'));
  try {
    await fs.mkdir(path.join(root, 'prompts', 'test-model'), { recursive: true });
    await fs.writeFile(path.join(root, 'prompts', 'test-model', 'facts-v1.txt'), 'facts prompt');
    const model = { model_id: 'test-model', display_name: 'Test', provider: 'test', api_model: 'test-api', settings: { temperature: 0.2, max_output_tokens: 200 } };
    const detail = await execute({ root, article, model, task: 'facts', mock: true, inputOptions: { includeFullText: true, taskMode: 'body_to_facts' } });
    assert.equal(detail.status, 'success');
    assert.equal(detail.generation.task_mode, 'body_to_facts');
    assert.deepEqual(detail.generation.settings, model.settings);
    const saved = await saveResult(root, detail);
    assert.ok(saved.facts_file);
    const stored = JSON.parse(await fs.readFile(path.join(root, 'results', saved.facts_file), 'utf8'));
    assert.deepEqual(stored.answer.facts, ['mock fact']);
    assert.equal(stored.model.api_model, 'test-api');
    assert.equal(stored.prompt.version, 'facts-v1.txt');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mock comments result records the input facts and task mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-benchmark-'));
  try {
    await fs.mkdir(path.join(root, 'prompts', 'test-model'), { recursive: true });
    await fs.writeFile(path.join(root, 'prompts', 'test-model', 'comments-v2.txt'), 'comments prompt');
    const facts = ['Selected fact'];
    const detail = await execute({ root, article, model: { model_id: 'test-model', provider: 'test', api_model: 'test-api', settings: { temperature: 0.4 }, prompts: { comments: 'comments-v2.txt' } }, task: 'comments', mock: true, inputOptions: { facts, sourceFacts: ['results/facts/article-test/facts.json'], factsMode: 'model_facts_to_comments', taskMode: 'model_facts_to_comments' } });
    assert.equal(detail.status, 'success');
    assert.deepEqual(detail.generation.input_facts, facts);
    assert.equal(detail.generation.task_mode, 'model_facts_to_comments');
    assert.equal(detail.metrics.facts_count, 1);
    assert.equal(detail.prompt.snapshot.includes('Selected fact'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

