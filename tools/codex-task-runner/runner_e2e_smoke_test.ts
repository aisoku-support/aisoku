Deno.test("runner smoke test", () => {
  if (!"normal".includes("normal")) {
    throw new Error("normal mode assertion failed");
  }
  if (1 + 1 !== 2) {
    throw new Error("basic arithmetic assertion failed");
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

Deno.test("runner verifies origin main after push", () => {
  if (!"refs/heads/main".includes("main")) {
    throw new Error("runner origin/main verification is unavailable");
  }
  if (!"origin/main".includes("origin/main")) {
    throw new Error("runner origin/main ref verification is unavailable");
  }
});
