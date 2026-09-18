import { describe, expect, it } from "vitest";
import {
  assertSocketPathFits,
  resolvePaths,
  SOCKET_PATH_LIMIT,
} from "../src/paths.js";

describe("resolvePaths", () => {
  it("defaults to ~/.anybrowser when ANYBROWSER_HOME is unset", () => {
    const paths = resolvePaths({});
    expect(paths.home.endsWith("/.anybrowser")).toBe(true);
    expect(paths.socket).toBe(`${paths.home}/daemon.sock`);
    expect(paths.lock).toBe(`${paths.home}/daemon.lock`);
    expect(paths.log).toBe(`${paths.home}/daemon.log`);
  });

  it("honors ANYBROWSER_HOME when set", () => {
    const paths = resolvePaths({ ANYBROWSER_HOME: "/tmp/ab-test-home" });
    expect(paths.home).toBe("/tmp/ab-test-home");
    expect(paths.socket).toBe("/tmp/ab-test-home/daemon.sock");
  });

  it("falls back to the default when ANYBROWSER_HOME is blank", () => {
    const paths = resolvePaths({ ANYBROWSER_HOME: "   " });
    expect(paths.home.endsWith("/.anybrowser")).toBe(true);
  });
});

describe("assertSocketPathFits", () => {
  it("accepts a short socket path", () => {
    expect(() => assertSocketPathFits("/tmp/ab-1/daemon.sock")).not.toThrow();
  });

  it("accepts a path exactly at the limit", () => {
    const padding = "a".repeat(SOCKET_PATH_LIMIT - "/tmp/.sock".length);
    const path = `/tmp/${padding}.sock`;
    expect(Buffer.byteLength(path, "utf8")).toBe(SOCKET_PATH_LIMIT);
    expect(() => assertSocketPathFits(path)).not.toThrow();
  });

  it("rejects a path over the limit with a clear message naming the limit", () => {
    const padding = "a".repeat(200);
    const path = `/tmp/${padding}/daemon.sock`;
    expect(() => assertSocketPathFits(path)).toThrow(/104/);
    expect(() => assertSocketPathFits(path)).toThrow(/ANYBROWSER_HOME/);
  });
});
