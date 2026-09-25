import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  daemonStatusFrom,
  isPidAlive,
  makeHome,
  runCliAsync,
  waitFor,
} from "./support.js";

/**
 * The whole point of anybrowser is that a browser profile stays logged in
 * (docs/DESIGN.md decision 2). These tests prove a persistent cookie set
 * before `anyb stop` (or SIGTERM) is still there afterwards, instead of
 * being lost because the browser was killed abruptly (`process.exit()`)
 * rather than closed (`context.close()`, which flushes the cookie store).
 */

/** A cookie name that can never appear as a substring of the Chromium
 * Cookies SQLite schema (column names like `is_persistent`), so a raw-byte
 * search for it in the on-disk file only matches an actual flushed row. */
const COOKIE_NAME = "anybstopflushprobe";

interface TestPageServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves two routes on 127.0.0.1 with an ephemeral port, never a real
 * website: `/set` sets a persistent cookie via `Set-Cookie: ...; Max-Age=...`
 * (so it survives a browser relaunch, unlike a session cookie), `/check`
 * echoes back whether that cookie arrived on the request.
 */
async function startPageServer(): Promise<TestPageServer> {
  const server: Server = createServer((req, res) => {
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

function snapshotText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

/** Finds the Chromium cookie store file for a profile, whichever of the two
 * known layouts this Playwright/Chromium version uses. */
function findCookiesFile(home: string, profileId: string): string | null {
  const base = join(home, "profiles", profileId, "user-data", "Default");
  const candidates = [join(base, "Cookies"), join(base, "Network", "Cookies")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeAll(() => {
  // These tests spawn real daemons that launch a real Chromium; forced
  // headless so no visible window ever appears, in CI or locally.
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("a cookie survives anyb stop", () => {
  it(
    "a persistent cookie set before 'anyb stop' is still there when a fresh session navigates back afterwards",
    async () => {
      // Same page server, same port, for both halves of the test: a cookie
      // is scoped to origin including port.
      const pageServer = await startPageServer();
      const id = addProfile(home, "cookiestop", "chromium");
      try {
        const session1 = await connectClient(home);
        await session1.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/set` },
        });
        await session1.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/check` },
        });
        const preStopSnapshot = await session1.client.callTool({
          name: "browser_snapshot",
          arguments: { profile: id },
        });
        // Sanity check: the cookie really was visible before stop.
        expect(
          snapshotText(
            preStopSnapshot as {
              content: Array<{ type: string; text?: string }>;
            },
          ),
        ).toContain(`cookie:1`);
        await session1.close();

        // Uses runCliAsync (never spawnSync) because this test hosts an
        // in-process HTTP server (the page server above): a synchronous
        // spawn would freeze this process's event loop and starve it.
        const stopResult = await runCliAsync(["stop"], home);
        expect(stopResult.status).toBe(0);

        const session2 = await connectClient(home);
        try {
          await session2.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/check` },
          });
          const postStopSnapshot = await session2.client.callTool({
            name: "browser_snapshot",
            arguments: { profile: id },
          });
          expect(
            snapshotText(
              postStopSnapshot as {
                content: Array<{ type: string; text?: string }>;
              },
            ),
          ).toContain(`cookie:1`);
        } finally {
          await session2.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a cookie survives SIGTERM", () => {
  it(
    "a persistent cookie set before SIGTERM is still there when a fresh session navigates back afterwards",
    async () => {
      const pageServer = await startPageServer();
      const id = addProfile(home, "cookiesigterm", "chromium");
      try {
        const session1 = await connectClient(home);
        await session1.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/set` },
        });
        const status = await daemonStatusFrom(session1.client);

        process.kill(status.pid, "SIGTERM");
        await waitFor(() => !isPidAlive(status.pid), { timeoutMs: 8000 });
        await session1.close().catch(() => {});

        const session2 = await connectClient(home);
        try {
          await session2.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/check` },
          });
          const postSignalSnapshot = await session2.client.callTool({
            name: "browser_snapshot",
            arguments: { profile: id },
          });
          expect(
            snapshotText(
              postSignalSnapshot as {
                content: Array<{ type: string; text?: string }>;
              },
            ),
          ).toContain(`cookie:1`);
        } finally {
          await session2.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb stop does not return before the browser is closed", () => {
  it(
    "the profile's on-disk cookie store already holds the flushed cookie row immediately after 'anyb stop' returns, without starting another daemon",
    async () => {
      const pageServer = await startPageServer();
      const id = addProfile(home, "cookieflush", "chromium");
      try {
        const session1 = await connectClient(home);
        await session1.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/set` },
        });
        await session1.close();

        const stopResult = await runCliAsync(["stop"], home);
        expect(stopResult.status).toBe(0);

        // No new daemon has been started yet: read the file the product
        // itself wrote. A plain "exists && non-empty" check is NOT a
        // reliable seam here: a spike against this exact Playwright version
        // showed the Cookies SQLite file is pre-allocated to a fixed
        // non-zero size (its empty schema) the moment the browser launches,
        // regardless of whether any cookie was ever flushed into it. So
        // instead this asserts the file's raw bytes contain the cookie's
        // own name, which is only ever written once SQLite flushes an
        // actual cookie row.
        const cookiesFile = findCookiesFile(home, id);
        expect(cookiesFile).not.toBeNull();
        const raw = readFileSync(cookiesFile!, "latin1");
        expect(raw).toContain(COOKIE_NAME);
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb stop with two sessions connected to the same profile", () => {
  it(
    "the daemon exits, both proxies exit, and the cookie survives",
    async () => {
      const pageServer = await startPageServer();
      const id = addProfile(home, "cookietwosessions", "chromium");
      const sessionA = await connectClient(home);
      const sessionB = await connectClient(home);
      try {
        await sessionA.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/set` },
        });
        await sessionB.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/check` },
        });

        const stopResult = await runCliAsync(["stop"], home);
        expect(stopResult.status).toBe(0);

        await waitFor(() => !isPidAlive(sessionA.proxyPid), {
          timeoutMs: 8000,
        });
        await waitFor(() => !isPidAlive(sessionB.proxyPid), {
          timeoutMs: 8000,
        });

        const session2 = await connectClient(home);
        try {
          await session2.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/check` },
          });
          const postStopSnapshot = await session2.client.callTool({
            name: "browser_snapshot",
            arguments: { profile: id },
          });
          expect(
            snapshotText(
              postStopSnapshot as {
                content: Array<{ type: string; text?: string }>;
              },
            ),
          ).toContain(`cookie:1`);
        } finally {
          await session2.close();
        }
      } finally {
        await sessionA.close().catch(() => {});
        await sessionB.close().catch(() => {});
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
