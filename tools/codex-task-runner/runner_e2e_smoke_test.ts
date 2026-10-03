Deno.test("runner smoke test", () => {
  if (1 + 1 !== 2) {
    throw new Error("basic arithmetic assertion failed");
  }
});

Deno.test("runner entrypoint resolves", () => {
  if (!import.meta.resolve("./runner.js").endsWith("/tools/codex-task-runner/runner.js")) {
    throw new Error("runner entrypoint could not be resolved");
  }
});
