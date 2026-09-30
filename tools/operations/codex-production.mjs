#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const allowedCommands = new Set(['env', 'newsdata-test', 'supabase', 'wrangler', 'node', 'deno']);
const [command, ...args] = process.argv.slice(2);

if (!allowedCommands.has(command)) {
  console.error('Usage: node tools/operations/codex-production.mjs <env|supabase|wrangler|node|deno> [args...]');
  process.exit(2);
}

for (const file of ['.env', '.env.server']) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) continue;
  for (const line of fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const [, name] = match;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[name]) process.env[name] = value;
  }
}

if (command === 'env') {
  const names = [
    'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_READ_ONLY_TOKEN',
    'UPSTASH_REDIS_REST_TOKEN', 'NEWSDATA_API_KEY', 'NEWSDATA_JOB_SECRET',
    'TOPIC_PROCESSING_SECRET', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  ];
  for (const name of names) console.log(`${name}=${process.env[name] ? 'available' : 'missing'}`);
  process.exit(0);
}

if (command === 'newsdata-test') {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.NEWSDATA_JOB_SECRET;
  if (!url || !key) {
    console.error('newsdata-test requires SUPABASE_URL and NEWSDATA_JOB_SECRET.');
    process.exit(2);
  }
  let response;
  try {
    response = await fetch(`${url}/functions/v1/update-newsdata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-newsdata-job-secret': key,
      },
      body: JSON.stringify({ trigger: 'manual_test' }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    console.error(`newsdata-test request failed (${error?.name ?? 'network error'}).`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`newsdata-test returned HTTP ${response.status}.`);
    process.exit(1);
  }
  let result;
  try { result = await response.json(); } catch {
    console.error('newsdata-test returned an invalid response.');
    process.exit(1);
  }
  const safe = {};
  for (const name of ['run_id', 'state', 'trigger', 'requested_requests', 'successful_requests', 'new_articles', 'topic_enqueued', 'topic_enqueue_failed', 'error_type', 'error_status']) {
    if (result[name] !== undefined) safe[name] = result[name];
  }
  console.log(JSON.stringify(safe));
  if (result.error || result.stopped_by_error) process.exit(1);
  process.exit(0);
}

let executable = command;
if (command === 'supabase') {
  const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'supabase.cmd' : 'supabase');
  if (fs.existsSync(local)) executable = local;
}

const result = spawnSync(executable, args, { cwd: root, env: process.env, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error(`${command} could not be started (${result.error.code ?? 'spawn error'}).`);
  process.exit(127);
}
process.exit(result.status ?? 1);
