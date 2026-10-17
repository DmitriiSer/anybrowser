import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  daemonStatusFrom,
  makeHome,
  runCliAsync,
  waitFor,
} from "./support.js";

/**
 * A login must survive the daemon being replaced by the version handshake
 * (docs/DESIGN.md decision 17): the old daemon closes its browser contexts
 * (flushing the cookie store) before it removes its socket, and the new
 * proxy waits for that.
 */

const COOKIE_NAME = "anybhandshakeprobe";
const OLD_ENV = { ANYBROWSER_TEST_VERSION: "0.0.1-old" };
const SPAWN_TIMEOUT = 30000;

async function startPageServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
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
      const hasCookie = (req.headers.cookie ?? "").includes(`${COOKIE_NAME}=1`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<title>Check</title><h1>cookie:${hasCookie ? "1" : "none"}</h1>`,
      );
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

function snapshotText(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

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

describe("a login survives the daemon being replaced by the version handshake", () => {
  it(
    "a persistent cookie set through the old daemon is still sent through the new daemon",
    async () => {
      const pageServer = await startPageServer();
      const id = addProfile(home, "handshake", "chromium");
      try {
        const old = await connectClient(home, OLD_ENV);
        const oldPid = (await daemonStatusFrom(old.client)).pid;
        await old.client.callTool({
          name: "browser_navigate",
          arguments: { profile: id, url: `${pageServer.url}/set` },
        });
        await old.close();
        await waitFor(
          async () => {
            const status = await runCliAsync(["status"], home);
            return (
              status.status === 0 &&
              (JSON.parse(status.stdout.trim()) as { sessions: number })
                .sessions === 0
            );
          },
          { timeoutMs: 8000 },
        );

        const fresh = await connectClient(home);
        try {
          expect((await daemonStatusFrom(fresh.client)).pid).not.toBe(oldPid);
          await fresh.client.callTool({
            name: "browser_navigate",
            arguments: { profile: id, url: `${pageServer.url}/check` },
          });
          const snapshot = await fresh.client.callTool({
            name: "browser_snapshot",
            arguments: { profile: id },
          });
          expect(snapshotText(snapshot)).toContain("cookie:1");
        } finally {
          await fresh.close();
        }
      } finally {
        await pageServer.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
