import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHome, makeHome, runCli } from "./support.js";

function makeFakeApp(appsDir: string, relativePath: string): string {
  const fullPath = join(appsDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, "#!/bin/sh\necho fake\n");
  chmodSync(fullPath, 0o755);
  return fullPath;
}

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("anyb profile list", () => {
  it("prints 'no profiles' when there are none, and one line per profile (id, browser, headless) after adding", () => {
    const empty = runCli(["profile", "list"], home);
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe("no profiles");

    runCli(["profile", "add", "work", "chromium"], home);
    runCli(["profile", "add", "docs", "chromium", "--headless"], home);

    const result = runCli(["profile", "list"], home);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(
      lines.some(
        (l) =>
          l.includes("docs-in-chromium") &&
          l.includes("chromium") &&
          l.includes("true"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.includes("work-in-chromium") &&
          l.includes("chromium") &&
          l.includes("false"),
      ),
    ).toBe(true);
  });
});

describe("anyb profile add", () => {
  it("creates <home>/profiles/<id>/profile.json (mode 0700 dir) with the right fields and prints the id", () => {
    const result = runCli(["profile", "add", "work", "chromium"], home);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("work-in-chromium");

    const profileDir = join(home, "profiles", "work-in-chromium");
    expect(existsSync(profileDir)).toBe(true);
    expect(statSync(profileDir).mode & 0o777).toBe(0o700);

    const profileJson = JSON.parse(
      readFileSync(join(profileDir, "profile.json"), "utf8"),
    ) as {
      name: string;
      browser: string;
      headless: boolean;
      executablePath: string | null;
      createdAt: string;
    };
    expect(profileJson.name).toBe("work");
    expect(profileJson.browser).toBe("chromium");
    expect(profileJson.headless).toBe(false);
    expect(profileJson.executablePath).toBeNull();
    expect(() => new Date(profileJson.createdAt).toISOString()).not.toThrow();
  });

  it("exits 2 with a one-line error for an invalid name", () => {
    const result = runCli(["profile", "add", "Work Space", "chromium"], home);
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/anyb:/);
  });

  it("exits 2 with a one-line error naming firefox as not supported yet", () => {
    const result = runCli(["profile", "add", "work", "firefox"], home);
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("firefox");
    expect(result.stderr).toMatch(/not supported yet/);
  });

  it("exits 2 with a one-line error naming webkit as not supported yet", () => {
    const result = runCli(["profile", "add", "work", "webkit"], home);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not supported yet/);
  });

  it("exits 1 when the id already exists", () => {
    const first = runCli(["profile", "add", "work", "chromium"], home);
    expect(first.status).toBe(0);
    const second = runCli(["profile", "add", "work", "chromium"], home);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/work-in-chromium/);
  });
});

describe("anyb profile add for an installed (non-chromium) browser", () => {
  let appsDir: string;

  beforeEach(() => {
    appsDir = mkdtempSync(join(tmpdir(), "ab-apps-"));
  });

  afterEach(() => {
    rmSync(appsDir, { recursive: true, force: true });
  });

  it("stores the resolved absolute executablePath when the app bundle is found via ANYBROWSER_APPLICATIONS_DIRS", () => {
    const expected = makeFakeApp(
      appsDir,
      "Brave Browser.app/Contents/MacOS/Brave Browser",
    );
    const result = runCli(["profile", "add", "docs", "brave"], home, {
      env: { ANYBROWSER_APPLICATIONS_DIRS: appsDir },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("docs-in-brave");

    const profileJson = JSON.parse(
      readFileSync(
        join(home, "profiles", "docs-in-brave", "profile.json"),
        "utf8",
      ),
    ) as { executablePath: string | null };
    expect(profileJson.executablePath).toBe(expected);
  });

  it("exits 1 naming the browser and suggesting chromium when the app bundle is not found", () => {
    const result = runCli(["profile", "add", "docs", "brave"], home, {
      env: { ANYBROWSER_APPLICATIONS_DIRS: appsDir },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("brave");
    expect(result.stderr).toMatch(/chromium/);
    expect(existsSync(join(home, "profiles", "docs-in-brave"))).toBe(false);
  });
});

describe("anyb profile remove", () => {
  it("deletes the profile directory when the daemon is not running", () => {
    runCli(["profile", "add", "work", "chromium"], home);
    const dir = join(home, "profiles", "work-in-chromium");
    expect(existsSync(dir)).toBe(true);

    const result = runCli(["profile", "remove", "work-in-chromium"], home);
    expect(result.status).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("exits 1 when the profile does not exist", () => {
    const result = runCli(["profile", "remove", "no-such-in-chromium"], home);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no-such-in-chromium/);
  });
});

describe("anyb profile set", () => {
  it("updates headless in profile.json", () => {
    runCli(["profile", "add", "work", "chromium"], home);
    const jsonPath = join(home, "profiles", "work-in-chromium", "profile.json");
    expect(
      (JSON.parse(readFileSync(jsonPath, "utf8")) as { headless: boolean })
        .headless,
    ).toBe(false);

    const result = runCli(
      ["profile", "set", "work-in-chromium", "headless=true"],
      home,
    );
    expect(result.status).toBe(0);
    expect(
      (JSON.parse(readFileSync(jsonPath, "utf8")) as { headless: boolean })
        .headless,
    ).toBe(true);

    runCli(["profile", "set", "work-in-chromium", "headless=false"], home);
    expect(
      (JSON.parse(readFileSync(jsonPath, "utf8")) as { headless: boolean })
        .headless,
    ).toBe(false);
  });

  it("exits 2 for an unknown key", () => {
    runCli(["profile", "add", "work", "chromium"], home);
    const result = runCli(
      ["profile", "set", "work-in-chromium", "browser=brave"],
      home,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/browser/);
  });
});

describe("anyb profile login argument validation", () => {
  it("exits 2 with a usage message when the url is missing, without touching the daemon", () => {
    const result = runCli(["profile", "login", "work-in-chromium"], home);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: anyb profile login/);
  });
});
