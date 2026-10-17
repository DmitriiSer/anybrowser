import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test here spawns real processes, so a loaded CI runner can take
    // seconds for one CLI call. Vitest's 5 s default made those tests flaky.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["test/**/*.test.ts"],
  },
});
