import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  logPathFor,
  makeHome,
  waitFor,
  type ConnectedClient,
} from "./support.js";

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
  expect(result.isError).toBeFalsy();
}

async function tabList(session: ConnectedClient): Promise<string> {
  return textOf(
    await session.client.callTool({
      name: "browser_tabs",
      arguments: { profile: PROFILE, action: "list" },
    }),
  );
}

async function tabCount(session: ConnectedClient): Promise<number> {
  const status = JSON.parse(
    textOf(
      await session.client.callTool({
        name: "profile_status",
        arguments: { profile: PROFILE },
      }),
    ),
  ) as { tabCount: number };
  return status.tabCount;
}

function launchLines(home: string): number {
  return readFileSync(logPathFor(home), "utf8")
    .split("\n")
    .filter((line) => line.includes("browser launch:")).length;
}

let home: string;
let pageServer: TestPageServer;
const open: ConnectedClient[] = [];

async function connect(): Promise<ConnectedClient> {
  const session = await connectClient(home);
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

describe("a session's tabs go with it", () => {
  it(
    "closes the tab a session opened when that session disconnects",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);
      expect(await tabCount(b)).toBe(3);
      expect(await tabList(b)).toContain("Tab A");

      await a.close();

      await waitFor(async () => (await tabCount(b)) === 2);
      const list = await tabList(b);
      expect(list).not.toContain("Tab A");
      expect(list).toContain("Tab B");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "leaves a session that is still connected on its own tab, able to navigate again",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);

      await a.close();
      await waitFor(async () => (await tabCount(b)) === 2);

      const snapshot = textOf(
        await b.client.callTool({
          name: "browser_snapshot",
          arguments: { profile: PROFILE },
        }),
      );
      expect(snapshot).toContain("Page B");
      await navigate(b, `${pageServer.url}/a`);
      expect(await tabList(b)).toContain("(current)");
      expect(await tabCount(b)).toBe(2);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "keeps the browser running after the last session disconnects",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await b.client.callTool({ name: "daemon_status", arguments: {} });

      await a.close();
      await waitFor(async () => (await tabCount(b)) === 1);
      await b.close();

      const c = await connect();
      const status = JSON.parse(
        textOf(
          await c.client.callTool({
            name: "profile_status",
            arguments: { profile: PROFILE },
          }),
        ),
      ) as { running: boolean };
      expect(status.running).toBe(true);
      await navigate(c, `${pageServer.url}/b`);
      expect(launchLines(home)).toBe(1);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "closes the tabs of a session whose proxy process was killed",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);
      expect(await tabCount(b)).toBe(3);

      process.kill(a.proxyPid, "SIGKILL");

      await waitFor(async () => (await tabCount(b)) === 2);
      expect(await tabList(b)).not.toContain("Tab A");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "never closes the context's original first page",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await b.client.callTool({ name: "daemon_status", arguments: {} });
      expect(await tabCount(b)).toBe(2);

      await a.close();

      await waitFor(async () => (await tabCount(b)) === 1);
      expect(await tabCount(b)).toBe(1);
      const c = await connect();
      await navigate(c, `${pageServer.url}/b`);
      const list = await tabList(c);
      expect(list).toContain("about:blank");
      expect(list).toContain("Tab B");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "closes a popup a closing session's page opened, and not another session's popup",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);
      for (const [session, page] of [
        [a, "/a"],
        [b, "/b"],
      ] as const) {
        const opened = await session.client.callTool({
          name: "browser_evaluate",
          arguments: {
            profile: PROFILE,
            function: `() => { window.open("${pageServer.url}${page}?popup", "_blank"); }`,
          },
        });
        expect(opened.isError).toBeFalsy();
      }
      await waitFor(async () => (await tabCount(b)) === 5);

      await a.close();

      await waitFor(async () => (await tabCount(b)) === 3);
      const list = await tabList(b);
      expect(list).not.toContain("Tab A");
      expect(list).toContain("Tab B");
      expect(list).not.toContain("/a?popup");
      expect(list).toContain("/b?popup");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "closes every tab the agent itself opened with browser_tabs new",
    async () => {
      const a = await connect();
      const b = await connect();
      await navigate(a, `${pageServer.url}/a`);
      await navigate(b, `${pageServer.url}/b`);
      await a.client.callTool({
        name: "browser_tabs",
        arguments: { profile: PROFILE, action: "new" },
      });
      await navigate(a, `${pageServer.url}/a?second`);
      expect(await tabCount(b)).toBe(4);

      await a.close();

      await waitFor(async () => (await tabCount(b)) === 2);
      expect(await tabList(b)).not.toContain("Tab A");
    },
    SPAWN_TIMEOUT,
  );
});
