import { defineConfig } from "vitest/config";

// Only the browser tests: these launch a real (headless) Chromium and need
// Playwright's browser binaries installed. See vitest.unit.config.ts for the
// complementary half and vitest.config.ts for the full local suite.
export default defineConfig({
  test: {
    include: ["test/**/*.browser.test.ts"],
  },
});
