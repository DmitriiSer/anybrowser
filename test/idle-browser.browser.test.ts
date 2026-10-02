import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  addProfile,
  cleanupHome,
  connectClient,
  daemonStatusFrom,
  logPathFor,
  makeHome,
  socketExists,
  waitFor,
} from "./support.js";

/**
 * Item 4 (per-profile browser idle close) and onward: browser-suite tests
 * for the two idle timers (docs/DESIGN.md decision 5). Mirrors the pattern
 * in test/cookie-survival.browser.test.ts: a local page server (never a real
 * site), ANYBROWSER_HEADLESS=1 forced, and small ANYBROWSER_IDLE_MS values
 * instead of waiting minutes.
 */

interface TestPageServer {
  url: string;
  close: () => Promise<void>;
}

/** A cookie name that never appears as a substring of the Chromium Cookies
 * SQLite schema, so a raw-byte search for it only matches a flushed row. */
const COOKIE_NAME = "anybidleflushprobe";

async function startPageServer(): Promise<TestPageServer> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>Idle</title><h1>Idle</h1>");
      return;
    }
    if (req.url === "/set") {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": `${COOKIE_NAME}=1; Max-Age=3600; Path=/`,
      });
      res.end("<title>Set</title><h1>Set</h1>");
      return;
    }
    if (req.url === "/check") {
      const cookieHeader = req.headers.cookie ?? "";
      const match = cookieHeader
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${COOKIE_NAME}=`));
      const value = match ? match.split("=")[1] : "none";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<title>Check</title><h1>cookie:${value}</h1>`);
      return;
    }
    res.writeHead(404);
    res.end();
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

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text content item");
  }
  return first.text;
}

function snapshotText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

interface ProfileStatus {
  running: boolean;
  headless: boolean;
  browser: string;
  tabCount?: number;
  idleForMs?: number;
}

async function profileStatusOf(
  client: Client,
  profile: string,
): Promise<ProfileStatus> {
  const result = await client.callTool({
    name: "profile_status",
    arguments: { profile },
  });
  return JSON.parse(
    textOf(result as { content: Array<{ type: string; text?: string }> }),
  ) as ProfileStatus;
}

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeAll(() => {
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("per-profile browser idle close", () => {
  it(
    "closes the idle profile's browser (daemon and session stay alive), then a later tool call relaunches it",
    async () => {
      const idleMs = 500;
      const pageServer = await startPageServer();
      const id = addProfile(home, "idleclose", "chromium");
      try {
        const session = await connectClient(home, {
          ANYBROWSER_IDLE_MS: String(idleMs),
        });
        try {
          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/` },
          });

          // Poll for the close log line itself (not just running:false):
          // profile_status can flip to not-running an instant before the
          // close (and its log line) actually finishes, since the profile
          // is evicted from the "running" bookkeeping before the close is
          // awaited (see BrowserContextRouter.closeIdleProfile).
          await waitFor(
            () => {
              const log = readFileSync(logPathFor(home), "utf8");
              return log.includes(`browser close: profile=${id}`);
            },
            { timeoutMs: idleMs + 8000 },
          );

          const afterClose = await profileStatusOf(session.client, id);
          expect(afterClose.running).toBe(false);

          // The daemon (which still has this connected session) must still
          // be alive and answering.
          const status = await daemonStatusFrom(session.client);
          expect(typeof status.pid).toBe("number");

          // A later tool call for the same profile relaunches it and works.
          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/` },
          });
          const afterRelaunch = await profileStatusOf(session.client, id);
          expect(afterRelaunch.running).toBe(true);
        } finally {
          await session.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("activity resets both timers", () => {
  it(
    "repeated tool calls shorter than the idle value keep the profile's browser and the daemon alive well past it, then going quiet closes both",
    async () => {
      const idleMs = 400;
      const pageServer = await startPageServer();
      const id = addProfile(home, "idleactivity", "chromium");
      try {
        const session = await connectClient(home, {
          ANYBROWSER_IDLE_MS: String(idleMs),
        });
        let closed = false;
        try {
          // Six navigations spaced well under idleMs, spanning more than
          // 2x idleMs in total: if activity did not reset the timer, the
          // profile (and, since this is the daemon's only session, the
          // daemon too) would already be gone partway through.
          for (let i = 0; i < 6; i++) {
            await session.client.callTool({
              name: "browser_navigate",
              arguments: { profile: id, url: `${pageServer.url}/` },
            });
            await new Promise((resolve) => setTimeout(resolve, idleMs / 3));
          }

          const stillRunning = await profileStatusOf(session.client, id);
          expect(stillRunning.running).toBe(true);
          const stillUp = await daemonStatusFrom(session.client);
          expect(typeof stillUp.pid).toBe("number");

          const logSoFar = readFileSync(logPathFor(home), "utf8");
          expect(logSoFar.includes(`browser close: profile=${id}`)).toBe(false);

          // Now go quiet: no more tool calls naming this profile. The
          // profile's browser idle-closes on its own even though the
          // session is still connected (the daemon must not exit, since a
          // session is connected).
          await waitFor(
            () => {
              const log = readFileSync(logPathFor(home), "utf8");
              return log.includes(`browser close: profile=${id}`);
            },
            { timeoutMs: idleMs + 8000 },
          );

          // Closing the session too lets the daemon's own idle-exit timer
          // run its course.
          await session.close();
          closed = true;
          await waitFor(() => !socketExists(home), {
            timeoutMs: idleMs + 8000,
          });
        } finally {
          if (!closed) {
            await session.close();
          }
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("ANYBROWSER_IDLE_MS=off disables per-profile idle close too", () => {
  it(
    "the profile's browser never closes for idleness across several times the default small test window, and daemon_status.idleMs is null",
    async () => {
      const referenceIdleMs = 400;
      const pageServer = await startPageServer();
      const id = addProfile(home, "idleoff", "chromium");
      try {
        const session = await connectClient(home, {
          ANYBROWSER_IDLE_MS: "off",
        });
        try {
          const status = await daemonStatusFrom(session.client);
          expect(status.idleMs).toBeNull();

          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/` },
          });

          await new Promise((resolve) =>
            setTimeout(resolve, referenceIdleMs * 6),
          );

          const stillRunning = await profileStatusOf(session.client, id);
          expect(stillRunning.running).toBe(true);

          const log = readFileSync(logPathFor(home), "utf8");
          expect(log.includes(`browser close: profile=${id}`)).toBe(false);
        } finally {
          await session.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("profile_status.idleForMs", () => {
  it(
    "grows monotonically between two calls for a running profile that receives no activity in between",
    async () => {
      const pageServer = await startPageServer();
      const id = addProfile(home, "idlegrowth", "chromium");
      try {
        // A generous idle value: this test cares only about idleForMs
        // growing between two reads, not about anything ever closing.
        const session = await connectClient(home, {
          ANYBROWSER_IDLE_MS: "60000",
        });
        try {
          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/` },
          });

          const first = await profileStatusOf(session.client, id);
          expect(first.running).toBe(true);
          expect(typeof first.idleForMs).toBe("number");

          await new Promise((resolve) => setTimeout(resolve, 150));

          const second = await profileStatusOf(session.client, id);
          expect(typeof second.idleForMs).toBe("number");
          expect(second.idleForMs as number).toBeGreaterThan(
            first.idleForMs as number,
          );
        } finally {
          await session.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("an idle-closed profile keeps its logins", () => {
  it(
    "a persistent cookie set before idle-close is still there after the profile relaunches and navigates in a fresh tab",
    async () => {
      const idleMs = 500;
      const pageServer = await startPageServer();
      const id = addProfile(home, "idlecookie", "chromium");
      try {
        const session = await connectClient(home, {
          ANYBROWSER_IDLE_MS: String(idleMs),
        });
        try {
          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/set` },
          });
          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/check` },
          });
          const preCloseSnapshot = await session.client.callTool({
            name: "browser_snapshot",
            arguments: { profile: id },
          });
          expect(
            snapshotText(
              preCloseSnapshot as {
                content: Array<{ type: string; text?: string }>;
              },
            ),
          ).toContain("cookie:1");

          // Let the profile idle-close (still a connected session, still
          // well within the daemon's own idle window since it's the same
          // idleMs value and this session never disconnects).
          await waitFor(
            () => {
              const log = readFileSync(logPathFor(home), "utf8");
              return log.includes(`browser close: profile=${id}`);
            },
            { timeoutMs: idleMs + 8000 },
          );
          const closedStatus = await profileStatusOf(session.client, id);
          expect(closedStatus.running).toBe(false);

          // Navigate again: this relaunches the profile lazily into a fresh
          // tab (decision 10: a new embedded connection always opens its
          // own tab first).
          await session.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/check` },
          });
          const postRelaunchSnapshot = await session.client.callTool({
            name: "browser_snapshot",
            arguments: { profile: id },
          });
          expect(
            snapshotText(
              postRelaunchSnapshot as {
                content: Array<{ type: string; text?: string }>;
              },
            ),
          ).toContain("cookie:1");
        } finally {
          await session.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
