#!/usr/bin/env node
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { connectOnce } from "./connect.js";
import { runDaemon } from "./daemon.js";
import { formatHelloLine } from "./hello.js";
import { resolvePaths } from "./paths.js";
import { runProxy } from "./proxy.js";
import { readVersion } from "./version.js";

const USAGE = `usage: anyb <command>

commands:
  mcp        run the stdio-to-daemon MCP proxy (what MCP hosts spawn)
  daemon     run the daemon in the foreground (internal; use 'mcp' instead)
  status     print daemon status without starting it
  stop       stop the daemon if it is running

options:
  -v, --version   print the version
  -h, --help      print this message
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads one newline-delimited reply line from a raw socket. Resolves null if the socket ends first. */
function readLine(socket: Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buffered = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onEnd);
      socket.off("error", onEnd);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex !== -1) {
        cleanup();
        resolve(buffered.slice(0, newlineIndex));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    socket.on("data", onData);
    socket.on("close", onEnd);
    socket.on("error", onEnd);
  });
}

async function runStatusCommand(): Promise<number> {
  const paths = resolvePaths();
  const socket = await connectOnce(paths.socket);
  if (!socket) {
    console.log("not running");
    return 1;
  }

  socket.write(formatHelloLine("status", readVersion()));
  const line = await readLine(socket);
  socket.destroy();

  if (line === null) {
    console.error("anyb: connected to the daemon but got no response");
    return 1;
  }
  console.log(line);
  return 0;
}

const DEFAULT_STOP_WAIT_MS = 5000;

/** How long `anyb stop` waits for the socket file to disappear, configurable for tests. */
function stopWaitMs(): number {
  const raw = process.env["ANYBROWSER_STOP_WAIT_MS"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_STOP_WAIT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STOP_WAIT_MS;
}

async function runStopCommand(): Promise<number> {
  const paths = resolvePaths();
  const socket = await connectOnce(paths.socket);
  if (!socket) {
    console.log("not running");
    return 0;
  }

  socket.write(formatHelloLine("stop", readVersion()));
  await readLine(socket);
  socket.destroy();

  const waitMs = stopWaitMs();
  const deadline = Date.now() + waitMs;
  while (existsSync(paths.socket) && Date.now() < deadline) {
    await delay(50);
  }

  if (existsSync(paths.socket)) {
    console.error(
      `anyb: daemon did not stop within ${waitMs}ms; socket file still present at ${paths.socket}`,
    );
    return 1;
  }

  console.log("stopped");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  if (command === "--version" || command === "-v") {
    console.log(readVersion());
    return 0;
  }
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "mcp") {
    return runProxy(resolvePaths());
  }
  if (command === "daemon") {
    await runDaemon(resolvePaths());
    return 0;
  }
  if (command === "status") {
    return runStatusCommand();
  }
  if (command === "stop") {
    return runStopCommand();
  }

  console.error(`anyb: unknown command '${command}'\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `anyb: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
