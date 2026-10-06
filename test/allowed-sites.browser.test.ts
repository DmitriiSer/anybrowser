import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupHome,
  connectClient,
  logPathFor,
  makeHome,
  runCli,
  runCliAsync,
  waitFor,
} from "./support.js";

const SPAWN_TIMEOUT = 30000;

interface TestSite {
  /** `http://<host>:<port>`. */
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves one static page on this machine only. `host` is the name the
 * browser is told to use: `127.0.0.1` and `localhost` are two different
 * hosts to the browser's origin matching (the host, not the address, is
 * compared) yet both resolve locally, so two servers give one "allowed" site
 * and one "other" site without ever leaving the machine. The server listens
 * on every local interface so either name reaches it.
 */
async function startSite(
  host: string,
  title: string,
  /** Answers a request itself (return true), or leaves it to the default page. */
  custom?: (req: IncomingMessage, res: ServerResponse) => boolean,
): Promise<TestSite> {
  const server: Server = createServer((req, res) => {
    if (custom?.(req, res)) {
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
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

let home: string;
const sites: TestSite[] = [];

beforeAll(() => {
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(() => {
  home = makeHome();
});

afterEach(async () => {
  cleanupHome(home);
  await Promise.all(sites.splice(0).map((site) => site.close()));
});

async function site(
  host: string,
  title: string,
  custom?: (req: IncomingMessage, res: ServerResponse) => boolean,
): Promise<TestSite> {
  const started = await startSite(host, title, custom);
  sites.push(started);
  return started;
}

describe("a profile with an allowed-sites list", () => {
  it(
    "still navigates to a site on the list",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page");
      const add = runCli(
        ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
        home,
      );
      expect(add.status, add.stderr).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: allowed.url },
        });
        expect(result.isError).toBeFalsy();
        expect(textOf(result as never)).toContain("Allowed page");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "refuses a site off the list with a clear result, and stays healthy afterwards",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page");
      const other = await site("localhost", "Other page");
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const blocked = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: other.url },
        });
        const text = textOf(blocked as never);
        expect(blocked.isError).toBe(true);
        expect(text).toContain(other.url);
        expect(text).toMatch(/allowed-sites list/);
        // It names who sets the list without handing the agent a command for it.
        expect(text).toMatch(/outside the agent/);
        expect(text).not.toMatch(/anyb profile|allowedOrigins=/);
        expect(text).not.toContain("Other page");
        expect(daemonLog()).toContain(
          `blocked: profile=pinned-in-chromium url=${other.url}/`,
        );

        // The browser and the daemon are still fine, and the profile still
        // reaches the site on its list.
        const status = await client.callTool({
          name: "profile_status",
          arguments: { profile: "pinned-in-chromium" },
        });
        expect(
          (JSON.parse(textOf(status as never)) as { running: boolean }).running,
        ).toBe(true);
        const again = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: allowed.url },
        });
        expect(again.isError, textOf(again as never)).toBeFalsy();
        expect(textOf(again as never)).toContain("Allowed page");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a profile without an allowed-sites list", () => {
  it(
    "reaches every site, including ones a pinned profile would not",
    async () => {
      const first = await site("127.0.0.1", "First page");
      const second = await site("localhost", "Second page");
      expect(runCli(["profile", "add", "open", "chromium"], home).status).toBe(
        0,
      );

      const { client, close } = await connectClient(home);
      try {
        for (const [target, title] of [
          [first, "First page"],
          [second, "Second page"],
        ] as const) {
          const result = await client.callTool({
            name: "browser_navigate",
            arguments: { profile: "open-in-chromium", url: target.url },
          });
          expect(result.isError, textOf(result as never)).toBeFalsy();
          expect(textOf(result as never)).toContain(title);
        }
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

function daemonLog(): string {
  try {
    return readFileSync(logPathFor(home), "utf8");
  } catch {
    return "";
  }
}

/** The ref of the first link whose name is `name` in the snapshot file a tool result points at. */
function refOfLink(result: unknown, name: string): string {
  const text = textOf(result as never);
  const file = /\[Snapshot\]\(([^)]+)\)/.exec(text)?.[1];
  if (!file) {
    throw new Error(`no snapshot link in: ${text}`);
  }
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.includes(`link "${name}"`));
  const ref = /\[ref=(\w+)\]/.exec(line ?? "")?.[1];
  if (!ref) {
    throw new Error(`no link '${name}' in the snapshot`);
  }
  return ref;
}

describe("redirects from an allowed site", () => {
  it(
    "are refused when they lead off the list, and the refusal is logged",
    async () => {
      const other = await site("localhost", "Other page");
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url !== "/go") {
          return false;
        }
        res.writeHead(302, { location: `${other.url}/landed` });
        res.end();
        return true;
      });
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/go`,
          },
        });
        const text = textOf(result as never);
        expect(result.isError, text).toBe(true);
        expect(text).toContain(`${other.url}/landed`);
        expect(text).not.toContain("Other page");
        expect(daemonLog()).toContain(
          `blocked: profile=pinned-in-chromium url=${other.url}/landed`,
        );
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a redirect chain from an allowed site", () => {
  async function pinnedProfile() {
    expect(
      runCli(
        ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
        home,
      ).status,
    ).toBe(0);
  }

  it(
    "is refused when a later hop leaves the list, and the off-list server is never reached",
    async () => {
      await pinnedProfile();
      let offListHits = 0;
      const other = await site("localhost", "Other page", () => {
        offListHits += 1;
        return false;
      });
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url === "/go") {
          res.writeHead(302, { location: "/mid" });
        } else if (req.url === "/mid") {
          res.writeHead(302, { location: `${other.url}/secret` });
        } else {
          return false;
        }
        res.end();
        return true;
      });

      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/go`,
          },
        });
        const text = textOf(result as never);
        expect(result.isError, text).toBe(true);
        expect(text).toContain(`${other.url}/secret`);
        expect(text).not.toContain("Other page");
        const blockLines = daemonLog()
          .split("\n")
          .filter((line) => line.includes("blocked:"));
        expect(blockLines).toHaveLength(1);
        expect(blockLines[0]).toContain(
          `blocked: profile=pinned-in-chromium url=${other.url}/secret`,
        );
        expect(offListHits).toBe(0);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "still loads when every hop stays on the list",
    async () => {
      await pinnedProfile();
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url === "/go") {
          res.writeHead(302, { location: "/mid" });
          res.end();
        } else if (req.url === "/mid") {
          res.writeHead(301, { location: "/final" });
          res.end();
        } else if (req.url === "/final") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<title>Final page</title><h1>Final page</h1>");
        } else {
          return false;
        }
        return true;
      });

      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/go`,
          },
        });
        const text = textOf(result as never);
        expect(result.isError, text).toBeFalsy();
        expect(text).toContain("Final page");
        expect(daemonLog()).not.toContain("blocked:");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "lands at the final URL, so relative URLs resolve against that",
    async () => {
      await pinnedProfile();
      const seen: string[] = [];
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        seen.push(req.url ?? "");
        if (req.url === "/start/go") {
          res.writeHead(302, { location: "/mid" });
          res.end();
        } else if (req.url === "/mid") {
          res.writeHead(302, { location: "/deep/final" });
          res.end();
        } else if (req.url === "/deep/final") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end('<title>Final</title><img src="pic.png">');
        } else if (req.url?.endsWith("pic.png")) {
          res.writeHead(404);
          res.end();
        } else {
          return false;
        }
        return true;
      });

      const { client, close } = await connectClient(home);
      try {
        const nav = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/start/go`,
          },
        });
        expect(nav.isError, textOf(nav as never)).toBeFalsy();
        const where = await client.callTool({
          name: "browser_evaluate",
          arguments: {
            profile: "pinned-in-chromium",
            function: "() => document.location.href",
          },
        });
        // The browser followed the redirects itself, so it is at /deep/final.
        expect(textOf(where as never)).toContain(`${allowed.url}/deep/final`);
        const deadline = Date.now() + 10000;
        while (!seen.some((u) => u.endsWith("pic.png"))) {
          if (Date.now() > deadline) {
            throw new Error("the image was never requested");
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        // Resolved against /deep/final, not against the URL first requested.
        expect(seen).toContain("/deep/pic.png");
        expect(seen).not.toContain("/start/pic.png");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "keeps a cookie set by a redirect response",
    async () => {
      await pinnedProfile();
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url === "/login") {
          res.writeHead(302, {
            location: "/home",
            "set-cookie": "session=abc123; Path=/",
          });
          res.end();
        } else if (req.url === "/home") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<title>Home</title><h1>Home</h1>");
        } else if (req.url === "/whoami") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<title>Who</title><h1>cookie:${req.headers.cookie}</h1>`);
        } else {
          return false;
        }
        return true;
      });

      const { client, close } = await connectClient(home);
      try {
        const login = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/login`,
          },
        });
        expect(login.isError, textOf(login as never)).toBeFalsy();
        const who = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/whoami`,
          },
        });
        const seen = await client.callTool({
          name: "browser_evaluate",
          arguments: {
            profile: "pinned-in-chromium",
            function: "() => document.body.innerText",
          },
        });
        expect(who.isError, textOf(who as never)).toBeFalsy();
        expect(textOf(seen as never)).toContain("cookie:session=abc123");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  describe("after a form post", () => {
    /** The browser follows these redirects itself now, so this checks the browser's own method and body rules. A page that posts `data=payload` to `/post` on load; `/post` answers `status` and redirects to `/echo`, which reports what reached it. */
    async function postThrough(status: number) {
      await pinnedProfile();
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url === "/form") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            "<form id=f method=post action=/post><input name=data value=payload></form><script>f.submit()</script>",
          );
        } else if (req.url === "/post") {
          res.writeHead(status, { location: "/echo" });
          res.end();
        } else if (req.url === "/echo") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(
              `<title>Echo</title><h1>${req.method} body=[${Buffer.concat(chunks).toString()}]</h1>`,
            );
          });
        } else {
          return false;
        }
        return true;
      });
      const { client, close } = await connectClient(home);
      try {
        await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${allowed.url}/form`,
          },
        });
        const deadline = Date.now() + 15000;
        for (;;) {
          const snap = await client.callTool({
            name: "browser_evaluate",
            arguments: {
              profile: "pinned-in-chromium",
              function: "() => document.body.innerText",
            },
          });
          const text = textOf(snap as never);
          if (/body=\[/.test(text) || Date.now() > deadline) {
            return text;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await close();
      }
    }

    it(
      "a 307 redirect keeps the method and the body",
      async () => {
        expect(await postThrough(307)).toContain("POST body=[data=payload]");
      },
      SPAWN_TIMEOUT,
    );

    it(
      "a 302 redirect turns the request into a GET without the body",
      async () => {
        expect(await postThrough(302)).toContain("GET body=[]");
      },
      SPAWN_TIMEOUT,
    );
  });
});

describe("editing the list while a session is running", () => {
  it(
    "takes effect on the next request, in both directions, without a restart",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page");
      const other = await site("localhost", "Other page");
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);
      const setList = async (value: string) => {
        const result = await runCliAsync(
          ["profile", "set", "pinned-in-chromium", `allowedOrigins=${value}`],
          home,
        );
        expect(result.status, result.stderr).toBe(0);
      };

      const { client, close } = await connectClient(home);
      try {
        const go = (url: string) =>
          client.callTool({
            name: "browser_navigate",
            arguments: { profile: "pinned-in-chromium", url },
          });

        expect((await go(other.url)).isError).toBe(true);

        await setList("127.0.0.1:*,localhost:*");
        const widened = await go(other.url);
        expect(widened.isError, textOf(widened as never)).toBeFalsy();
        expect(textOf(widened as never)).toContain("Other page");

        await setList("127.0.0.1:*");
        expect((await go(other.url)).isError).toBe(true);
        const still = await go(allowed.url);
        expect(still.isError, textOf(still as never)).toBeFalsy();

        await setList("off");
        const opened = await go(other.url);
        expect(opened.isError, textOf(opened as never)).toBeFalsy();
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

/** Hand-edits `allowedOrigins` in the profile's profile.json to any JSON value, as a user with an editor might. */
function writeRawAllowedOrigins(value: unknown): void {
  const file = join(home, "profiles", "pinned-in-chromium", "profile.json");
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  stored["allowedOrigins"] = value;
  writeFileSync(file, JSON.stringify(stored, null, 2));
}

describe("a hand-edited profile.json with a malformed allowed-sites list", () => {
  async function pinnedProfile() {
    expect(
      runCli(
        ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
        home,
      ).status,
    ).toBe(0);
  }

  it.each([
    ["a bare string", "127.0.0.1:1234"],
    ["a list holding a non-string", [5, "127.0.0.1:1234"]],
  ])(
    "ends a request promptly with an error instead of hanging, for %s",
    async (_label, value) => {
      const allowed = await site("127.0.0.1", "Allowed page");
      await pinnedProfile();
      writeRawAllowedOrigins(value);

      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool(
          {
            name: "browser_navigate",
            arguments: { profile: "pinned-in-chromium", url: allowed.url },
          },
          undefined,
          { timeout: 15000 },
        );
        expect(result.isError, textOf(result as never)).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "keeps enforcing the last good list, and logs no handler failure",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page");
      const other = await site("localhost", "Other page");
      await pinnedProfile();

      const { client, close } = await connectClient(home);
      try {
        const go = (url: string) =>
          client.callTool(
            {
              name: "browser_navigate",
              arguments: { profile: "pinned-in-chromium", url },
            },
            undefined,
            { timeout: 15000 },
          );
        expect((await go(allowed.url)).isError).toBeFalsy();

        writeRawAllowedOrigins("127.0.0.1:1234");
        const refused = await go(other.url);
        expect(refused.isError, textOf(refused as never)).toBe(true);
        expect(textOf(refused as never)).toMatch(/allowed-sites list/);
        const still = await go(allowed.url);
        expect(still.isError, textOf(still as never)).toBeFalsy();
        expect(daemonLog()).not.toContain("request handler failed");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("profile_login on a profile with an allowed-sites list", () => {
  async function pinned() {
    const allowed = await site("127.0.0.1", "Allowed page");
    const other = await site("localhost", "Other page");
    expect(
      runCli(
        ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
        home,
      ).status,
    ).toBe(0);
    return { allowed, other };
  }

  async function tabCount(
    client: Awaited<ReturnType<typeof connectClient>>["client"],
  ): Promise<number> {
    const status = await client.callTool({
      name: "profile_status",
      arguments: { profile: "pinned-in-chromium" },
    });
    return (
      (JSON.parse(textOf(status as never)) as { tabCount?: number }).tabCount ??
      0
    );
  }

  it(
    "refuses an off-list URL as a clean result when no browser call came first",
    async () => {
      const { other } = await pinned();
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_login",
          arguments: { profile: "pinned-in-chromium", url: other.url },
        });
        const text = textOf(result as never);
        expect(result.isError, text).toBe(true);
        expect(text).toContain(other.url);
        expect(text).toMatch(/allowed-sites list/);
        expect(text).not.toMatch(/MCP error|ERR_BLOCKED/);
        expect(daemonLog()).toContain(
          `blocked: profile=pinned-in-chromium url=${other.url}/`,
        );
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "refuses an off-list URL as a clean result after a browser call, and opens an allowed one",
    async () => {
      const { allowed, other } = await pinned();
      const { client, close } = await connectClient(home);
      try {
        const nav = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: allowed.url },
        });
        expect(nav.isError, textOf(nav as never)).toBeFalsy();
        const before = await tabCount(client);

        const refused = await client.callTool({
          name: "profile_login",
          arguments: { profile: "pinned-in-chromium", url: other.url },
        });
        const text = textOf(refused as never);
        expect(refused.isError, text).toBe(true);
        expect(text).toMatch(/allowed-sites list/);
        expect(text).not.toMatch(/MCP error|ERR_BLOCKED/);

        const ok = await client.callTool({
          name: "profile_login",
          arguments: { profile: "pinned-in-chromium", url: allowed.url },
        });
        expect(ok.isError, textOf(ok as never)).toBeFalsy();
        expect(await tabCount(client)).toBeGreaterThan(before);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "refuses an allowed URL that redirects off the list, as a clean result, leaving no tab behind",
    async () => {
      const { other } = await pinned();
      const hop = await site("127.0.0.1", "Hop page", (req, res) => {
        if (req.url !== "/out") {
          return false;
        }
        res.writeHead(302, { location: `${other.url}/landed` });
        res.end();
        return true;
      });
      const { client, close } = await connectClient(home);
      try {
        const nav = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: hop.url },
        });
        expect(nav.isError, textOf(nav as never)).toBeFalsy();
        const before = await tabCount(client);

        const refused = await client.callTool({
          name: "profile_login",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${hop.url}/out`,
          },
        });
        const text = textOf(refused as never);
        expect(refused.isError, text).toBe(true);
        expect(text).toContain(`${other.url}/landed`);
        expect(text).not.toMatch(/MCP error|ERR_BLOCKED/);
        expect(await tabCount(client)).toBe(before);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a click that leads off the list", () => {
  it(
    "is reported as a block, not as success",
    async () => {
      const other = await site("localhost", "Other page");
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url !== "/") {
          return false;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<title>Start</title><a href="${other.url}/clicked">leave</a>`);
        return true;
      });
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const nav = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: allowed.url },
        });
        expect(nav.isError, textOf(nav as never)).toBeFalsy();

        const click = await client.callTool({
          name: "browser_click",
          arguments: {
            profile: "pinned-in-chromium",
            element: "leave",
            target: refOfLink(nav, "leave"),
          },
        });
        const text = textOf(click as never);
        expect(click.isError, text).toBe(true);
        expect(text).toContain(`${other.url}/clicked`);
        expect(text).toMatch(/allowed-sites list/);
        expect(text).not.toMatch(/anyb profile set/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "reports a blocked subresource as a note on a result that otherwise succeeds",
    async () => {
      const other = await site("localhost", "Other page");
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url !== "/") {
          return false;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<title>Start</title><h1>Start</h1><img src="${other.url}/pixel.png">`,
        );
        return true;
      });
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const nav = await client.callTool({
          name: "browser_navigate",
          arguments: { profile: "pinned-in-chromium", url: allowed.url },
        });
        const text = textOf(nav as never);
        expect(nav.isError, text).toBeFalsy();
        expect(text).toContain("Start");
        expect(text).toContain(`${other.url}/pixel.png`);
        expect(text).toMatch(/allowed-sites list/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("consecutive blocks", () => {
  it(
    "leave the profile usable: two blocks in a row, then an allowed navigation succeeds, repeatedly",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page");
      const other = await site("localhost", "Other page");
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const go = (url: string) =>
          client.callTool({
            name: "browser_navigate",
            arguments: { profile: "pinned-in-chromium", url },
          });
        // Repeated, because the failure this guards against is a race.
        for (let round = 0; round < 4; round++) {
          for (const path of ["/one", "/two"]) {
            const blocked = await go(`${other.url}${path}`);
            expect(blocked.isError, `${round} ${path}`).toBe(true);
            expect(textOf(blocked as never), `${round} ${path}`).toContain(
              path,
            );
          }
          const again = await go(allowed.url);
          expect(
            again.isError,
            `round ${round}: ${textOf(again as never)}`,
          ).toBeFalsy();
          expect(textOf(again as never)).toContain("Allowed page");
        }
        // Every block landed on its error page; none ran into the deadline.
        expect(daemonLog()).not.toContain("did not settle");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("consecutive refused tunnels", () => {
  it(
    "leave the profile usable too: a refused CONNECT lands on Chromium's error page, and the next navigation must not be interrupted by it",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page");
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const go = (url: string) =>
          client.callTool({
            name: "browser_navigate",
            arguments: { profile: "pinned-in-chromium", url },
          });
        // Nothing listens behind these: the proxy refuses before dialling.
        for (let round = 0; round < 4; round++) {
          for (const path of ["/one", "/two"]) {
            const blocked = await go(`https://localhost:8443${path}`);
            expect(blocked.isError, `${round} ${path}`).toBe(true);
          }
          const again = await go(allowed.url);
          expect(
            again.isError,
            `round ${round}: ${textOf(again as never)}`,
          ).toBeFalsy();
        }
        expect(daemonLog()).not.toContain("did not settle");
        // Every one was a refusal by the proxy, not a network failure.
        expect(
          daemonLog().match(
            /blocked: profile=pinned-in-chromium url=https:\/\/localhost:8443\//g,
          ),
        ).toHaveLength(8);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a click that leads to a refused tunnel", () => {
  it(
    "is settled before the call returns, so an immediate navigation is not interrupted by the error page",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url !== "/start") {
          return false;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<title>Start</title><a href="https://localhost:8443/out">leave</a>',
        );
        return true;
      });
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        for (let round = 0; round < 5; round++) {
          const nav = await client.callTool({
            name: "browser_navigate",
            arguments: {
              profile: "pinned-in-chromium",
              url: `${allowed.url}/start`,
            },
          });
          expect(
            nav.isError,
            `round ${round}: ${textOf(nav as never)}`,
          ).toBeFalsy();
          const click = await client.callTool({
            name: "browser_click",
            arguments: {
              profile: "pinned-in-chromium",
              element: "leave",
              target: refOfLink(nav, "leave"),
            },
          });
          expect(click.isError, `round ${round}`).toBe(true);
          expect(textOf(click as never)).toContain(
            "https://localhost:8443/out",
          );
        }
        expect(daemonLog()).not.toContain("did not settle");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("the audit log", () => {
  it(
    "records one line per block, without the query string where tokens live",
    async () => {
      const other = await site("localhost", "Other page");
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);
      const { client, close } = await connectClient(home);
      try {
        await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: `${other.url}/inbox?token=s3cr3t#frag`,
          },
        });
        const lines = daemonLog()
          .split("\n")
          .filter((line) => line.includes("blocked:"));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(
          `blocked: profile=pinned-in-chromium url=${other.url}/inbox`,
        );
        expect(daemonLog()).not.toContain("s3cr3t");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("what an entry covers", () => {
  function navigate(
    client: Awaited<ReturnType<typeof connectClient>>["client"],
    url: string,
  ) {
    return client.callTool({
      name: "browser_navigate",
      arguments: { profile: "pinned-in-chromium", url },
    });
  }

  it(
    "a bare host covers neither its subdomains nor other ports; a fixed port covers exactly that port",
    async () => {
      const one = await site("localhost", "Port one");
      const two = await site("localhost", "Port two");
      const port = (url: string) => new URL(url).port;
      expect(
        runCli(
          [
            "profile",
            "add",
            "pinned",
            "chromium",
            "--allow",
            `localhost,127.0.0.1:${port(one.url)}`,
          ],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        // No port written: only the default port, so a test server's port is refused.
        expect((await navigate(client, one.url)).isError).toBe(true);
        // A subdomain of a bare host is a different host.
        expect(
          (await navigate(client, `http://app.localhost:${port(one.url)}`))
            .isError,
        ).toBe(true);
        // A fixed port covers that port on that host and no other.
        const exact = await navigate(
          client,
          `http://127.0.0.1:${port(one.url)}`,
        );
        expect(exact.isError, textOf(exact as never)).toBeFalsy();
        expect(
          (await navigate(client, `http://127.0.0.1:${port(two.url)}`)).isError,
        ).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "a wildcard covers subdomains but not the apex",
    async () => {
      // Chromium resolves every *.localhost name to this machine.
      const apex = await site("localhost", "Apex page");
      expect(
        runCli(
          [
            "profile",
            "add",
            "pinned",
            "chromium",
            "--allow",
            "*.a.localhost:*",
          ],
          home,
        ).status,
      ).toBe(0);

      const { client, close } = await connectClient(home);
      try {
        const sub = await navigate(
          client,
          `http://x.a.localhost:${new URL(apex.url).port}`,
        );
        expect(sub.isError, textOf(sub as never)).toBeFalsy();
        expect(textOf(sub as never)).toContain("Apex page");
        expect(
          (
            await navigate(
              client,
              `http://a.localhost:${new URL(apex.url).port}`,
            )
          ).isError,
        ).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("the same refused host again and again", () => {
  const explained = (result: unknown) => {
    const text = textOf(result as never);
    return (
      (result as { isError?: boolean }).isError === true &&
      /allowed-sites list/.test(text) &&
      text.includes("https://localhost:8443/")
    );
  };

  it(
    "explains the refusal every time within one session",
    async () => {
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);
      const { client, close } = await connectClient(home);
      try {
        for (let round = 0; round < 4; round++) {
          const blocked = await client.callTool({
            name: "browser_navigate",
            arguments: {
              profile: "pinned-in-chromium",
              url: "https://localhost:8443/",
            },
          });
          expect(
            explained(blocked),
            `round ${round}: ${textOf(blocked as never)}`,
          ).toBe(true);
        }
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "explains it even when an earlier refusal of that host was never claimed by any event (a blocked WebSocket emits none)",
    async () => {
      const allowed = await site("127.0.0.1", "Allowed page", (req, res) => {
        if (req.url !== "/socket") {
          return false;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          '<title>Socket</title><script>try { new WebSocket("wss://localhost:8443/ws"); } catch (e) {}</script>',
        );
        return true;
      });
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);
      const { client, close } = await connectClient(home);
      try {
        const go = (url: string) =>
          client.callTool({
            name: "browser_navigate",
            arguments: { profile: "pinned-in-chromium", url },
          });
        await go(`${allowed.url}/socket`);
        // The unclaimed refusal exists before the call under test.
        await waitFor(() => /blocked: .*localhost:8443/.test(daemonLog()));
        for (let round = 0; round < 2; round++) {
          const blocked = await go("https://localhost:8443/");
          expect(
            explained(blocked),
            `round ${round}: ${textOf(blocked as never)}`,
          ).toBe(true);
        }
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "explains the refusal in a second session on the same daemon and profile",
    async () => {
      expect(
        runCli(
          ["profile", "add", "pinned", "chromium", "--allow", "127.0.0.1:*"],
          home,
        ).status,
      ).toBe(0);
      for (let session = 0; session < 3; session++) {
        const { client, close } = await connectClient(home);
        try {
          const blocked = await client.callTool({
            name: "browser_navigate",
            arguments: {
              profile: "pinned-in-chromium",
              url: "https://localhost:8443/",
            },
          });
          expect(
            explained(blocked),
            `session ${session}: ${textOf(blocked as never)}`,
          ).toBe(true);
        } finally {
          await close();
        }
      }
    },
    SPAWN_TIMEOUT,
  );
});
