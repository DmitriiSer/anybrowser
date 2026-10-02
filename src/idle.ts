import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnybrowserPaths } from "./paths.js";

/**
 * Default idle timeout (docs/DESIGN.md decision 5), used when neither
 * ANYBROWSER_IDLE_MS nor config.json's `idleMinutes` gives a usable value.
 */
export const DEFAULT_IDLE_MINUTES = 10;
export const DEFAULT_IDLE_MS = DEFAULT_IDLE_MINUTES * 60_000;

function fromEnv(env: NodeJS.ProcessEnv): number | null | undefined {
  const raw = env["ANYBROWSER_IDLE_MS"];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.toLowerCase() === "off") {
    return null;
  }
  const parsed = Number(trimmed);
  // 0 or negative means "use the next source", not "never" - only the
  // literal "off" above disables the timers.
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return undefined;
}

function fromConfigFile(paths: AnybrowserPaths): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(paths.home, "config.json"), "utf8");
  } catch {
    return undefined; // absent or unreadable: fall through silently
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // malformed JSON: fall through silently
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const idleMinutes = (parsed as { idleMinutes?: unknown }).idleMinutes;
  if (
    typeof idleMinutes !== "number" ||
    !Number.isFinite(idleMinutes) ||
    idleMinutes <= 0
  ) {
    return undefined;
  }
  return idleMinutes * 60_000;
}

/**
 * Resolves the idle timeout shared by the daemon-exit timer and each
 * profile's browser-close timer (docs/DESIGN.md decision 5).
 *
 * Precedence, checked in order, each falling through silently to the next
 * on an absent/invalid value:
 *
 *   1. `ANYBROWSER_IDLE_MS` - an env var in milliseconds, for tests and
 *      power users. The literal value "off" (case-insensitive) disables
 *      BOTH timers entirely (returns null). Any other non-positive or
 *      unparseable value is treated as absent, not as "never".
 *   2. `idleMinutes` in `<home>/config.json` (a number of minutes). The
 *      file may be absent, unreadable, malformed JSON, or missing the key.
 *      A non-numeric or non-positive `idleMinutes` also falls through.
 *   3. The default, `DEFAULT_IDLE_MS` (10 minutes).
 *
 * Returns the resolved timeout in milliseconds, or null when disabled.
 */
export function resolveIdleMs(
  paths: AnybrowserPaths,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const envValue = fromEnv(env);
  if (envValue !== undefined) {
    return envValue;
  }
  const configValue = fromConfigFile(paths);
  if (configValue !== undefined) {
    return configValue;
  }
  return DEFAULT_IDLE_MS;
}
