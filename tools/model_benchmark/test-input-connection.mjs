import assert from 'node:assert/strict';
import { buildBenchmarkPrompt, requestBody } from './src/benchmark-core.mjs';

const base = { title: 'TITLE', description: 'DESCRIPTION' };
const prompt = 'PROMPT';
const a = buildBenchmarkPrompt(prompt, base, 'facts', { includeFullText: false });
assert.equal(a.input.mode, 'description_fallback'); assert(a.text.includes('DESCRIPTION')); assert(!a.text.includes('EXTRACTED_BODY'));
const b = buildBenchmarkPrompt(prompt, {...base, extracted_body: 'BODY_SENTINEL'}, 'facts', { includeFullText: true, bodyMaxChars: 100 });
assert.equal(b.input.mode, 'full_text'); assert(b.text.includes('BODY_SENTINEL')); assert(b.text.includes('DESCRIPTION'));
assert(requestBody({provider:'groq',api_model:'test',settings:{}}, b.text).messages[0].content.includes('BODY_SENTINEL'));
const c = buildBenchmarkPrompt(prompt, base, 'facts', { includeFullText: true, bodyMaxChars: 100 }); assert.equal(c.input.description_fallback, true); assert(!c.text.includes('EXTRACTED_BODY'));
const d = buildBenchmarkPrompt(prompt, {...base, extracted_body: '0123456789'}, 'facts', { includeFullText: true, bodyMaxChars: 4 }); assert.equal(d.input.truncated, true); assert.equal(d.input.body_chars, 4); assert(d.text.includes('0123')); assert(!d.text.includes('01234'));
const e = buildBenchmarkPrompt(prompt, {...base, extracted_body: 'BODY_SENTINEL'}, 'facts', { includeFullText: false }); assert(!e.text.includes('BODY_SENTINEL'));
console.log('input connection cases A-E passed');
