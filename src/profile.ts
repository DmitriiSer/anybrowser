import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BrowserDetectionUnsupportedError,
  findBrowserExecutable,
} from "./browserDetect.js";
import type { AnybrowserPaths } from "./paths.js";

/** Chromium-family browsers supported in this slice. Firefox and WebKit are not yet. */
export const SUPPORTED_BROWSERS = [
  "chrome",
  "chromium",
  "brave",
  "edge",
  "arc",
  "vivaldi",
  "opera",
] as const;

export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

/** Browsers we recognise but do not support yet in this slice. */
const NOT_YET_SUPPORTED_BROWSERS = ["firefox", "webkit"];

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 40;

export interface Profile {
  name: string;
  browser: SupportedBrowser;
  /** Defaults to false. */
  headless: boolean;
  /** Absolute path to the installed browser executable, or null for `chromium` (Playwright's bundled build). */
  executablePath: string | null;
  createdAt: string;
}

export interface StoredProfile extends Profile {
  id: string;
}

/** Validates a profile `name`. Returns an error message, or null when valid. */
export function validateName(name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return `profile name must be 1-${MAX_NAME_LENGTH} characters`;
  }
  if (name.includes("-in-")) {
    return "profile name must not contain '-in-'";
  }
  if (!NAME_PATTERN.test(name)) {
    return "profile name must be a lowercase slug: [a-z0-9]+(-[a-z0-9]+)*";
  }
  return null;
}

/** Validates a `browser`. Returns an error message, or null when it is one of the supported browsers. */
export function validateBrowser(browser: string): string | null {
  if (NOT_YET_SUPPORTED_BROWSERS.includes(browser)) {
    return `browser '${browser}' is not supported yet`;
  }
  if (!(SUPPORTED_BROWSERS as readonly string[]).includes(browser)) {
    return `unknown browser '${browser}'; supported: ${SUPPORTED_BROWSERS.join(", ")}`;
  }
  return null;
}

/** Composes a profile id from a validated `name` and `browser`. */
export function profileId(name: string, browser: string): string {
  return `${name}-in-${browser}`;
}

function profileDir(paths: AnybrowserPaths, id: string): string {
  return join(paths.home, "profiles", id);
}

function profileJsonPath(paths: AnybrowserPaths, id: string): string {
  return join(profileDir(paths, id), "profile.json");
}

export function profileExists(paths: AnybrowserPaths, id: string): boolean {
  return existsSync(profileJsonPath(paths, id));
}

export function readProfile(
  paths: AnybrowserPaths,
  id: string,
): Profile | null {
  try {
    const raw = readFileSync(profileJsonPath(paths, id), "utf8");
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

export interface CreateProfileInput {
  name: string;
  browser: SupportedBrowser;
  headless?: boolean;
  executablePath: string | null;
}

/** Writes a new profile directory (mode 0700) and its profile.json. Throws if the id already exists. */
export function createProfile(
  paths: AnybrowserPaths,
  input: CreateProfileInput,
): StoredProfile {
  const id = profileId(input.name, input.browser);
  if (profileExists(paths, id)) {
    throw new Error(`profile '${id}' already exists`);
  }
  const dir = profileDir(paths, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const profile: Profile = {
    name: input.name,
    browser: input.browser,
    headless: input.headless ?? false,
    executablePath: input.executablePath,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(profileJsonPath(paths, id), JSON.stringify(profile, null, 2));
  return { id, ...profile };
}

export interface AddProfileRequest {
  name: string;
  browser: string;
  headless?: boolean;
}

export type AddProfileOutcome =
  | { ok: true; id: string }
  | {
      ok: false;
      /** invalid-*: bad input. detection-unsupported/not-found: browser detection. exists: id taken. */
      kind:
        | "invalid-name"
        | "invalid-browser"
        | "detection-unsupported"
        | "not-found"
        | "exists";
      message: string;
    };

/**
 * Validates `name`/`browser`, resolves an executable for non-`chromium`
 * browsers (macOS app-bundle detection), and creates the profile. Shared by
 * the CLI (`anyb profile add`) and the `profile_create` MCP tool so both
 * apply the exact same rules.
 */
export function addProfileWithDetection(
  paths: AnybrowserPaths,
  input: AddProfileRequest,
  env: NodeJS.ProcessEnv = process.env,
): AddProfileOutcome {
  const nameError = validateName(input.name);
  if (nameError) {
    return { ok: false, kind: "invalid-name", message: nameError };
  }
  const browserError = validateBrowser(input.browser);
  if (browserError) {
    return { ok: false, kind: "invalid-browser", message: browserError };
  }
  const browser = input.browser as SupportedBrowser;

  let executablePath: string | null = null;
  if (browser !== "chromium") {
    try {
      executablePath = findBrowserExecutable(browser, env);
    } catch (error) {
      if (error instanceof BrowserDetectionUnsupportedError) {
        return {
          ok: false,
          kind: "detection-unsupported",
          message: error.message,
        };
      }
      throw error;
    }
    if (executablePath === null) {
      return {
        ok: false,
        kind: "not-found",
        message: `could not find an installed '${browser}'; try 'chromium' instead`,
      };
    }
  }

  try {
    const profile = createProfile(paths, {
      name: input.name,
      browser,
      headless: input.headless ?? false,
      executablePath,
    });
    return { ok: true, id: profile.id };
  } catch (error) {
    return {
      ok: false,
      kind: "exists",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Deletes a profile's whole directory. Throws if it doesn't exist. */
export function removeProfile(paths: AnybrowserPaths, id: string): void {
  if (!profileExists(paths, id)) {
    throw new Error(`profile '${id}' does not exist`);
  }
  rmSync(profileDir(paths, id), { recursive: true, force: true });
}

const SETTABLE_KEYS = new Set(["headless"]);

/** Updates one setting in profile.json (currently only `headless`). Throws on an unknown key/profile/value. */
export function setProfileSetting(
  paths: AnybrowserPaths,
  id: string,
  key: string,
  value: string,
): void {
  if (!SETTABLE_KEYS.has(key)) {
    throw new Error(`unknown profile setting '${key}'`);
  }
  const profile = readProfile(paths, id);
  if (!profile) {
    throw new Error(`profile '${id}' does not exist`);
  }
  if (value !== "true" && value !== "false") {
    throw new Error(`'${key}' must be 'true' or 'false'`);
  }
  const updated: Profile = { ...profile, headless: value === "true" };
  writeFileSync(profileJsonPath(paths, id), JSON.stringify(updated, null, 2));
}

/** Lists every profile under `paths.home/profiles`, sorted by id. Returns [] if the directory doesn't exist. */
export function listProfiles(paths: AnybrowserPaths): StoredProfile[] {
  const root = join(paths.home, "profiles");
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const profiles: StoredProfile[] = [];
  for (const id of ids.sort()) {
    const profile = readProfile(paths, id);
    if (profile) {
      profiles.push({ id, ...profile });
    }
  }
  return profiles;
}
