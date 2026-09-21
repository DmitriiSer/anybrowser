import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupHome, connectClient, logPathFor, makeHome } from "./support.js";

function logContains(home: string, needle: string): boolean {
  try {
    return readFileSync(logPathFor(home), "utf8").includes(needle);
  } catch {
    return false;
  }
}

const PAGES: Record<string, string> = {
  "/a": "<title>A</title><h1>Page A</h1>",
  "/b": "<title>B</title><h1>Page B</h1>",
};

interface TestPageServer {
  url: string;
  close: () => Promise<void>;
}

/** Serves a couple of static pages on 127.0.0.1 with an ephemeral port. Never a real website. */
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

function snapshotText(result: {
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
  // Headless for the whole file: these tests spawn real daemons that launch
  // a real Chromium; CI and local runs must never pop a visible window.
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("browser tools in the tool list", () => {
  it(
    "includes browser_navigate and browser_snapshot, excludes browser_close and browser_install, and every browser tool requires a string 'profile'",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);

        expect(names).toContain("browser_navigate");
        expect(names).toContain("browser_snapshot");
        expect(names).not.toContain("browser_close");
        expect(names).not.toContain("browser_install");

        const browserTools = tools.tools.filter((t) =>
          t.name.startsWith("browser_"),
        );
        expect(browserTools.length).toBeGreaterThan(0);
        for (const tool of browserTools) {
          const schema = tool.inputSchema as {
            required?: string[];
            properties?: Record<string, { type?: string }>;
          };
          expect(schema.required ?? []).toContain("profile");
          expect(schema.properties?.["profile"]?.type).toBe("string");
        }
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("the browser launches lazily", () => {
  it(
    "does not launch on tools/list, but does launch on the first browser tool call",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await client.listTools();
        expect(logContains(home, "browser launch")).toBe(false);

        await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "default-in-chromium", url: "about:blank" },
        });
        expect(logContains(home, "browser launch")).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a browser tool call drives a real page", () => {
  it(
    "navigates and snapshots a locally served page",
    async () => {
      const pageServer = await startPageServer();
      const { client, close } = await connectClient(home);
      try {
        const navResult = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "default-in-chromium",
            url: `${pageServer.url}/a`,
          },
        });
        expect(navResult.isError).toBeFalsy();

        const snapResult = await client.callTool({
          name: "browser_snapshot",
          arguments: { profile: "default-in-chromium" },
        });
        expect(snapResult.isError).toBeFalsy();
        expect(
          snapshotText(
            snapResult as { content: Array<{ type: string; text?: string }> },
          ),
        ).toContain("Page A");
      } finally {
        await close();
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "returns a clear MCP error naming the profile when it names an unknown profile",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await expect(
          client.callTool({
            name: "browser_navigate",
            arguments: { profile: "no-such-profile", url: "about:blank" },
          }),
        ).rejects.toThrow(/no-such-profile/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "errors when the 'profile' argument is missing",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await expect(
          client.callTool({
            name: "browser_navigate",
            arguments: { url: "about:blank" },
          }),
        ).rejects.toThrow(/profile/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("two sessions do not steal each other's tab", () => {
  it(
    "each of two MCP clients through one shared daemon keeps its own current tab",
    async () => {
      const pageServer = await startPageServer();
      const sessionA = await connectClient(home);
      const sessionB = await connectClient(home);
      try {
        await sessionA.client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "default-in-chromium",
            url: `${pageServer.url}/a`,
          },
        });
        await sessionB.client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "default-in-chromium",
            url: `${pageServer.url}/b`,
          },
        });

        const snapA = await sessionA.client.callTool({
          name: "browser_snapshot",
          arguments: { profile: "default-in-chromium" },
        });
        expect(
          snapshotText(
            snapA as { content: Array<{ type: string; text?: string }> },
          ),
        ).toContain("Page A");

        const snapB = await sessionB.client.callTool({
          name: "browser_snapshot",
          arguments: { profile: "default-in-chromium" },
        });
        expect(
          snapshotText(
            snapB as { content: Array<{ type: string; text?: string }> },
          ),
        ).toContain("Page B");
      } finally {
        await sessionA.close();
        await sessionB.close();
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
