import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SupportedBrowser } from "./profile.js";

/** Executable relative to an Applications directory, for every non-`chromium` supported browser. */
const APP_BUNDLE_RELATIVE_PATHS: Partial<Record<SupportedBrowser, string>> = {
  chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
  brave: "Brave Browser.app/Contents/MacOS/Brave Browser",
  edge: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  arc: "Arc.app/Contents/MacOS/Arc",
  vivaldi: "Vivaldi.app/Contents/MacOS/Vivaldi",
  opera: "Opera.app/Contents/MacOS/Opera",
};

function defaultSearchDirs(): string[] {
  return ["/Applications", join(homedir(), "Applications")];
}

function searchDirsFromEnv(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env["ANYBROWSER_APPLICATIONS_DIRS"];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw.split(":").filter((entry) => entry.length > 0);
}

export class BrowserDetectionUnsupportedError extends Error {}

/**
 * Resolves `browser` to an absolute executable path by searching, in order,
 * each directory in `ANYBROWSER_APPLICATIONS_DIRS` (":"-separated) when set,
 * else (macOS only) `/Applications` then `~/Applications`. Returns null when
 * the app bundle isn't found in any search directory.
 *
 * Throws `BrowserDetectionUnsupportedError` when no override is set and the
 * platform isn't macOS (detection is only implemented for macOS).
 */
export function findBrowserExecutable(
  browser: SupportedBrowser,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const relativePath = APP_BUNDLE_RELATIVE_PATHS[browser];
  if (!relativePath) {
    // `chromium` has no app bundle to search for: callers should not ask.
    return null;
  }

  const overrideDirs = searchDirsFromEnv(env);
  const searchDirs = overrideDirs ?? defaultSearchDirs();

  if (overrideDirs === undefined && process.platform !== "darwin") {
    throw new BrowserDetectionUnsupportedError(
      "browser detection is only implemented for macOS",
    );
  }

  for (const dir of searchDirs) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
