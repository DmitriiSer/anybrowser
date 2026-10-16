import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's home, honouring the same CLAUDE_CONFIG_DIR override Claude Code itself reads. */
function claudeHome(): string {
  const override = process.env["CLAUDE_CONFIG_DIR"];
  return override !== undefined && override !== ""
    ? override
    : join(homedir(), ".claude");
}

const packagedSkill = new URL("../skills/anybrowser/SKILL.md", import.meta.url);

export function runInstallCommand(args: string[]): number {
  if (args.includes("--print")) {
    console.log(
      JSON.stringify(
        { mcpServers: { anybrowser: { command: "anyb", args: ["mcp"] } } },
        null,
        2,
      ),
    );
    console.log(
      "Paste this into your MCP host's server configuration (its mcpServers section).",
    );
    return 0;
  }
  const force = args.includes("--force");
  const skillDir = join(claudeHome(), "skills", "anybrowser");
  const skillFile = join(skillDir, "SKILL.md");

  const existing = spawnSync("claude", ["mcp", "get", "anybrowser"], {
    stdio: "ignore",
  });
  if (
    (existing.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
  ) {
    console.error(
      "anyb: Claude Code was not found on PATH; use 'anyb install --print' to get a config snippet instead",
    );
    return 1;
  }

  if (
    !force &&
    existsSync(skillFile) &&
    !readFileSync(skillFile).equals(readFileSync(packagedSkill))
  ) {
    console.error(
      `anyb: ${skillFile} already exists with different content; use 'anyb install --force' to overwrite it`,
    );
    return 1;
  }

  if (existing.status === 0) {
    console.log("anyb: already registered with Claude Code");
  } else {
    spawnSync(
      "claude",
      ["mcp", "add", "--scope", "user", "anybrowser", "--", "anyb", "mcp"],
      { stdio: "ignore" },
    );
  }
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(packagedSkill, skillFile);
  return 0;
}

export function runUninstallCommand(): number {
  const removal = spawnSync(
    "claude",
    ["mcp", "remove", "anybrowser", "--scope", "user"],
    { stdio: "ignore" },
  );
  if ((removal.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    console.log(
      "anyb: Claude Code was not found on PATH; skipped removing the server",
    );
  }

  const skillDir = join(claudeHome(), "skills", "anybrowser");
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    return 0;
  }
  if (readFileSync(skillFile).equals(readFileSync(packagedSkill))) {
    rmSync(skillDir, { recursive: true, force: true });
  } else {
    console.log(`anyb: left ${skillFile} in place because it was modified`);
  }
  return 0;
}
