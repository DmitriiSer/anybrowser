import { configDefaults, defineConfig } from "vitest/config";

// Everything except the browser tests: no Chromium download, no browser
// launch. See vitest.browser.config.ts for the complementary half and
// vitest.config.ts for the full local suite.
export default defineConfig({
  test: {
    // Every test here spawns real processes, so a loaded CI runner can take
    // seconds for one CLI call. Vitest's 5 s default made those tests flaky.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/**/*.browser.test.ts"],
  },
});
