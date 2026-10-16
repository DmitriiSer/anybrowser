import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHome, runCli, cleanupHome } from "./support.js";

const ourSkill = readFileSync(
  new URL("../skills/anybrowser/SKILL.md", import.meta.url),
  "utf8",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ab-install-"));
  dirs.push(dir);
  return dir;
}

/**
 * A fake `claude` executable in its own directory. It appends one line per
 * call (arguments joined by spaces) to `calls.log`, answers `mcp get` with
 * success only once `server-exists` is present, and `mcp add` creates that
 * marker. It never touches anything outside its directory.
 */
function makeFakeClaude(options: { serverExists?: boolean } = {}) {
  const dir = tempDir();
  const script = [
    "#!/bin/sh",
    'here="${0%/*}"',
    'echo "$*" >> "$here/calls.log"',
    'case "$1 $2" in',
    '  "mcp get") [ -e "$here/server-exists" ]; exit $? ;;',
    '  "mcp add") : > "$here/server-exists" ;;',
    '  "mcp remove") /bin/rm -f "$here/server-exists" ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  const path = join(dir, "claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  if (options.serverExists) {
    writeFileSync(join(dir, "server-exists"), "");
  }
  return {
    dir,
    calls(): string[] {
      const log = join(dir, "calls.log");
      return existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter(Boolean)
        : [];
    },
  };
}

function installEnv(fakeDir: string, claudeHome: string) {
  return { PATH: fakeDir, CLAUDE_CONFIG_DIR: claudeHome };
}

describe("anyb install", () => {
  it("registers the server through claude once and copies the skill", () => {
    const home = makeHome();
    const claudeHome = tempDir();
    const fake = makeFakeClaude();
    try {
      const result = runCli(["install"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(result.status).toBe(0);
      const adds = fake.calls().filter((call) => call.startsWith("mcp add"));
      expect(adds).toEqual(["mcp add --scope user anybrowser -- anyb mcp"]);
      expect(
        readFileSync(join(claudeHome, "skills/anybrowser/SKILL.md"), "utf8"),
      ).toBe(ourSkill);
    } finally {
      cleanupHome(home);
    }
  });
  it("adds nothing when claude already has the server, and succeeds", () => {
    const home = makeHome();
    const claudeHome = tempDir();
    const fake = makeFakeClaude({ serverExists: true });
    try {
      const result = runCli(["install"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("already registered");
      expect(fake.calls().filter((c) => c.startsWith("mcp add"))).toEqual([]);
    } finally {
      cleanupHome(home);
    }
  });
  it("refuses to overwrite a different SKILL.md unless --force is given", () => {
    const home = makeHome();
    const claudeHome = tempDir();
    const fake = makeFakeClaude();
    const skillFile = join(claudeHome, "skills/anybrowser/SKILL.md");
    mkdirSync(join(claudeHome, "skills/anybrowser"), { recursive: true });
    writeFileSync(skillFile, "my own edits\n");
    try {
      const refused = runCli(["install"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("--force");
      expect(readFileSync(skillFile, "utf8")).toBe("my own edits\n");

      const forced = runCli(["install", "--force"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(forced.status).toBe(0);
      expect(readFileSync(skillFile, "utf8")).toBe(ourSkill);
    } finally {
      cleanupHome(home);
    }
  });
  it("fails with a pointer to --print and writes nothing when claude is not on PATH", () => {
    const home = makeHome();
    const claudeHome = join(tempDir(), "claude-home");
    const emptyBin = tempDir();
    try {
      const result = runCli(["install"], home, {
        env: installEnv(emptyBin, claudeHome),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Claude Code was not found");
      expect(result.stderr).toContain("--print");
      expect(existsSync(claudeHome)).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });
  it("--print shows a generic MCP config snippet and changes nothing", () => {
    const home = makeHome();
    const claudeHome = join(tempDir(), "claude-home");
    const fake = makeFakeClaude();
    try {
      const result = runCli(["install", "--print"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(result.status).toBe(0);
      const json = result.stdout.slice(
        result.stdout.indexOf("{"),
        result.stdout.lastIndexOf("}") + 1,
      );
      expect(JSON.parse(json)).toEqual({
        mcpServers: { anybrowser: { command: "anyb", args: ["mcp"] } },
      });
      expect(json).toContain("\n  ");
      expect(fake.calls()).toEqual([]);
      expect(existsSync(claudeHome)).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });
});

describe("anyb uninstall", () => {
  it("removes the server through claude and deletes our skill folder", () => {
    const home = makeHome();
    const claudeHome = tempDir();
    const fake = makeFakeClaude({ serverExists: true });
    const skillDir = join(claudeHome, "skills/anybrowser");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), ourSkill);
    try {
      const result = runCli(["uninstall"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(result.status).toBe(0);
      expect(fake.calls().filter((c) => c.startsWith("mcp remove"))).toEqual([
        "mcp remove anybrowser --scope user",
      ]);
      expect(existsSync(skillDir)).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });

  it("leaves a modified SKILL.md in place and says so", () => {
    const home = makeHome();
    const claudeHome = tempDir();
    const fake = makeFakeClaude();
    const skillFile = join(claudeHome, "skills/anybrowser/SKILL.md");
    mkdirSync(join(claudeHome, "skills/anybrowser"), { recursive: true });
    writeFileSync(skillFile, "my own edits\n");
    try {
      const result = runCli(["uninstall"], home, {
        env: installEnv(fake.dir, claudeHome),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("left");
      expect(readFileSync(skillFile, "utf8")).toBe("my own edits\n");
    } finally {
      cleanupHome(home);
    }
  });
});

describe("anyb --help", () => {
  it("lists install and uninstall", () => {
    const result = runCli(["--help"], makeHome());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^ {2}install\s/m);
    expect(result.stdout).toMatch(/^ {2}uninstall\s/m);
  });
});
