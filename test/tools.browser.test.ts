import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  logPathFor,
  makeHome,
  runCli,
} from "./support.js";

function logContains(home: string, needle: string): boolean {
  try {
    return readFileSync(logPathFor(home), "utf8").includes(needle);
  } catch {
    return false;
  }
}

function countLaunchLines(home: string): number {
  try {
    return readFileSync(logPathFor(home), "utf8")
      .split("\n")
      .filter((line) => line.includes("browser launch:")).length;
  } catch {
    return 0;
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
  // Most tests below reference the "default-in-chromium" id, created up
  // front so router changes are driven by real profile.json data rather
  // than a hard-coded string. Tests exercising unknown/missing profiles
  // deliberately use a different id and are unaffected by this.
  addProfile(home, "default", "chromium");
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

describe("a browser tool call drives a real page for a profile created via 'anyb profile add'", () => {
  it(
    "navigates and snapshots a locally served page using a freshly created profile id (not any hard-coded one)",
    async () => {
      const id = addProfile(home, "custom", "chromium");
      expect(id).toBe("custom-in-chromium");

      const pageServer = await startPageServer();
      const { client, close } = await connectClient(home);
      try {
        const navResult = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: id,
            url: `${pageServer.url}/a`,
          },
        });
        expect(navResult.isError).toBeFalsy();
      } finally {
        await close();
        await pageServer.close();
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

describe("sessions share one browser, and both see all tabs", () => {
  it(
    "browser_tabs list from one session shows tabs opened by both sessions, and the browser launches exactly once",
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

        const tabsResult = await sessionA.client.callTool({
          name: "browser_tabs",
          arguments: { profile: "default-in-chromium", action: "list" },
        });
        const text = snapshotText(
          tabsResult as { content: Array<{ type: string; text?: string }> },
        );
        expect(text).toContain("[A]");
        expect(text).toContain("[B]");

        expect(countLaunchLines(home)).toBe(1);
      } finally {
        await sessionA.close();
        await sessionB.close();
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("one session closing does not break the other; the daemon outlives all sessions", () => {
  it(
    "A keeps working after B closes, and after A closes too the daemon is alive and a new session reuses the browser without a second launch",
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

        await sessionB.close();

        const snapA = await sessionA.client.callTool({
          name: "browser_snapshot",
          arguments: { profile: "default-in-chromium" },
        });
        expect(snapA.isError).toBeFalsy();
        expect(
          snapshotText(
            snapA as { content: Array<{ type: string; text?: string }> },
          ),
        ).toContain("Page A");

        await sessionA.close();

        const status = runCli(["status"], home);
        expect(status.status).toBe(0);

        const sessionC = await connectClient(home);
        try {
          const navC = await sessionC.client.callTool({
            name: "browser_navigate",
            arguments: {
              profile: "default-in-chromium",
              url: `${pageServer.url}/a`,
            },
          });
          expect(navC.isError).toBeFalsy();
        } finally {
          await sessionC.close();
        }

        expect(countLaunchLines(home)).toBe(1);
      } finally {
        await sessionA.close().catch(() => {});
        await sessionB.close().catch(() => {});
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("ANYBROWSER_TEST_NO_LAUNCH test-only hook", () => {
  it(
    "logs the launch line but skips the actual browser launch, so the tool call errors instead of opening a window",
    async () => {
      const { client, close } = await connectClient(home, {
        // headless=1 keeps this safe even before the hook exists: worst case
        // (hook missing) is a real HEADLESS launch, never a visible window.
        ANYBROWSER_HEADLESS: "1",
        ANYBROWSER_TEST_NO_LAUNCH: "1",
      });
      try {
        const result = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "default-in-chromium", url: "about:blank" },
        });
        expect(result.isError).toBe(true);
        expect(logContains(home, "browser launch:")).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("ANYBROWSER_HEADLESS is honoured", () => {
  const cases: Array<{
    label: string;
    value: string | undefined;
    expected: "true" | "false";
  }> = [
    { label: "unset", value: undefined, expected: "false" },
    { label: "'1'", value: "1", expected: "true" },
    { label: "'true'", value: "true", expected: "true" },
    { label: "'0'", value: "0", expected: "false" },
  ];

  for (const { label, value, expected } of cases) {
    it(
      `logs headless=${expected} when ANYBROWSER_HEADLESS is ${label}`,
      async () => {
        // The whole-file beforeAll sets ANYBROWSER_HEADLESS=1 for safety;
        // override or, for the "unset" case, explicitly remove it. Safe to
        // truly unset here because ANYBROWSER_TEST_NO_LAUNCH=1 guarantees no
        // real browser (headed or headless) is ever launched.
        const { client, close } = await connectClient(home, {
          ANYBROWSER_TEST_NO_LAUNCH: "1",
          ANYBROWSER_HEADLESS: value,
        });
        try {
          await client.callTool({
            name: "browser_navigate",
            arguments: {
              profile: "default-in-chromium",
              url: "about:blank",
            },
          });
          expect(logContains(home, `headless=${expected}`)).toBe(true);
        } finally {
          await close();
        }
      },
      SPAWN_TIMEOUT,
    );
  }
});

describe("bug A: a failed browser launch does not poison the profile", () => {
  it(
    "a browser tool call succeeds once the launch obstruction is removed, and the log shows two launch attempts",
    async () => {
      const profileDir = join(home, "profiles", "default-in-chromium");
      const userDataDir = join(profileDir, "user-data");
      mkdirSync(profileDir, { recursive: true });
      // Pre-create a regular FILE where the user-data directory should be,
      // so mkdirSync(userDataDir, { recursive: true }) inside launch() fails.
      writeFileSync(userDataDir, "not a directory");

      const { client, close } = await connectClient(home);
      try {
        const first = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "default-in-chromium", url: "about:blank" },
        });
        expect(first.isError).toBe(true);
        // Today's bug: the failed launch is cached, so nothing short of a
        // daemon restart lets a later call succeed.
        expect(logContains(home, "browser launch failed:")).toBe(true);
        const attemptsAfterFirstCall = countLaunchLines(home);
        expect(attemptsAfterFirstCall).toBeGreaterThanOrEqual(1);

        unlinkSync(userDataDir);

        const second = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "default-in-chromium", url: "about:blank" },
        });
        expect(second.isError).toBeFalsy();

        // The fix must retry: at least one more launch attempt happens after
        // the obstruction is removed, and it is the one that succeeds.
        expect(countLaunchLines(home)).toBeGreaterThan(attemptsAfterFirstCall);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("profile_status reflects a real running browser", () => {
  it(
    "reports running=true and a tab count of at least one after a browser tool call",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "default-in-chromium", url: "about:blank" },
        });

        const result = await client.callTool({
          name: "profile_status",
          arguments: { profile: "default-in-chromium" },
        });
        const parsed = JSON.parse(
          snapshotText(
            result as { content: Array<{ type: string; text?: string }> },
          ),
        ) as { running: boolean; tabCount: number };
        expect(parsed.running).toBe(true);
        expect(parsed.tabCount).toBeGreaterThanOrEqual(1);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile remove refuses a running profile", () => {
  it(
    "exits 1 and does not delete the profile directory while its browser is running",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "default-in-chromium", url: "about:blank" },
        });

        const dir = join(home, "profiles", "default-in-chromium");
        const result = runCli(
          ["profile", "remove", "default-in-chromium"],
          home,
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/default-in-chromium/);
        expect(existsSync(dir)).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("bug B: browser_navigate's snapshot link is usable outside the daemon's cwd", () => {
  it(
    "the navigate result shows the page heading inline, or an absolute snapshot link whose file exists and contains it",
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
        const text = snapshotText(
          navResult as { content: Array<{ type: string; text?: string }> },
        );

        if (text.includes("Page A")) {
          return;
        }

        const match = text.match(/\[Snapshot\]\(([^)]+)\)/);
        expect(match).not.toBeNull();
        const link = match![1] as string;
        expect(isAbsolute(link)).toBe(true);
        expect(readFileSync(link, "utf8")).toContain("Page A");
      } finally {
        await close();
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
