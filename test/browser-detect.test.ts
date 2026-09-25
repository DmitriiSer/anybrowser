import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserDetectionUnsupportedError,
  findBrowserExecutable,
} from "../src/browserDetect.js";

/** Runs `fn` with `process.platform` temporarily overridden, restoring it afterwards. */
function withPlatform<T>(platform: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

let appsDir: string;

/** Creates a fake app bundle: a real, executable file at the right relative path under `appsDir`. */
function makeFakeApp(appsDir: string, relativePath: string): string {
  const fullPath = join(appsDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, "#!/bin/sh\necho fake\n");
  chmodSync(fullPath, 0o755);
  return fullPath;
}

beforeEach(() => {
  appsDir = mkdtempSync(join(tmpdir(), "ab-apps-"));
});

afterEach(() => {
  rmSync(appsDir, { recursive: true, force: true });
});

describe("findBrowserExecutable with ANYBROWSER_APPLICATIONS_DIRS override", () => {
  it("finds Google Chrome.app's executable when present in the override dir", () => {
    const expected = makeFakeApp(
      appsDir,
      "Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    const found = findBrowserExecutable("chrome", {
      ANYBROWSER_APPLICATIONS_DIRS: appsDir,
    });
    expect(found).toBe(expected);
  });

  it("returns null when the browser is not found in any override dir", () => {
    const found = findBrowserExecutable("brave", {
      ANYBROWSER_APPLICATIONS_DIRS: appsDir,
    });
    expect(found).toBeNull();
  });

  it("searches multiple ':'-separated override dirs in order", () => {
    const other = mkdtempSync(join(tmpdir(), "ab-apps-2-"));
    try {
      const expected = makeFakeApp(other, "Vivaldi.app/Contents/MacOS/Vivaldi");
      const found = findBrowserExecutable("vivaldi", {
        ANYBROWSER_APPLICATIONS_DIRS: `${appsDir}:${other}`,
      });
      expect(found).toBe(expected);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("is not gated on process.platform when the override is set (works on Linux CI too)", () => {
    const expected = makeFakeApp(
      appsDir,
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
    const found = withPlatform("linux", () =>
      findBrowserExecutable("edge", {
        ANYBROWSER_APPLICATIONS_DIRS: appsDir,
      }),
    );
    expect(found).toBe(expected);
  });
});

describe("findBrowserExecutable without an override, on a non-macOS platform", () => {
  it("throws BrowserDetectionUnsupportedError naming macOS", () => {
    expect(() =>
      withPlatform("linux", () => findBrowserExecutable("chrome", {})),
    ).toThrow(BrowserDetectionUnsupportedError);
    expect(() =>
      withPlatform("linux", () => findBrowserExecutable("chrome", {})),
    ).toThrow(/macOS/);
  });
});
