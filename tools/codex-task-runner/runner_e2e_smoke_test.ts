const runnerSource = await Deno.readTextFile(new URL("./runner.js", import.meta.url));
const dotenvSource = runnerSource.slice(runnerSource.indexOf("function parseDotenv"), runnerSource.indexOf("function redactCredentials"));
const dotenvFunctions = new Function("fs", "CREDENTIAL_KEYS", `${dotenvSource}; return { parseDotenv, loadServerEnvironment };`);
const { parseDotenv, loadServerEnvironment } = dotenvFunctions({
  existsSync: (file: string) => { try { Deno.statSync(file); return true; } catch { return false; } },
  readFileSync: (file: string) => Deno.readTextFileSync(file),
}, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
const redactCredentials = (text: string, env: Record<string, string>) => text.split(env.CLOUDFLARE_API_TOKEN).join("[REDACTED:CLOUDFLARE_API_TOKEN]");
const validatorSource = runnerSource.match(/function normalizeResultText\([\s\S]*?\r?\n}\r?\nfunction validateResult\([\s\S]*?\r?\n}/)?.[0];
if (!validatorSource) throw new Error("result validator was not found");
const validateResult = new Function(`${validatorSource}; return validateResult;`)();

const taskId = "20261004-021";

Deno.test("standard result format passes", () => {
  const result = `Task ID: ${taskId}\n\n## Implementation\nImplemented locking.\n\n## Changed Files\n- runner.js\n\n## Test Results\n- PASS\n\n## Unresolved Issues\n- None`;
  if (!validateResult(result, taskId)) throw new Error("standard result was rejected");
});

Deno.test("Task 021 result format passes", () => {
  const result = `# Task Result: ${taskId}\n\n## 実装内容\nlockを実装しました。\n\n## 変更ファイル\n- runner.js\n\n## ロックファイルの場所\n.ai/runner.lock\n\n## 多重起動防止の仕組み\nPIDとtokenを記録します。\n\n## stale lockの扱い\nPID確認後に回収します。\n\n## テスト結果\n- deno test: PASS\n\n## 未解決事項\n- 個別動作試験は未実施`;
  if (!validateResult(result, taskId)) throw new Error("Task 021 result was rejected");
});

Deno.test("mismatched task id fails", () => {
  const result = `Task ID: 20261004-999\n実装内容\n変更ファイル\nテスト結果\n未解決事項`;
  if (validateResult(result, taskId)) throw new Error("mismatched task id was accepted");
});

Deno.test("missing required information fails", () => {
  const base = `Task ID: ${taskId}\n実装内容\n変更ファイル\nテスト結果\n未解決事項`;
  for (const result of [base.replace("実装内容", ""), base.replace("変更ファイル", ""), base.replace("テスト結果", ""), base.replace("未解決事項", "")]) {
    if (validateResult(result, taskId)) throw new Error("result with missing required information was accepted");
  }
});

Deno.test("runner entrypoint resolves", () => {
  if (typeof import.meta.resolve !== "function") {
    throw new Error("runner entrypoint resolver is unavailable");
  }
  if (!import.meta.resolve("./runner.js").endsWith("/tools/codex-task-runner/runner.js")) {
    throw new Error("runner entrypoint could not be resolved");
  }
});

Deno.test("dotenv parser handles whitespace, comments, and quoted values", () => {
  const parsed = parseDotenv("\n# ignored\nCLOUDFLARE_ACCOUNT_ID = 'account-value'\nCLOUDFLARE_API_TOKEN=\"token-value\"\nOTHER=value # note\n");
  if (parsed.CLOUDFLARE_ACCOUNT_ID !== "account-value" || parsed.CLOUDFLARE_API_TOKEN !== "token-value" || parsed.OTHER !== "value") {
    throw new Error("dotenv values were not parsed as expected");
  }
});

Deno.test("dotenv credentials inherit into a child process without being printed", async () => {
  const dir = `${Deno.cwd()}/tools/codex-task-runner/.env-test-${crypto.randomUUID()}`;
  await Deno.mkdir(dir);
  const envFile = `${dir}/.env.server`;
  const secret = "synthetic-secret-value";
  await Deno.writeTextFile(envFile, `CLOUDFLARE_ACCOUNT_ID=synthetic-account\nCLOUDFLARE_API_TOKEN=${secret}\n`);
  const env = {};
  try {
    loadServerEnvironment(env, envFile);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "console.log(process.env.CLOUDFLARE_ACCOUNT_ID ? 'account-present' : 'account-missing'); console.log(process.env.CLOUDFLARE_API_TOKEN ? 'token-present' : 'token-missing')"],
      env,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await child.output();
    const stdout = new TextDecoder().decode(output.stdout);
    if (output.code !== 0 || !stdout.includes("account-present") || !stdout.includes("token-present")) throw new Error("child did not inherit Cloudflare environment");
    if (stdout.includes(secret) || redactCredentials(secret, env).includes(secret)) throw new Error("credential value was exposed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dotenv loading preserves existing environment and tolerates a missing file", () => {
  const env: Record<string, string> = { CLOUDFLARE_API_TOKEN: "existing-token" };
  loadServerEnvironment(env, "missing-env-server-file");
  if (env.CLOUDFLARE_API_TOKEN !== "existing-token" || env.CLOUDFLARE_ACCOUNT_ID) throw new Error("missing dotenv file changed environment");
  const dir = `${Deno.cwd()}/tools/codex-task-runner/.env-test-${crypto.randomUUID()}`;
  Deno.mkdirSync(dir);
  try {
    const file = `${dir}/.env.server`;
    Deno.writeTextFileSync(file, "CLOUDFLARE_ACCOUNT_ID=file-account\nCLOUDFLARE_API_TOKEN=file-token\n");
    loadServerEnvironment(env, file);
    if (env.CLOUDFLARE_API_TOKEN !== "existing-token" || env.CLOUDFLARE_ACCOUNT_ID !== "file-account") throw new Error("dotenv precedence was incorrect");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("runner retains single-instance lock implementation", async () => {
  for (const marker of ["runner.lock", "openSync(lockFile, 'wx')", "process.kill(pid, 0)", "current.token === ownedLock.token", "SIGINT", "SIGTERM", "beforeExit"]) {
    if (!runnerSource.includes(marker)) throw new Error(`single-instance lock marker missing: ${marker}`);
  }
});

Deno.test("runner pushes HEAD to origin main and verifies the remote hash", () => {
  if (!runnerSource.includes("run('git', ['push', 'origin', 'HEAD:main'])")) {
    throw new Error("runner push to origin main is unavailable");
  }
  if (!runnerSource.includes("run('git', ['ls-remote', 'origin', 'refs/heads/main'])")) {
    throw new Error("runner remote main hash verification is unavailable");
  }
  if (!runnerSource.includes("remoteHash !== hash")) {
    throw new Error("runner does not compare the remote main hash with HEAD");
  }
});

Deno.test("runner does not modify the result after committing", () => {
  const commitFlow = runnerSource.slice(runnerSource.indexOf("const c = await run('git', ['commit'"));
  if (commitFlow.includes("appendFileSync(result")) {
    throw new Error("runner modifies the result after commit");
  }
  if (!commitFlow.includes("log(`${task.task_id} committed ${hash}`)")) {
    throw new Error("runner does not log the commit hash");
  }
  if (!commitFlow.includes("log(`${task.task_id} push verified origin/main ${remoteHash}`)")) {
    throw new Error("runner does not log the verified remote hash");
  }
});

Deno.test("runner reports final working tree state", () => {
  if (!runnerSource.includes("working tree ${finalStatus.code === 0 && !finalStatus.output ? 'clean'")) {
    throw new Error("runner does not report the final working tree state");
  }
});

Deno.test("runner stages files changed by the task before committing", () => {
  if (!runnerSource.includes("const after = await gitStatus()")) {
    throw new Error("runner does not inspect the working tree after task changes");
  }
  if (!runnerSource.includes("const changedPaths = parseStatusPaths(after.output).filter(filePath => !baselineSet.has(filePath))")) {
    throw new Error("runner does not collect files changed by the task");
  }
  if (!runnerSource.includes("run('git', ['add', '--', ...changedPaths])")) {
    throw new Error("runner does not stage files changed by the task");
  }
});

Deno.test("incomplete results are retained and failed tasks move to error", () => {
  if (!runnerSource.includes("Result validation failed: incomplete result retained for audit.")) {
    throw new Error("incomplete result audit reason is missing");
  }
  if (!runnerSource.includes("await saveFailureResult(task, running, result, 'result incomplete', baselinePaths)")) {
    throw new Error("incomplete result is not saved through failure flow");
  }
  const failureFlow = runnerSource.slice(runnerSource.indexOf("async function saveFailureResult"), runnerSource.indexOf("async function gitStatus"));
  if (!failureFlow.includes("move(running, path.join(AI, 'error'))")) throw new Error("failed task does not move to error");
  if (failureFlow.includes("path.join(AI, 'done')")) throw new Error("failed task can be moved to done");
});

Deno.test("failure commit stages only changed AI files and verifies pushed remote hash", () => {
  const failureFlow = runnerSource.slice(runnerSource.indexOf("async function saveFailureResult"), runnerSource.indexOf("async function gitStatus"));
  if (!failureFlow.includes("!baselineSet.has(filePath) && isAiPath(filePath)")) {
    throw new Error("failure flow may stage task source changes");
  }
  if (!failureFlow.includes("run('git', ['push', 'origin', 'HEAD:main'])")) throw new Error("failure result push is missing");
  if (!failureFlow.includes("run('git', ['ls-remote', 'origin', 'refs/heads/main'])")) throw new Error("failure remote hash check is missing");
  if (!failureFlow.includes("remoteHash !== hash")) throw new Error("failure flow does not verify remote hash");
});

Deno.test("successful completion flow still validates, commits, verifies, then moves to done", () => {
  const successFlow = runnerSource.slice(runnerSource.indexOf("async function processFile"));
  const markers = [
    "if (!validateResult(resultText, task.task_id))",
    "## Runner Checks",
    "run('git', ['commit', '-m', `task(${task.task_id}): implementation`])",
    "run('git', ['push', 'origin', 'HEAD:main'])",
    "run('git', ['ls-remote', 'origin', 'refs/heads/main'])",
    "move(running, path.join(AI, 'done'))",
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = successFlow.indexOf(marker);
    if (index < 0 || index <= previous) throw new Error(`success flow marker missing or reordered: ${marker}`);
    previous = index;
  }
});
