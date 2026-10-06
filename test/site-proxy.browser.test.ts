import { spawnSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupHome,
  connectClient,
  logPathFor,
  makeHome,
  runCli,
  runCliAsync,
  waitFor,
} from "./support.js";

const SPAWN_TIMEOUT = 40000;
const PROFILE = "pinned-in-chromium";

interface TestSite {
  /** `http://<host>:<port>`. */
  url: string;
  port: number;
  /** Connections accepted so far. */
  connections: () => number;
  close: () => Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const open: Array<() => Promise<void>> = [];

/** One local HTTP server; `host` is only the name the browser is told to use. */
async function site(host: string, custom?: Handler): Promise<TestSite> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((req, res) => {
    if (custom?.(req, res)) {
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>${host}</title><h1>${host}</h1>`);
  });
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    });
  open.push(close);
  return {
    url: `http://${host}:${port}`,
    port,
    connections: () => connections,
    close,
  };
}

/**
 * A server that completes WebSocket handshakes, sends one text frame and then
 * stays quiet. `closed` resolves once the server side sees the socket go away.
 */
async function webSocketSite(
  host: string,
): Promise<TestSite & { closed: Promise<void> }> {
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const sockets = new Set<Duplex>();
  let connections = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>${host}</title><h1>${host}</h1>`);
  });
  server.on("upgrade", (req, socket) => {
    connections += 1;
    sockets.add(socket);
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]));
    // Reading is what lets the socket notice the other side going away.
    socket.resume();
    // An HTTP server's sockets are half-open: the peer's FIN is an 'end', not yet a 'close'.
    socket.on("end", () => markClosed());
    socket.on("close", () => markClosed());
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    });
  open.push(close);
  return {
    url: `http://${host}:${port}`,
    port,
    connections: () => connections,
    close,
    closed,
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

beforeAll(() => {
  process.env["ANYBROWSER_HEADLESS"] = "1";
});

beforeEach(() => {
  home = makeHome();
});

afterEach(async () => {
  cleanupHome(home);
  await Promise.all(open.splice(0).map((close) => close()));
});

function daemonLog(): string {
  try {
    return readFileSync(logPathFor(home), "utf8");
  } catch {
    return "";
  }
}

function pin(list: string): void {
  const result = runCli(
    ["profile", "add", "pinned", "chromium", "--allow", list],
    home,
  );
  expect(result.status, result.stderr).toBe(0);
}

async function setList(value: string): Promise<void> {
  const result = await runCliAsync(
    ["profile", "set", PROFILE, `allowedOrigins=${value}`],
    home,
  );
  expect(result.status, result.stderr).toBe(0);
}

type Client = Awaited<ReturnType<typeof connectClient>>["client"];

function navigate(client: Client, url: string) {
  return client.callTool({
    name: "browser_navigate",
    arguments: { profile: PROFILE, url },
  });
}

async function evaluate(client: Client, fn: string): Promise<string> {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: { profile: PROFILE, function: fn },
  });
  return textOf(result as never);
}

describe("a subresource the list refuses", () => {
  it(
    "is visible to the agent as a note naming it, and to the page as a readable 403",
    async () => {
      pin("127.0.0.1:*");
      const other = await site("localhost");
      const allowed = await site("127.0.0.1", (req, res) => {
        if (req.url !== "/") {
          return false;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<title>Start</title><h1>Start</h1><script src="${other.url}/lib.js"></script>` +
            // The same refusal three times is reported once.
            `<script>for (let i = 0; i < 3; i++) fetch('${other.url}/same').catch(() => {});</script>`,
        );
        return true;
      });
      const { client, close } = await connectClient(home);
      try {
        const nav = await navigate(client, allowed.url);
        const text = textOf(nav as never);
        expect(nav.isError, text).toBeFalsy();
        expect(text).toContain(`${other.url}/lib.js`);
        expect(text).toMatch(/allowed-sites list/);
        expect(text.split(`${other.url}/same`)).toHaveLength(2);

        // A page that asks for it with fetch sees a 403 it can read, not a bare network error.
        const seen = await evaluate(
          client,
          `() => fetch('${other.url}/data.json').then(r => r.status + ' ' + r.headers.get('content-type'))`,
        );
        expect(seen).toContain("403 text/plain");
        expect(other.connections()).toBe(0);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a redirect from one allowed site to another", () => {
  it(
    "lands at the final URL, sends no cookie to the second site and leaves the second site its own",
    async () => {
      pin("127.0.0.1:*,localhost:*");
      const seenByB: Array<string | undefined> = [];
      const b = await site("localhost", (req, res) => {
        if (req.url === "/final") {
          seenByB.push(req.headers.cookie);
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<title>B</title><h1>B</h1>");
          return true;
        }
        return false;
      });
      const a = await site("127.0.0.1", (req, res) => {
        if (req.url === "/set") {
          res.writeHead(200, {
            "content-type": "text/html",
            "set-cookie": "who=a; Path=/",
          });
          res.end("<title>A</title>");
        } else if (req.url === "/go") {
          res.writeHead(302, { location: `${b.url}/final` });
          res.end();
        } else {
          return false;
        }
        return true;
      });
      const { client, close } = await connectClient(home);
      try {
        expect((await navigate(client, `${a.url}/set`)).isError).toBeFalsy();
        const nav = await navigate(client, `${a.url}/go`);
        expect(nav.isError, textOf(nav as never)).toBeFalsy();
        expect(
          await evaluate(client, "() => document.location.origin"),
        ).toContain(b.url);
        expect(seenByB).toEqual([undefined]);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("WebSockets on a pinned profile", () => {
  it(
    "connect to an allowed host and are refused to a host off the list",
    async () => {
      pin("127.0.0.1:*");
      const allowedWs = await webSocketSite("127.0.0.1");
      const blockedWs = await webSocketSite("localhost");
      const page = await site("127.0.0.1");
      const { client, close } = await connectClient(home);
      try {
        expect((await navigate(client, page.url)).isError).toBeFalsy();
        const probe = (url: string) =>
          evaluate(
            client,
            `() => new Promise((resolve) => {
              const ws = new WebSocket('${url.replace("http:", "ws:")}');
              ws.onmessage = (e) => resolve('message:' + e.data);
              ws.onerror = () => resolve('error');
              ws.onclose = () => resolve('closed');
            })`,
          );
        expect(await probe(allowedWs.url)).toContain("message:hello");
        expect(await probe(blockedWs.url)).toMatch(/error|closed/);
        expect(blockedWs.connections()).toBe(0);
        expect(daemonLog()).toContain(
          `blocked: profile=${PROFILE} url=https://localhost:${blockedWs.port}/`,
        );
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "an open one to a host that is then taken off the list is closed, and the reap is logged",
    async () => {
      pin("127.0.0.1:*");
      const ws = await webSocketSite("127.0.0.1");
      const { client, close } = await connectClient(home);
      try {
        expect((await navigate(client, ws.url)).isError).toBeFalsy();
        expect(
          await evaluate(
            client,
            `() => new Promise((resolve) => {
              window.__ws = new WebSocket('${ws.url.replace("http:", "ws:")}');
              window.__ws.onmessage = (e) => resolve('message:' + e.data);
              window.__ws.onerror = () => resolve('error');
            })`,
          ),
        ).toContain("message:hello");

        // No request follows the edit: the open tunnel must go on its own.
        await setList("localhost:*");
        await waitFor(
          async () =>
            /### Result\n3\b/.test(
              await evaluate(client, "() => window.__ws.readyState"),
            ),
          { timeoutMs: 15000, intervalMs: 200 },
        );
        await ws.closed;
        expect(daemonLog()).toContain(
          `tunnel reaped: profile=${PROFILE} host=127.0.0.1:${ws.port}`,
        );
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a response that streams", () => {
  it(
    "reaches the page as it is written, on a pinned profile",
    async () => {
      pin("127.0.0.1:*");
      const allowed = await site("127.0.0.1", (req, res) => {
        if (req.url !== "/events") {
          return false;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        // Never ends: a proxy that buffers the response shows the page nothing.
        return true;
      });
      const { client, close } = await connectClient(home);
      try {
        expect((await navigate(client, allowed.url)).isError).toBeFalsy();
        const got = await evaluate(
          client,
          `() => new Promise((resolve) => {
            const es = new EventSource('/events');
            es.onmessage = (e) => { es.close(); resolve('got:' + e.data); };
          })`,
        );
        expect(got).toContain("got:first");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("the browser's HTTP cache on a pinned profile", () => {
  it(
    "serves a cacheable asset again without asking the origin",
    async () => {
      pin("127.0.0.1:*");
      let assetHits = 0;
      const allowed = await site("127.0.0.1", (req, res) => {
        if (req.url === "/asset.js") {
          assetHits += 1;
          res.writeHead(200, {
            "content-type": "text/javascript",
            "cache-control": "max-age=86400",
          });
          res.end("window.assetLoaded = true;");
        } else if (req.url === "/") {
          res.writeHead(200, {
            "content-type": "text/html",
            "cache-control": "no-store",
          });
          res.end('<title>Cache</title><script src="/asset.js"></script>');
        } else {
          return false;
        }
        return true;
      });
      const { client, close } = await connectClient(home);
      try {
        for (let load = 0; load < 4; load++) {
          const nav = await navigate(client, allowed.url);
          expect(nav.isError, textOf(nav as never)).toBeFalsy();
        }
        expect(await evaluate(client, "() => window.assetLoaded")).toContain(
          "true",
        );
        expect(assetHits).toBe(1);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

/** A throwaway self-signed certificate for `localhost`, and the SPKI hash that trusts exactly that key. */
function selfSignedCertificate(dir: string): {
  key: string;
  cert: string;
  spki: string;
} {
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) {
    throw new Error(`openssl failed: ${made.stderr}`);
  }
  const cert = readFileSync(certFile, "utf8");
  const spki = createHash("sha256")
    .update(
      new X509Certificate(cert).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  return { key: readFileSync(keyFile, "utf8"), cert, spki };
}

describe("an HTTPS site", () => {
  it(
    "is refused at CONNECT when off the list (the server is never reached) and tunnelled once listed",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ab-tls-"));
      const tls = selfSignedCertificate(dir);
      let secureConnections = 0;
      const server = createTlsServer(
        { key: tls.key, cert: tls.cert },
        (_req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<title>Secure</title><h1>Secure</h1>");
        },
      );
      server.on("connection", () => {
        secureConnections += 1;
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      open.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      const url = `https://localhost:${(server.address() as AddressInfo).port}`;
      // Trusts this one key and nothing else; only the test sets it.
      process.env["ANYBROWSER_TEST_TRUSTED_SPKI"] = tls.spki;
      pin("127.0.0.1:*");
      const { client, close } = await connectClient(home);
      try {
        const refused = await navigate(client, `${url}/inbox`);
        const text = textOf(refused as never);
        expect(refused.isError, text).toBe(true);
        expect(text).toContain(url);
        expect(text).toMatch(/allowed-sites list/);
        expect(text).not.toMatch(/ERR_TUNNEL|ERR_BLOCKED/);
        expect(secureConnections).toBe(0);
        expect(daemonLog()).toContain(
          `blocked: profile=${PROFILE} url=${url}/`,
        );

        await setList("127.0.0.1:*,localhost:*");
        const ok = await navigate(client, `${url}/inbox`);
        expect(ok.isError, textOf(ok as never)).toBeFalsy();
        expect(textOf(ok as never)).toContain("Secure");
        expect(secureConnections).toBeGreaterThan(0);
      } finally {
        delete process.env["ANYBROWSER_TEST_TRUSTED_SPKI"];
        await close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("two sessions on one profile", () => {
  it(
    "one blocked does not mark the other's successful call as an error",
    async () => {
      pin("127.0.0.1:*");
      const other = await site("localhost");
      const allowed = await site("127.0.0.1");
      const a = await connectClient(home);
      const b = await connectClient(home);
      try {
        // Both sessions need their own tab before the loop races them.
        expect((await navigate(a.client, allowed.url)).isError).toBeFalsy();
        expect((await navigate(b.client, allowed.url)).isError).toBeFalsy();
        for (let round = 0; round < 6; round++) {
          const [blocked, fine] = await Promise.all([
            navigate(a.client, `${other.url}/r${round}`),
            navigate(b.client, `${allowed.url}/r${round}`),
          ]);
          expect(blocked.isError, `round ${round}`).toBe(true);
          expect(textOf(blocked as never)).toContain(`/r${round}`);
          const text = textOf(fine as never);
          expect(fine.isError, `round ${round}: ${text}`).toBeFalsy();
          expect(text).not.toMatch(/allowed-sites list/);
        }
      } finally {
        await a.close();
        await b.close();
      }
    },
    SPAWN_TIMEOUT * 2,
  );
});

describe("the environment's switch for Playwright's loopback handling", () => {
  it(
    "does not let a loopback site past a pinned profile, even when it is set",
    async () => {
      pin("127.0.0.1:*");
      const other = await site("localhost");
      const { client, close } = await connectClient(home, {
        PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1",
      });
      try {
        const refused = await navigate(client, other.url);
        expect(refused.isError, textOf(refused as never)).toBe(true);
        expect(other.connections()).toBe(0);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
