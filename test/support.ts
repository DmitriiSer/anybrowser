import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const cliPath = fileURLToPath(
  new URL("../dist/cli.js", import.meta.url),
);

/** The socket path length limit asserted by src/paths.ts (see that module for the rationale). */
const SOCKET_PATH_LIMIT = 104;

/**
 * Creates a fresh, short-enough temp directory. Unix socket paths are capped
 * around 100 bytes, so a long OS temp dir (macOS's default is deep under
 * /private/var/folders/...) can push daemon.sock over the limit; fall back
 * to a short path under /tmp when that would happen.
 */
function makeShortTempDir(): string {
  const preferred = mkdtempSync(join(tmpdir(), "ab-"));
  const socketPath = join(preferred, "daemon.sock");
  if (Buffer.byteLength(socketPath, "utf8") <= SOCKET_PATH_LIMIT - 4) {
    return preferred;
  }
  rmSync(preferred, { recursive: true, force: true });
  return mkdtempSync("/tmp/ab-");
}

/** Creates a fresh, short-enough ANYBROWSER_HOME for a single test. */
export function makeHome(): string {
  return makeShortTempDir();
}

/**
 * Returns a short-enough ANYBROWSER_HOME path that does NOT exist yet (only
 * its parent does), to test first-run behaviour where the state directory
 * itself must be created lazily. Clean up with `cleanupMissingHome`.
 */
export function makeMissingHome(): string {
  const parent = makeShortTempDir();
  return join(parent, "child");
}

/** Cleans up a home returned by `makeMissingHome` (also removes its parent temp dir). */
export function cleanupMissingHome(home: string): void {
  cleanupHome(home);
  try {
    rmSync(dirname(home), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function envFor(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env["ANYBROWSER_HOME"] = home;
  return env;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], home: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: envFor(home),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function socketPathFor(home: string): string {
  return join(home, "daemon.sock");
}

export function lockPathFor(home: string): string {
  return join(home, "daemon.lock");
}

/** Best-effort cleanup: stop the daemon for `home` (if any) and remove the directory. */
export function cleanupHome(home: string): void {
  try {
    spawnSync(process.execPath, [cliPath, "stop"], {
      encoding: "utf8",
      env: envFor(home),
      timeout: 10000,
    });
  } catch {
    // best effort
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
  /** pid of the `anyb mcp` stdio proxy child process backing this client. */
  proxyPid: number;
}

/** Connects an MCP client through `anyb mcp` (spawns the daemon if absent). */
export async function connectClient(home: string): Promise<ConnectedClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    env: envFor(home),
    stderr: "inherit",
  });
  const client = new Client({
    name: "anybrowser-test-client",
    version: "0.0.0-test",
  });
  await client.connect(transport);
  const proxyPid = transport.pid;
  if (proxyPid === null) {
    throw new Error("connectClient: transport has no pid after connect");
  }
  return {
    client,
    close: () => client.close(),
    proxyPid,
  };
}

export async function daemonStatusFrom(client: Client): Promise<{
  version: string;
  pid: number;
  uptimeSeconds: number;
  sessions: number;
  profiles: unknown[];
}> {
  const result = await client.callTool({
    name: "daemon_status",
    arguments: {},
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("daemon_status did not return a text content item");
  }
  return JSON.parse(first.text) as {
    version: string;
    pid: number;
    uptimeSeconds: number;
    sessions: number;
    profiles: unknown[];
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 5000,
    intervalMs = 50,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function socketExists(home: string): boolean {
  return existsSync(socketPathFor(home));
}
