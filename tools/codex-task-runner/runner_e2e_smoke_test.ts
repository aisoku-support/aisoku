const runnerSource = await Deno.readTextFile(new URL("./runner.js", import.meta.url));
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
