import { createConnection, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  cleanupHome,
  cleanupMissingHome,
  cliPath,
  connectClient,
  daemonStatusFrom,
  envFor,
  isPidAlive,
  lockPathFor,
  makeHome,
  makeMissingHome,
  runCli,
  socketExists,
  socketPathFor,
  waitFor,
  type ConnectedClient,
} from "./support.js";

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("anyb status", () => {
  it(
    "prints 'not running' and does not spawn a daemon when nothing is running",
    () => {
      const result = runCli(["status"], home);
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe("not running");
      expect(socketExists(home)).toBe(false);
    },
    SPAWN_TIMEOUT,
  );
});

describe("first run (state directory does not exist yet)", () => {
  it(
    "creates the state directory (mode 0700) and serves a client when ANYBROWSER_HOME doesn't exist yet",
    async () => {
      const missingHome = makeMissingHome();
      expect(existsSync(missingHome)).toBe(false);

      try {
        const { client, close } = await connectClient(missingHome);
        try {
          const status = await daemonStatusFrom(client);
          expect(typeof status.pid).toBe("number");
        } finally {
          await close();
        }

        expect(existsSync(missingHome)).toBe(true);
        const mode = statSync(missingHome).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        cleanupMissingHome(missingHome);
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb mcp", () => {
  it(
    "spawns the daemon on demand, lists exactly daemon_status, and reports its own session",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["daemon_status"]);

        const status = await daemonStatusFrom(client);
        expect(status.pid).not.toBe(process.pid);
        expect(isPidAlive(status.pid)).toBe(true);
        expect(status.sessions).toBe(1);
        expect(status.profiles).toEqual([]);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "outlives its client: a new connection reaches the same daemon pid",
    async () => {
      const first = await connectClient(home);
      const firstStatus = await daemonStatusFrom(first.client);
      await first.close();

      const second = await connectClient(home);
      try {
        const secondStatus = await daemonStatusFrom(second.client);
        expect(secondStatus.pid).toBe(firstStatus.pid);
      } finally {
        await second.close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "handles a spawn race: 20 simultaneous clients share one daemon, and sessions drops as clients disconnect",
    async () => {
      const clients: ConnectedClient[] = await Promise.all(
        Array.from({ length: 20 }, () => connectClient(home)),
      );

      try {
        const statuses = await Promise.all(
          clients.map((c) => daemonStatusFrom(c.client)),
        );
        const pids = new Set(statuses.map((s) => s.pid));
        expect(pids.size).toBe(1);

        const afterAllConnected = runCli(["status"], home);
        expect(afterAllConnected.status).toBe(0);
        const parsed = JSON.parse(afterAllConnected.stdout.trim()) as {
          sessions: number;
        };
        expect(parsed.sessions).toBe(20);
        expect(existsSync(lockPathFor(home))).toBe(false);

        // Close a third of the clients and confirm the session count drops.
        const toClose = clients.slice(0, 7);
        await Promise.all(toClose.map((c) => c.close()));

        await waitFor(
          () => {
            const result = runCli(["status"], home);
            if (result.status !== 0) return false;
            const s = JSON.parse(result.stdout.trim()) as { sessions: number };
            return s.sessions === 13;
          },
          { timeoutMs: 10000 },
        );

        const remaining = clients.slice(7);
        await Promise.all(remaining.map((c) => c.close()));
      } finally {
        // Best-effort: close anything left open if an assertion threw above.
        await Promise.allSettled(clients.map((c) => c.close()));
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "connects successfully despite a leftover dead-pid lock and a leftover non-listening socket",
    async () => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(home, { recursive: true, mode: 0o700 });

      // Guaranteed-dead pid: spawn a process and wait for it to exit.
      const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      const deadPid = dead.pid;
      expect(typeof deadPid).toBe("number");
      writeFileSync(lockPathFor(home), String(deadPid));

      // A stray file at the socket path that nothing listens on.
      writeFileSync(socketPathFor(home), "");

      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["daemon_status"]);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects an unknown tool with an MCP error instead of crashing",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await expect(
          client.callTool({ name: "nope", arguments: {} }),
        ).rejects.toThrow();
        // The daemon must still be healthy after the bad call.
        const status = await daemonStatusFrom(client);
        expect(status.sessions).toBe(1);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("bad hello line", () => {
  it(
    "gets an error reply and is closed, without harming the daemon",
    async () => {
      // Get a daemon running first.
      const warm = await connectClient(home);
      await warm.close();
      expect(socketExists(home)).toBe(true);

      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(socketPathFor(home));
        let buffered = "";
        socket.on("connect", () => {
          socket.write("this is not json\n");
        });
        socket.on("data", (chunk) => {
          buffered += chunk.toString("utf8");
          if (buffered.includes("\n")) {
            resolve(buffered);
          }
        });
        socket.on("error", reject);
        socket.on("close", () => {
          resolve(buffered);
        });
      });

      const parsed = JSON.parse(reply.trim()) as { error?: string };
      expect(typeof parsed.error).toBe("string");

      // The daemon must still work normally afterwards.
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["daemon_status"]);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("client vanishes right after a non-mcp hello", () => {
  it(
    "survives 200 vanish-after-status-hello and 200 vanish-after-garbage-hello connections",
    async () => {
      // Get a daemon running first and remember its pid.
      const warm = await connectClient(home);
      const warmStatus = await daemonStatusFrom(warm.client);
      await warm.close();

      function vanishAfterHello(line: string): Promise<void> {
        return new Promise((resolve) => {
          const socket = createConnection(socketPathFor(home));
          const finish = () => {
            socket.removeAllListeners();
            socket.destroy();
            resolve();
          };
          socket.once("connect", () => {
            socket.write(line);
            finish();
          });
          socket.once("error", finish);
        });
      }

      const statusHelloLine = `{"anybrowser":{"version":"0.0.0-test","role":"status"}}\n`;
      const garbageHelloLine = "this is not a valid hello line at all\n";

      const attempts: Array<Promise<void>> = [];
      for (let i = 0; i < 200; i++) {
        attempts.push(vanishAfterHello(statusHelloLine));
      }
      for (let i = 0; i < 200; i++) {
        attempts.push(vanishAfterHello(garbageHelloLine));
      }
      await Promise.all(attempts);

      // Hammer `anyb status` for a few seconds: if the daemon crashed and
      // was never respawned, this reports "not running" (exit 1); if it
      // crashed and got respawned by a later command, the pid would differ.
      // Either way this must consistently report the SAME original pid.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const result = runCli(["status"], home);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout.trim()) as { pid: number };
        expect(parsed.pid).toBe(warmStatus.pid);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Still serves a normal MCP client on the same pid.
      const { client, close } = await connectClient(home);
      try {
        const status = await daemonStatusFrom(client);
        expect(status.pid).toBe(warmStatus.pid);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("stale lock detection", () => {
  it(
    "connects well within the spawn deadline despite an empty leftover lock file 5s old",
    async () => {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(lockPathFor(home), "");
      const fiveSecondsAgo = new Date(Date.now() - 5000);
      utimesSync(lockPathFor(home), fiveSecondsAgo, fiveSecondsAgo);

      const start = Date.now();
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["daemon_status"]);
        expect(Date.now() - start).toBeLessThan(8000);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "connects well within the spawn deadline despite a leftover lock file with a live pid whose mtime is 20s old",
    async () => {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(lockPathFor(home), String(process.pid));
      const twentySecondsAgo = new Date(Date.now() - 20000);
      utimesSync(lockPathFor(home), twentySecondsAgo, twentySecondsAgo);

      const start = Date.now();
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["daemon_status"]);
        expect(Date.now() - start).toBeLessThan(8000);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("file permissions", () => {
  it(
    "creates the state directory with mode 0700 and the socket with mode 0600",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await daemonStatusFrom(client);
        const homeMode = statSync(home).mode & 0o777;
        expect(homeMode).toBe(0o700);
        const sockMode = statSync(socketPathFor(home)).mode & 0o777;
        expect(sockMode).toBe(0o600);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("mcp message arriving in the same chunk as the hello line", () => {
  it(
    "handles an initialize request written in the same TCP write as the hello line",
    async () => {
      // Get a daemon running first.
      const warm = await connectClient(home);
      await warm.close();
      expect(socketExists(home)).toBe(true);

      const helloLine = `{"anybrowser":{"version":"0.0.0-test","role":"mcp"}}\n`;
      const initializeRequest =
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "anybrowser-raw-test-client",
              version: "0.0.0",
            },
          },
        }) + "\n";

      const reply = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(socketPathFor(home));
        let buffered = "";
        socket.on("connect", () => {
          // Both lines in a single write call, so the daemon must hand the
          // leftover bytes after the hello line's newline to the MCP
          // transport instead of dropping them.
          socket.write(helloLine + initializeRequest);
        });
        socket.on("data", (chunk) => {
          buffered += chunk.toString("utf8");
          if (buffered.includes("\n")) {
            resolve(buffered);
          }
        });
        socket.on("error", reject);
        socket.on("close", () => {
          resolve(buffered);
        });
      });

      const parsed = JSON.parse(reply.trim()) as {
        id: number;
        result?: { protocolVersion?: string; serverInfo?: { name?: string } };
      };
      expect(parsed.id).toBe(1);
      expect(typeof parsed.result?.protocolVersion).toBe("string");
      expect(parsed.result?.serverInfo?.name).toBe("anybrowser");
    },
    SPAWN_TIMEOUT,
  );
});

describe("SIGTERM", () => {
  it(
    "shuts the daemon down gracefully: it exits, the socket is removed, and the connected proxy exits too",
    async () => {
      const { client, proxyPid } = await connectClient(home);
      const status = await daemonStatusFrom(client);

      process.kill(status.pid, "SIGTERM");

      await waitFor(() => !isPidAlive(status.pid), { timeoutMs: 5000 });
      expect(socketExists(home)).toBe(false);
      await waitFor(() => !isPidAlive(proxyPid), { timeoutMs: 5000 });
    },
    SPAWN_TIMEOUT,
  );
});

describe("proxy exits when the daemon stops (host keeps stdin open)", () => {
  it(
    "the proxy process exits after `anyb stop`, even though its stdin stays open",
    async () => {
      const { proxyPid } = await connectClient(home);

      const stopResult = runCli(["stop"], home);
      expect(stopResult.status).toBe(0);

      await waitFor(() => !isPidAlive(proxyPid), { timeoutMs: 8000 });
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb stop", () => {
  it(
    "prints 'not running' and exits 0 when nothing is running",
    () => {
      const result = runCli(["stop"], home);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("not running");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "stops a running daemon: socket removed, pid dead, status says not running",
    async () => {
      const warm = await connectClient(home);
      const status = await daemonStatusFrom(warm.client);
      await warm.close();

      const result = runCli(["stop"], home);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("stopped");
      expect(socketExists(home)).toBe(false);

      // The socket file disappears as part of shutdown, slightly before the
      // OS finishes tearing down the process; poll rather than assume both
      // happen in the same tick.
      await waitFor(() => !isPidAlive(status.pid), { timeoutMs: 5000 });

      const afterStop = runCli(["status"], home);
      expect(afterStop.status).toBe(1);
      expect(afterStop.stdout.trim()).toBe("not running");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "prints an error to stderr and exits 1 if the socket file is still there after the wait",
    async () => {
      mkdirSync(home, { recursive: true, mode: 0o700 });

      // A tiny fake daemon that acks the stop hello but never shuts down
      // (never removes daemon.sock), so the wait always times out. Uses a
      // short configured wait instead of the real 5s default to keep this
      // test fast.
      const fakeDaemon = createServer((socket) => {
        let buffered = "";
        socket.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          if (!buffered.includes("\n")) return;
          socket.write(JSON.stringify({ ok: true }) + "\n");
          // deliberately: no socket.end(), no unlinking daemon.sock
        });
      });
      await new Promise<void>((resolve, reject) => {
        fakeDaemon.once("error", reject);
        fakeDaemon.listen(socketPathFor(home), () => resolve());
      });

      try {
        // Spawned asynchronously (not the synchronous runCli helper): the
        // fake daemon above lives in THIS process's event loop, and a
        // synchronous spawnSync call would freeze that loop while waiting
        // for the child, starving the fake daemon and hanging the test.
        const child = spawn(process.execPath, [cliPath, "stop"], {
          env: { ...envFor(home), ANYBROWSER_STOP_WAIT_MS: "300" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
        const exitCode = await new Promise<number | null>((resolve) => {
          child.on("exit", (code) => resolve(code));
        });

        expect(exitCode).toBe(1);
        expect(stdout.trim()).not.toBe("stopped");
        expect(stderr.trim().length).toBeGreaterThan(0);
        expect(socketExists(home)).toBe(true);
      } finally {
        fakeDaemon.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
