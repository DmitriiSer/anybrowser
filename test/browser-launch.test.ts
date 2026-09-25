import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  logPathFor,
  makeHome,
} from "./support.js";

/**
 * Unit-half coverage for the installed-browser launch path: a fake app
 * bundle plus ANYBROWSER_TEST_NO_LAUNCH=1 means the daemon decides which
 * browser and executable to use and logs that decision, but never actually
 * calls into Playwright/Chromium. No browser is ever launched here, so this
 * file stays in the unit suite (not *.browser.test.ts).
 */

let home: string;
let appsDir: string;

function makeFakeApp(dir: string, relativePath: string): string {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, "#!/bin/sh\necho fake\n");
  chmodSync(fullPath, 0o755);
  return fullPath;
}

beforeEach(() => {
  home = makeHome();
  appsDir = mkdtempSync(join(tmpdir(), "ab-apps-"));
});

afterEach(() => {
  cleanupHome(home);
  rmSync(appsDir, { recursive: true, force: true });
});

describe("an installed-browser profile's launch decision", () => {
  it("logs the browser and the executable's basename, and never actually launches (ANYBROWSER_TEST_NO_LAUNCH=1)", async () => {
    makeFakeApp(appsDir, "Brave Browser.app/Contents/MacOS/Brave Browser");
    const id = addProfile(home, "docs", "brave", {
      env: { ANYBROWSER_APPLICATIONS_DIRS: appsDir },
    });
    expect(id).toBe("docs-in-brave");

    const { client, close } = await connectClient(home, {
      ANYBROWSER_TEST_NO_LAUNCH: "1",
    });
    try {
      const result = await client.callTool({
        name: "browser_navigate",
        arguments: { profile: id, url: "about:blank" },
      });
      expect(result.isError).toBe(true);

      const log = readFileSync(logPathFor(home), "utf8");
      expect(log).toMatch(/browser launch:.*profile=docs-in-brave/);
      expect(log).toMatch(/browser=brave/);
      expect(log).toMatch(/executable=Brave Browser/);
      // Only the basename, never the full fake-app-bundle path.
      expect(log).not.toContain(appsDir);
    } finally {
      await close();
    }
  }, 30000);
});
