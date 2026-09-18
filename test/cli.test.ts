import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

function anyb(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

describe("anyb", () => {
  it("prints the package version", () => {
    const result = anyb("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("prints usage when called with no arguments", () => {
    const result = anyb();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: anyb");
  });

  it("rejects an unknown command with exit code 2", () => {
    const result = anyb("nope");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command 'nope'");
  });
});
