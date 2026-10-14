import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  daemonStatusFrom,
  isPidAlive,
  logPathFor,
  makeHome,
  runCliAsync,
  waitFor,
  type ConnectedClient,
} from "./support.js";

/**
 * A profile's browser can go away without the daemon closing it: the user
 * quits it, it crashes, or something kills it. The daemon must notice, stop
 * treating the profile as running, and launch a fresh browser on the next
 * tool call naming it.
 */

const PROFILE = "default-in-chromium";
const SPAWN_TIMEOUT = 30000;

const PAGES: Record<string, string> = {
  "/a": "<title>Tab A</title><h1>Page A</h1>",
  "/b": "<title>Tab B</title><h1>Page B</h1>",
};

interface TestPageServer {
  url: string;
  close: () => Promise<void>;
}

/** Serves static pages on 127.0.0.1 with an ephemeral port. Never a real website. */
async function startPageServer(): Promise<TestPageServer> {
  const server: Server = createServer((req, res) => {
    const body = req.url ? PAGES[req.url] : undefined;
    if (body) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Result = { content: Array<{ type: string; text?: string }> };

function textOf(result: unknown): string {
  return (result as Result).content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function navigate(session: ConnectedClient, url: string): Promise<void> {
  const result = await session.client.callTool({
    name: "browser_navigate",
    arguments: { profile: PROFILE, url },
  });
  expect(result.isError, textOf(result)).toBeFalsy();
}

/**
 * Navigates as soon as the daemon can: a call that lands before the daemon
 * has heard the browser is gone may still fail, so this retries until a
 * deadline and reports the last failure if none ever succeeds.
 */
async function navigateOnceItWorks(
  session: ConnectedClient,
  url: string,
): Promise<void> {
  let last = "";
  try {
    await waitFor(
      async () => {
        const result = await session.client.callTool({
          name: "browser_navigate",
          arguments: { profile: PROFILE, url },
        });
        last = textOf(result);
        return !result.isError;
      },
      { timeoutMs: 15000, intervalMs: 250 },
    );
  } catch {
    throw new Error(`browser_navigate never succeeded; last result: ${last}`);
  }
}

async function snapshotOf(session: ConnectedClient): Promise<string> {
  return textOf(
    await session.client.callTool({
      name: "browser_snapshot",
      arguments: { profile: PROFILE },
    }),
  );
}

function readLog(home: string): string {
  return readFileSync(logPathFor(home), "utf8");
}

function countLines(log: string, needle: string): number {
  return log.split("\n").filter((line) => line.includes(needle)).length;
}

/**
 * The profile's main browser process, found by the user-data directory
 * inside this test's own temp home (never by name, so no other browser on
 * the machine can match). Child processes carry `--type=`; the main one
 * does not.
 */
function browserProcess(home: string): { pid: number; command: string } {
  const userDataDir = join(home, "profiles", PROFILE, "user-data");
  const listing = spawnSync("ps", ["-A", "-ww", "-o", "pid=,args="], {
    encoding: "utf8",
  }).stdout;
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const command = match?.[2];
    if (
      match &&
      command !== undefined &&
      command.includes(`--user-data-dir=${userDataDir}`) &&
      !command.includes("--type=")
    ) {
      return { pid: Number(match[1]), command };
    }
  }
  throw new Error(`no browser process found for ${userDataDir}`);
}

/** Whether something on 127.0.0.1 accepts a connection on `port`. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Asks the browser itself to quit, as a user closing it would. */
async function quitBrowserFromInside(session: ConnectedClient): Promise<void> {
  await session.client.callTool({
    name: "browser_run_code_unsafe",
    arguments: {
      profile: PROFILE,
      code: `async (page) => { const cdp = await page.context().newCDPSession(page); await cdp.send("Browser.close"); }`,
    },
  });
}

let home: string;
let pageServer: TestPageServer;
const open: ConnectedClient[] = [];

async function connect(
  extraEnv: Record<string, string> = {},
): Promise<ConnectedClient> {
  const session = await connectClient(home, extraEnv);
  open.push(session);
  return session;
}

beforeAll(() => {
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(async () => {
  home = makeHome();
  addProfile(home, "default", "chromium");
  pageServer = await startPageServer();
});

afterEach(async () => {
  for (const session of open.splice(0)) {
    await session.close().catch(() => {});
  }
  await pageServer.close();
  cleanupHome(home);
});

describe("a browser that goes away underneath the daemon", () => {
  it(
    "launches a fresh browser on the next tool call naming the profile",
    async () => {
      const session = await connect();
      await navigate(session, `${pageServer.url}/a`);
      const browser = browserProcess(home);

      await quitBrowserFromInside(session);
      await waitFor(() => !isPidAlive(browser.pid), { timeoutMs: 10000 });

      await navigateOnceItWorks(session, `${pageServer.url}/b`);
      expect(await snapshotOf(session)).toContain("Page B");
      const log = readLog(home);
      expect(
        countLines(log, `browser closed unexpectedly: profile=${PROFILE}`),
      ).toBe(1);
      expect(countLines(log, "browser launch:")).toBe(2);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "stops reporting the profile as running",
    async () => {
      const session = await connect();
      await navigate(session, `${pageServer.url}/a`);
      const browser = browserProcess(home);

      await quitBrowserFromInside(session);
      await waitFor(() => !isPidAlive(browser.pid), { timeoutMs: 10000 });
      await waitFor(() =>
        readLog(home).includes(
          `browser closed unexpectedly: profile=${PROFILE}`,
        ),
      );

      const status = JSON.parse(
        textOf(
          await session.client.callTool({
            name: "profile_status",
            arguments: { profile: PROFILE },
          }),
        ),
      ) as { running: boolean };
      expect(status.running).toBe(false);
      expect((await daemonStatusFrom(session.client)).profiles).not.toContain(
        PROFILE,
      );
    },
    SPAWN_TIMEOUT,
  );

  it(
    "gives each session its own tab again in the fresh browser",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);
      const browser = browserProcess(home);

      await quitBrowserFromInside(a);
      await waitFor(() => !isPidAlive(browser.pid), { timeoutMs: 10000 });

      await navigateOnceItWorks(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);
      expect(await snapshotOf(a)).toContain("Page A");
      expect(await snapshotOf(b)).toContain("Page B");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "frees the proxy port of a browser that was killed",
    async () => {
      const session = await connect();
      await navigate(session, `${pageServer.url}/a`);
      const browser = browserProcess(home);
      const port = Number(
        /--proxy-server=http:\/\/127\.0\.0\.1:(\d+)/.exec(browser.command)?.[1],
      );
      expect(await accepts(port)).toBe(true);

      process.kill(browser.pid, "SIGKILL");
      await waitFor(() => !isPidAlive(browser.pid), { timeoutMs: 10000 });

      await waitFor(async () => !(await accepts(port)));
      await navigateOnceItWorks(session, `${pageServer.url}/b`);
    },
    SPAWN_TIMEOUT,
  );
});

describe("a browser the daemon closes itself", () => {
  it(
    "is not reported as closed unexpectedly after an idle close",
    async () => {
      const idleMs = 500;
      const session = await connect({ ANYBROWSER_IDLE_MS: String(idleMs) });
      await navigate(session, `${pageServer.url}/a`);

      await waitFor(
        () => readLog(home).includes(`browser close: profile=${PROFILE}`),
        { timeoutMs: idleMs + 8000 },
      );

      expect(readLog(home)).not.toContain("browser closed unexpectedly");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "is not reported as closed unexpectedly on anyb stop",
    async () => {
      const session = await connect();
      await navigate(session, `${pageServer.url}/a`);

      const stopped = await runCliAsync(["stop"], home);
      expect(stopped.status, stopped.stderr).toBe(0);
      // The socket file goes when the daemon stops listening, before it has
      // closed its browsers, so wait for the end of its shutdown.
      await waitFor(() => readLog(home).includes("stop: done"));

      const log = readLog(home);
      expect(log).toContain(`browser close: profile=${PROFILE}`);
      expect(log).not.toContain("browser closed unexpectedly");
    },
    SPAWN_TIMEOUT,
  );
});
