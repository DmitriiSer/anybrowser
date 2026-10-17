import { defineConfig } from "vitest/config";

// Only the browser tests: these launch a real (headless) Chromium and need
// Playwright's browser binaries installed. See vitest.unit.config.ts for the
// complementary half and vitest.config.ts for the full local suite.
export default defineConfig({
  test: {
    // Every test here spawns real processes, so a loaded CI runner can take
    // seconds for one CLI call. Vitest's 5 s default made those tests flaky.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["test/**/*.browser.test.ts"],
  },
});
