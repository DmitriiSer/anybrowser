import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { assertSocketPathFits, type AnybrowserPaths } from "./paths.js";
import {
  formatErrorLine,
  formatStatusLine,
  formatStopAckLine,
  parseHelloLine,
  type DaemonStatus,
} from "./hello.js";
import { readVersion } from "./version.js";
import { SocketTransport } from "./transport.js";

const DAEMON_STATUS_TOOL: Tool = {
  name: "daemon_status",
  description:
    "Report this daemon's version, pid, uptime, and connected MCP session count.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

/** Bytes we'll buffer looking for the hello line's newline before giving up on a connection. */
const MAX_HELLO_LINE_BYTES = 4096;

interface DaemonState {
  paths: AnybrowserPaths;
  version: string;
  startedAt: number;
  sessions: Set<Socket>;
  server: NetServer;
  shuttingDown: boolean;
}

function log(event: string): void {
  process.stderr.write(`[anyb daemon] ${new Date().toISOString()} ${event}\n`);
}

function buildStatus(state: DaemonState): DaemonStatus {
  return {
    version: state.version,
    pid: process.pid,
    uptimeSeconds: (Date.now() - state.startedAt) / 1000,
    sessions: state.sessions.size,
    profiles: [],
  };
}

/** Connects to `socketPath` just to see whether anything answers. Never throws. */
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (alive: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * If daemon.sock exists and something is listening on it, another daemon
 * already owns this state dir: exit quietly. If it exists but nothing
 * answers, it's a stale leftover: remove it and let the caller bind fresh.
 */
async function claimSocketOrExit(paths: AnybrowserPaths): Promise<void> {
  if (!existsSync(paths.socket)) {
    return;
  }
  const alive = await probeSocket(paths.socket);
  if (alive) {
    log("another daemon is already live on this socket; exiting");
    process.exit(0);
  }
  try {
    unlinkSync(paths.socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function startMcpSession(
  socket: Socket,
  initialData: Buffer,
  state: DaemonState,
  clientVersion: string,
): void {
  state.sessions.add(socket);
  log(
    `session open (client version ${clientVersion}, sessions=${state.sessions.size})`,
  );

  socket.on("close", () => {
    state.sessions.delete(socket);
    log(`session close (sessions=${state.sessions.size})`);
  });
  // No 'error' listener here: attachHelloHandler already installed the one
  // permanent listener for this socket's whole life (see its comment), so
  // adding a second one here would log every socket error twice.

  try {
    const transport = new SocketTransport(socket, initialData);
    const server = new McpServer(
      { name: "anybrowser", version: state.version },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [DAEMON_STATUS_TOOL],
    }));

    server.setRequestHandler(CallToolRequestSchema, (request) => {
      if (request.params.name !== "daemon_status") {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `unknown tool '${request.params.name}'`,
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(buildStatus(state)) }],
      };
    });

    server.connect(transport).catch((error: unknown) => {
      log(
        `session error: ${error instanceof Error ? error.message : String(error)}`,
      );
      socket.destroy();
    });
  } catch (error) {
    log(
      `session error: ${error instanceof Error ? error.message : String(error)}`,
    );
    socket.destroy();
  }
}

function handleHello(
  socket: Socket,
  line: string,
  rest: Buffer,
  state: DaemonState,
): void {
  const parsed = parseHelloLine(line);
  if (!parsed.ok) {
    log(`bad hello: ${parsed.error}`);
    socket.end(formatErrorLine(parsed.error));
    return;
  }

  switch (parsed.role) {
    case "status":
      socket.end(formatStatusLine(buildStatus(state)));
      return;
    case "stop":
      socket.write(formatStopAckLine(), () => {
        socket.end(() => {
          void shutdown(state, 0);
        });
      });
      return;
    case "mcp":
      startMcpSession(socket, rest, state, parsed.version);
      return;
  }
}

function attachHelloHandler(socket: Socket, state: DaemonState): void {
  let buffered: Buffer = Buffer.alloc(0);

  // Every accepted socket must have an 'error' listener for its whole life:
  // Node treats an unhandled 'error' event as fatal to the process. A reply
  // write can fail (e.g. EPIPE) after the hello-parsing phase is done, once
  // control has moved on to handleHello/startMcpSession, so this listener is
  // never removed - unlike the hello-parsing 'data'/'close' listeners below,
  // which are only needed until the hello line is read.
  socket.on("error", (error) => {
    log(`session error: ${error.message}`);
  });

  const cleanup = () => {
    socket.off("data", onData);
    socket.off("close", onClose);
  };
  const onClose = () => cleanup();
  const onData = (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    const newlineIndex = buffered.indexOf(0x0a);
    if (newlineIndex === -1) {
      if (buffered.length > MAX_HELLO_LINE_BYTES) {
        log("bad hello: first line too long");
        socket.destroy();
      }
      return;
    }
    cleanup();
    const line = buffered
      .subarray(0, newlineIndex)
      .toString("utf8")
      .replace(/\r$/, "");
    const rest: Buffer = buffered.subarray(newlineIndex + 1);
    handleHello(socket, line, rest, state);
  };

  socket.on("data", onData);
  socket.on("close", onClose);
}

async function shutdown(state: DaemonState, exitCode: number): Promise<void> {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;
  log("stop: shutting down");

  state.server.close();
  for (const session of state.sessions) {
    session.destroy();
  }
  state.sessions.clear();

  try {
    unlinkSync(state.paths.socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`stop: failed to remove socket: ${(error as Error).message}`);
    }
  }

  log("stop: done");
  process.exit(exitCode);
}

/** Runs the daemon in the foreground. Resolves once it is listening; keeps running until shutdown. */
export async function runDaemon(paths: AnybrowserPaths): Promise<void> {
  assertSocketPathFits(paths.socket);
  log(`start pid=${process.pid} version=${readVersion()}`);

  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);

  await claimSocketOrExit(paths);

  const version = readVersion();
  const server = createServer();
  const state: DaemonState = {
    paths,
    version,
    startedAt: Date.now(),
    sessions: new Set(),
    server,
    shuttingDown: false,
  };

  server.on("connection", (socket) => {
    attachHelloHandler(socket, state);
  });
  server.on("error", (error) => {
    log(`server error: ${error.message}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(paths.socket, () => {
      server.off("error", onError);
      resolve();
    });
  });

  chmodSync(paths.socket, 0o600);
  log(`listening on ${paths.socket}`);

  process.on("SIGTERM", () => void shutdown(state, 0));
  process.on("SIGINT", () => void shutdown(state, 0));
}
