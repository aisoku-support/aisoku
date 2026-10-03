Deno.test("runner smoke test", () => {
  if (1 + 1 !== 2) {
    throw new Error("basic arithmetic assertion failed");
  }
});
