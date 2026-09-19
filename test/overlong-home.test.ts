import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupHome, makeHome, runCli } from "./support.js";

const CLI_TIMEOUT = 10000;

describe("an overlong ANYBROWSER_HOME through the real CLI", () => {
  it(
    "anyb mcp exits 1, prints a friendly ANYBROWSER_HOME error on stderr, nothing on stdout, and never creates the directory",
    () => {
      const base = makeHome();
      const overlongHome = join(base, "x".repeat(200));
      try {
        const result = runCli(["mcp"], overlongHome, { timeout: 8000 });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/ANYBROWSER_HOME/);
        expect(existsSync(overlongHome)).toBe(false);
      } finally {
        cleanupHome(base);
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "anyb daemon exits 1, prints a friendly ANYBROWSER_HOME error on stderr, nothing on stdout, and never creates the directory",
    () => {
      const base = makeHome();
      const overlongHome = join(base, "x".repeat(200));
      try {
        const result = runCli(["daemon"], overlongHome, { timeout: 8000 });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/ANYBROWSER_HOME/);
        expect(existsSync(overlongHome)).toBe(false);
      } finally {
        cleanupHome(base);
      }
    },
    CLI_TIMEOUT,
  );
});
