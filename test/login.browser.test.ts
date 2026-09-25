import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  makeHome,
  runCliAsync,
} from "./support.js";

const PAGES: Record<string, string> = {
  "/a": "<title>A</title><h1>Page A</h1>",
};

interface TestPageServer {
  url: string;
  close: () => Promise<void>;
}

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

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeAll(() => {
  // See tools.browser.test.ts: this file spawns real daemons that launch a
  // real Chromium, so it is forced headless for safety at all times here,
  // even though profile_login normally opens a headed window.
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("profile_login MCP tool", () => {
  it(
    "opens the url in a new tab, visible via browser_tabs list from a normal session",
    async () => {
      const pageServer = await startPageServer();
      const id = addProfile(home, "docs", "chromium");
      const { client, close } = await connectClient(home);
      try {
        const loginResult = await client.callTool({
          name: "profile_login",
          arguments: { profile: id, url: `${pageServer.url}/a` },
        });
        expect(loginResult.isError).toBeFalsy();
        expect(textOf(loginResult as never)).toMatch(/log in/i);

        const tabsResult = await client.callTool({
          name: "browser_tabs",
          arguments: { profile: id, action: "list" },
        });
        expect(textOf(tabsResult as never)).toContain("[A]");
      } finally {
        await close();
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile login (CLI)", () => {
  it("opens the url in a new tab through the daemon, same as the MCP tool", async () => {
    const pageServer = await startPageServer();
    const id = addProfile(home, "docs", "chromium");
    try {
      const result = await runCliAsync(
        ["profile", "login", id, `${pageServer.url}/a`],
        home,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/log in/i);

      const { client, close } = await connectClient(home);
      try {
        const tabsResult = await client.callTool({
          name: "browser_tabs",
          arguments: { profile: id, action: "list" },
        });
        expect(textOf(tabsResult as never)).toContain("[A]");
      } finally {
        await close();
      }
    } finally {
      await pageServer.close();
    }
  }, 60000);
});

describe("profile_login against an already-running headless profile without the global override", () => {
  it(
    "returns a clear error telling the agent to restart the profile headed, instead of silently relaunching",
    async () => {
      const id = addProfile(home, "docs", "chromium", { headless: true });

      // First session: no global ANYBROWSER_HEADLESS override, but the
      // profile itself is headless:true, so this real launch stays headless
      // (never a visible window) while producing a "running headless without
      // the override" state to exercise profile_login's refusal.
      const sessionA = await connectClient(home, {
        ANYBROWSER_HEADLESS: undefined,
      });
      try {
        const navResult = await sessionA.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: "about:blank" },
        });
        expect(navResult.isError).toBeFalsy();

        const sessionB = await connectClient(home, {
          ANYBROWSER_HEADLESS: undefined,
        });
        try {
          const loginResult = await sessionB.client.callTool({
            name: "profile_login",
            arguments: { profile: id, url: "about:blank" },
          });
          expect(loginResult.isError).toBe(true);
          expect(textOf(loginResult as never)).toMatch(/headed|restart/i);
        } finally {
          await sessionB.close();
        }
      } finally {
        await sessionA.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
