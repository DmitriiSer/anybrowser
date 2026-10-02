import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.js";
import { resolveIdleMs, DEFAULT_IDLE_MS } from "../src/idle.js";
import { cleanupHome, makeHome } from "./support.js";

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

function writeConfig(idleMinutes: unknown): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(`${home}/config.json`, JSON.stringify({ idleMinutes }));
}

describe("resolveIdleMs precedence", () => {
  it("ANYBROWSER_IDLE_MS (a valid positive number) wins over a valid config.json idleMinutes", () => {
    writeConfig(2); // 2 minutes = 120000ms, should be ignored
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, { ANYBROWSER_IDLE_MS: "1234" });
    expect(resolved).toBe(1234);
  });

  it("falls back to config.json's idleMinutes (converted to ms) when the env var is unset", () => {
    writeConfig(2);
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, {});
    expect(resolved).toBe(2 * 60_000);
  });

  it.each([
    ["not a number", "banana"],
    ["zero", "0"],
    ["negative", "-500"],
  ])(
    "an invalid ANYBROWSER_IDLE_MS (%s) falls through to config.json, not to 'never'",
    (_label, envValue) => {
      writeConfig(3);
      const paths = resolvePaths({ ANYBROWSER_HOME: home });
      const resolved = resolveIdleMs(paths, { ANYBROWSER_IDLE_MS: envValue });
      expect(resolved).toBe(3 * 60_000);
    },
  );

  it("a missing config.json falls back silently to the default", () => {
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, {});
    expect(resolved).toBe(DEFAULT_IDLE_MS);
  });

  it("a malformed config.json (invalid JSON) falls back silently to the default", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(`${home}/config.json`, "{ not json");
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, {});
    expect(resolved).toBe(DEFAULT_IDLE_MS);
  });

  it("a config.json without idleMinutes (partial file) falls back silently to the default", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(`${home}/config.json`, JSON.stringify({ somethingElse: 1 }));
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, {});
    expect(resolved).toBe(DEFAULT_IDLE_MS);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
  ])(
    "a non-positive config.json idleMinutes (%s) falls back to the default, not to 'never'",
    (_label, idleMinutes) => {
      writeConfig(idleMinutes);
      const paths = resolvePaths({ ANYBROWSER_HOME: home });
      const resolved = resolveIdleMs(paths, {});
      expect(resolved).toBe(DEFAULT_IDLE_MS);
    },
  );

  it("ANYBROWSER_IDLE_MS=off disables both timers (returns null), even with a valid config.json", () => {
    writeConfig(5);
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, { ANYBROWSER_IDLE_MS: "off" });
    expect(resolved).toBeNull();
  });

  it("ANYBROWSER_IDLE_MS=OFF is case-insensitive", () => {
    const paths = resolvePaths({ ANYBROWSER_HOME: home });
    const resolved = resolveIdleMs(paths, { ANYBROWSER_IDLE_MS: "OFF" });
    expect(resolved).toBeNull();
  });
});
