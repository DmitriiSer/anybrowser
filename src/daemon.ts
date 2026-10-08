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
import {
  BrowserContextRouter,
  BrowserSession,
  ProfileHeadlessRunningError,
  ProfileUrlBlockedError,
} from "./browser.js";
import {
  addProfileWithDetection,
  allowedOriginsProblem,
  listProfiles,
  listProfilesWithBadList,
  profileExists,
  readProfile,
} from "./profile.js";
import { resolveIdleMs } from "./idle.js";

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

const PROFILE_LIST_TOOL: Tool = {
  name: "profile_list",
  description:
    "List every anybrowser profile: id, browser, headless, allowedOrigins (the sites the profile is restricted to, or null for no restriction), and whether it is currently running.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const PROFILE_CREATE_TOOL: Tool = {
  name: "profile_create",
  description:
    "Create a new anybrowser profile. `browser` is one of chrome, chromium, brave, edge, arc, vivaldi, opera. Returns the new profile's id.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "A lowercase slug, e.g. 'work'. Composed into the id as '<name>-in-<browser>'.",
      },
      browser: {
        type: "string",
        description: "chrome | chromium | brave | edge | arc | vivaldi | opera",
      },
      headless: {
        type: "boolean",
        description: "Defaults to false.",
      },
    },
    required: ["name", "browser"],
    additionalProperties: false,
  },
};

const PROFILE_STATUS_TOOL: Tool = {
  name: "profile_status",
  description:
    "Report a profile's running state, tab count (when running), headless flag, browser, and allowedOrigins (the sites the profile is restricted to, or null for no restriction).",
  inputSchema: {
    type: "object",
    properties: {
      profile: { type: "string", description: "The profile id." },
    },
    required: ["profile"],
    additionalProperties: false,
  },
};

const PROFILE_LOGIN_TOOL: Tool = {
  name: "profile_login",
  description:
    "Open `url` in a new, foregrounded tab of `profile`'s browser (launching it headed if not already running), so a human can log in. Returns immediately; ask the user to log in, then verify with a snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      profile: { type: "string", description: "The profile id." },
      url: { type: "string", description: "The URL to open for login." },
    },
    required: ["profile", "url"],
    additionalProperties: false,
  },
};

const DAEMON_TOOLS: Tool[] = [
  DAEMON_STATUS_TOOL,
  PROFILE_LIST_TOOL,
  PROFILE_CREATE_TOOL,
  PROFILE_STATUS_TOOL,
  PROFILE_LOGIN_TOOL,
];

/** Bytes we'll buffer looking for the hello line's newline before giving up on a connection. */
const MAX_HELLO_LINE_BYTES = 4096;

interface DaemonState {
  paths: AnybrowserPaths;
  version: string;
  startedAt: number;
  sessions: Set<Socket>;
  server: NetServer;
  shuttingDown: boolean;
  browserRouter: BrowserContextRouter;
  /** Resolved once at daemon startup (src/idle.ts); null means idling is disabled. */
  idleMs: number | null;
  /** Pending "exit for idleness" timer, set only while sessions.size === 0. */
  idleExitTimer: NodeJS.Timeout | undefined;
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
    profiles: state.browserRouter.runningProfileIds(),
    idleMs: state.idleMs,
  };
}

/**
 * Clears any pending idle-exit timer, e.g. because a session just connected
 * or the daemon is shutting down for another reason.
 */
function clearIdleExitTimer(state: DaemonState): void {
  if (state.idleExitTimer !== undefined) {
    clearTimeout(state.idleExitTimer);
    state.idleExitTimer = undefined;
  }
}

/**
 * Re-arms the "exit for idleness" timer whenever sessions.size is (or just
 * became) zero. A session connecting cancels it (see startMcpSession); this
 * is called again on every session close so the countdown restarts from that
 * moment, not from whenever the daemon happened to start.
 *
 * Idling is disabled entirely when `idleMs` is null (ANYBROWSER_IDLE_MS=off).
 */
function armIdleExitTimer(state: DaemonState): void {
  clearIdleExitTimer(state);
  if (state.idleMs === null || state.sessions.size > 0 || state.shuttingDown) {
    return;
  }
  state.idleExitTimer = setTimeout(() => {
    // Re-check at fire time: a session may have connected in the interim.
    if (state.sessions.size === 0 && !state.shuttingDown) {
      log(`idle exit: no sessions connected for ${state.idleMs}ms`);
      void shutdown(state, 0);
    }
  }, state.idleMs);
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
  clearIdleExitTimer(state);
  log(
    `session open (client version ${clientVersion}, sessions=${state.sessions.size})`,
  );

  const browserSession = new BrowserSession(state.browserRouter);
  socket.on("close", () => {
    state.sessions.delete(socket);
    log(`session close (sessions=${state.sessions.size})`);
    armIdleExitTimer(state);
    // Its tabs go with it; the browser stays (the daemon owns its lifetime).
    browserSession.dispose().catch((error: unknown) => {
      log(
        `session tab cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const browserTools = await browserSession.listTools();
      return { tools: [...DAEMON_TOOLS, ...browserTools] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "daemon_status") {
        return {
          content: [{ type: "text", text: JSON.stringify(buildStatus(state)) }],
        };
      }
      if (request.params.name === "profile_list") {
        const profiles = listProfiles(state.paths).map((profile) => ({
          id: profile.id,
          browser: profile.browser,
          headless: profile.headless,
          allowedOrigins: profile.allowedOrigins,
          running: state.browserRouter.runningProfileIds().includes(profile.id),
        }));
        const broken = listProfilesWithBadList(state.paths).map(
          ({ id, problem }) => ({ id, error: problem }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify([...profiles, ...broken]),
            },
          ],
        };
      }
      if (request.params.name === "profile_create") {
        const args = (request.params.arguments ?? {}) as {
          name?: unknown;
          browser?: unknown;
          headless?: unknown;
          allowedOrigins?: unknown;
        };
        if (args.allowedOrigins !== undefined) {
          // The allowed-sites list is a human guard rail, like `headless`
          // (decision 7). Failing loudly beats ignoring it: an agent that
          // thought it had pinned a profile would act as if it were safe.
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "profile_create cannot set an allowed-sites list; only the user can, with 'anyb profile add <name> <browser> --allow <list>' or 'anyb profile set <id> allowedOrigins=<list>'",
              },
            ],
          };
        }
        if (typeof args.name !== "string" || typeof args.browser !== "string") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "profile_create requires string 'name' and 'browser'",
              },
            ],
          };
        }
        const outcome = addProfileWithDetection(state.paths, {
          name: args.name,
          browser: args.browser,
          headless: args.headless === true,
        });
        if (!outcome.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: outcome.message }],
          };
        }
        return { content: [{ type: "text", text: outcome.id }] };
      }
      if (request.params.name === "profile_status") {
        const args = (request.params.arguments ?? {}) as { profile?: unknown };
        if (typeof args.profile !== "string" || args.profile.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "profile_status requires a string 'profile' argument",
          );
        }
        if (!profileExists(state.paths, args.profile)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `unknown profile '${args.profile}'`,
          );
        }
        const problem = allowedOriginsProblem(state.paths, args.profile);
        if (problem) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Profile '${args.profile}': ${problem}. The last list read stays in force while the daemon runs. Ask the user to fix profile.json outside the agent.`,
              },
            ],
          };
        }
        const stored = readProfile(state.paths, args.profile)!;
        const runningContext = state.browserRouter.runningContext(args.profile);
        const idleForMs = state.browserRouter.idleForMs(args.profile);
        const status = {
          running: runningContext !== undefined,
          headless: stored.headless,
          browser: stored.browser,
          allowedOrigins: stored.allowedOrigins,
          ...(runningContext
            ? {
                tabCount: runningContext.pages().length,
                ...(idleForMs !== undefined ? { idleForMs } : {}),
              }
            : {}),
        };
        return { content: [{ type: "text", text: JSON.stringify(status) }] };
      }
      if (request.params.name === "profile_login") {
        const args = (request.params.arguments ?? {}) as {
          profile?: unknown;
          url?: unknown;
        };
        if (
          typeof args.profile !== "string" ||
          args.profile.length === 0 ||
          typeof args.url !== "string" ||
          args.url.length === 0
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "profile_login requires string 'profile' and 'url' arguments",
          );
        }
        if (!profileExists(state.paths, args.profile)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `unknown profile '${args.profile}'`,
          );
        }
        try {
          await state.browserRouter.loginLaunch(args.profile, args.url);
        } catch (error) {
          if (
            error instanceof ProfileHeadlessRunningError ||
            error instanceof ProfileUrlBlockedError
          ) {
            return {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
          throw error;
        }
        return {
          content: [
            {
              type: "text",
              text: `Opened ${args.url} in a new tab for profile '${args.profile}'. Ask the user to log in, then verify with a snapshot.`,
            },
          ],
        };
      }
      return browserSession.callTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      );
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
  clearIdleExitTimer(state);
  log("stop: shutting down");

  state.server.close();
  for (const session of state.sessions) {
    session.destroy();
  }
  state.sessions.clear();

  // Close every open browser context (flushing its cookie store etc. to
  // disk) BEFORE removing the socket file: a caller of `anyb stop` waits for
  // the socket to disappear as its signal that shutdown is complete (see
  // cli.ts's runStopCommand), so the socket must not vanish until a script
  // that immediately inspects the profile directory afterwards sees a
  // flushed cookie store.
  await state.browserRouter.closeAll();

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
  // Playwright's own switch for NOT forcing loopback through a browser's proxy.
  // The allowed-sites proxy must see local servers too, and the check upstream
  // is plain truthiness (even "0" disables forcing), so only deleting it is safe.
  delete process.env["PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK"];
  assertSocketPathFits(paths.socket);
  log(`start pid=${process.pid} version=${readVersion()}`);

  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);

  await claimSocketOrExit(paths);

  const version = readVersion();
  const server = createServer();
  const idleMs = resolveIdleMs(paths);
  const state: DaemonState = {
    paths,
    version,
    startedAt: Date.now(),
    sessions: new Set(),
    server,
    shuttingDown: false,
    browserRouter: new BrowserContextRouter(paths, log, idleMs),
    idleMs,
    idleExitTimer: undefined,
  };
  log(`idle: idleMs=${idleMs === null ? "off" : idleMs}`);
  // No session has connected yet, so the countdown to an idle exit starts
  // from daemon startup itself (see armIdleExitTimer's doc comment).
  armIdleExitTimer(state);

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
