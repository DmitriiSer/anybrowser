import { configDefaults, defineConfig } from "vitest/config";

// Everything except the browser tests: no Chromium download, no browser
// launch. See vitest.browser.config.ts for the complementary half and
// vitest.config.ts for the full local suite.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/browser.test.ts"],
  },
});
