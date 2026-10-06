import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SiteProxy, type Refusal } from "../src/siteProxy.js";
import { waitFor } from "./support.js";

/** Everything here talks to real sockets on loopback; nothing leaves the machine. */

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanup;
  cleanup = [];
  await Promise.all(pending.map((fn) => fn()));
});

interface Harness {
  proxy: SiteProxy;
  refusals: Refusal[];
  logs: string[];
  setList: (list: string[] | null) => void;
}

async function startProxy(
  initial: string[] | null,
  options: { lookup?: (host: string) => Promise<string[]> } = {},
): Promise<Harness> {
  let list = initial;
  const refusals: Refusal[] = [];
  const logs: string[] = [];
  const proxy = await SiteProxy.start({
    profile: "p-in-chromium",
    allowedOrigins: () => list,
    isOwnPort: () => false,
    describeBlock: (url) => `BLOCKED-MESSAGE ${url}`,
    onRefusal: (refusal) => refusals.push(refusal),
    log: (event) => logs.push(event),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
  cleanup.push(() => proxy.close());
  return {
    proxy,
    refusals,
    logs,
    setList: (next) => {
      list = next;
    },
  };
}

async function origin(
  onRequest?: (headers: IncomingHttpHeaders) => void,
): Promise<{ port: number; server: HttpServer }> {
  const server = createHttpServer((req, res) => {
    onRequest?.(req.headers);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "x-origin": "yes" });
      res.end(`${req.method} ${req.url} [${Buffer.concat(chunks).toString()}]`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, server };
}

/** A loopback port nothing listens on right now. */
async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** An echo server: whatever it receives goes straight back. Tracks its live sockets. */
async function echo(
  host = "127.0.0.1",
): Promise<{ port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, sockets };
}

interface ProxiedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** An absolute-URI request to the proxy, as a browser sends it for an http:// URL. */
function viaProxy(
  proxy: SiteProxy,
  url: string,
  options: {
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  } = {},
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: options.method ?? "GET",
        path: url,
        headers: { host: new URL(url).host, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Sends a CONNECT and resolves with every byte the proxy wrote back before it closed or went quiet. */
function connectVia(
  proxy: SiteProxy,
  authority: string,
): Promise<{ socket: Socket; head: () => string; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, "127.0.0.1");
    let received = "";
    let closed = false;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", () => {});
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
      resolve({ socket, head: () => received, closed: () => closed });
    });
    socket.on("error", reject);
  });
}

describe("a plain HTTP request through the proxy", () => {
  it("is forwarded with its method, body and the origin's response, when its URL is on the list", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const site = await origin((h) => seen.push(h));
    const { proxy, refusals } = await startProxy([`127.0.0.1:${site.port}`]);
    const response = await viaProxy(
      proxy,
      `http://127.0.0.1:${site.port}/a?b=1`,
      {
        method: "POST",
        body: "payload",
        headers: { "proxy-connection": "keep-alive" },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers["x-origin"]).toBe("yes");
    expect(response.body).toBe("POST /a?b=1 [payload]");
    // Hop-by-hop headers stop at the proxy.
    expect(seen[0]?.["proxy-connection"]).toBeUndefined();
    expect(refusals).toEqual([]);
  });

  it("is refused with an HTML 403 when the browser is loading a document, and the origin is never asked", async () => {
    const site = await origin();
    const { proxy, refusals } = await startProxy(["example.com"]);
    let reached = false;
    site.server.on("request", () => {
      reached = true;
    });
    const url = `http://127.0.0.1:${site.port}/inbox`;
    const response = await viaProxy(proxy, url, {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(response.status).toBe(403);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.headers["x-anybrowser-blocked"]).toBe("1");
    expect(response.body).toContain(`BLOCKED-MESSAGE ${url}`);
    expect(reached).toBe(false);
    expect(refusals).toEqual([
      expect.objectContaining({ kind: "http", url, destination: "document" }),
    ]);
  });

  it("is refused with a plain-text, cross-origin-readable 403 for anything that is not a document", async () => {
    const site = await origin();
    const { proxy } = await startProxy(["example.com"]);
    for (const dest of ["image", "script", "empty", "iframe"]) {
      const response = await viaProxy(
        proxy,
        `http://127.0.0.1:${site.port}/x`,
        {
          headers: { "sec-fetch-dest": dest },
        },
      );
      expect(response.status, dest).toBe(403);
      expect(response.headers["content-type"], dest).toMatch(/^text\/plain/);
      expect(response.headers["access-control-allow-origin"], dest).toBe("*");
      expect(response.headers["x-anybrowser-blocked"], dest).toBe("1");
    }
  });

  it("answers 502, not a refusal, when the origin cannot be reached", async () => {
    const closed = await origin();
    const port = closed.port;
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    const { proxy, refusals } = await startProxy([`127.0.0.1:${port}`]);
    const response = await viaProxy(proxy, `http://127.0.0.1:${port}/`);
    expect(response.status).toBe(502);
    expect(response.headers["x-anybrowser-blocked"]).toBeUndefined();
    expect(refusals).toEqual([]);
  });

  it("passes everything through when the list is null, except the proxy's own port", async () => {
    const site = await origin();
    const { proxy } = await startProxy(null);
    expect(
      (await viaProxy(proxy, `http://127.0.0.1:${site.port}/`)).status,
    ).toBe(200);
  });
});

describe("a CONNECT through the proxy", () => {
  it("tunnels bytes both ways when host:port is on the list", async () => {
    const server = await echo();
    const { proxy } = await startProxy([`127.0.0.1:${server.port}`]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${server.port}`);
    await waitFor(() => tunnel.head().includes("\r\n\r\n"));
    expect(tunnel.head()).toMatch(/^HTTP\/1\.1 200/);
    tunnel.socket.write("ping");
    await waitFor(() => tunnel.head().endsWith("ping"));
    tunnel.socket.destroy();
  });

  it("is answered 403 with Connection: close, then closed, when host:port is off the list", async () => {
    const server = await echo();
    const { proxy, refusals } = await startProxy(["example.com"]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${server.port}`);
    await waitFor(() => tunnel.closed());
    expect(tunnel.head()).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(tunnel.head().toLowerCase()).toContain("connection: close");
    expect(server.sockets.size).toBe(0);
    expect(refusals).toEqual([
      expect.objectContaining({
        kind: "connect",
        url: `https://127.0.0.1:${server.port}/`,
      }),
    ]);
  });

  it("destroys the socket without any HTTP answer when the upstream cannot be reached", async () => {
    const port = await unusedPort();
    const { proxy, refusals } = await startProxy([`127.0.0.1:${port}`]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${port}`);
    await waitFor(() => tunnel.closed());
    expect(tunnel.head()).toBe("");
    expect(refusals).toEqual([]);
  });

  it("destroys the socket without any HTTP answer when the name does not resolve", async () => {
    const { proxy, refusals } = await startProxy(["gone.example.com:*"], {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    const tunnel = await connectVia(proxy, "gone.example.com:443");
    await waitFor(() => tunnel.closed());
    expect(tunnel.head()).toBe("");
    expect(refusals).toEqual([]);
  });

  it("reaches a bracketed IPv6 literal", async () => {
    let server;
    try {
      server = await echo("::1");
    } catch {
      return; // no IPv6 loopback on this machine
    }
    const { proxy } = await startProxy([`[::1]:${server.port}`]);
    const tunnel = await connectVia(proxy, `[::1]:${server.port}`);
    await waitFor(() => tunnel.head().includes("\r\n\r\n"));
    expect(tunnel.head()).toMatch(/^HTTP\/1\.1 200/);
    tunnel.socket.destroy();
  });

  it("closes a tunnel whose host leaves the list, logs it, and keeps one that is still listed", async () => {
    const keep = await echo();
    const drop = await echo();
    const harness = await startProxy([
      `127.0.0.1:${keep.port}`,
      `127.0.0.1:${drop.port}`,
    ]);
    const kept = await connectVia(harness.proxy, `127.0.0.1:${keep.port}`);
    const dropped = await connectVia(harness.proxy, `127.0.0.1:${drop.port}`);
    await waitFor(
      () =>
        dropped.head().includes("\r\n\r\n") && kept.head().includes("\r\n\r\n"),
    );

    harness.setList([`127.0.0.1:${keep.port}`]);
    await waitFor(() => dropped.closed(), { timeoutMs: 5000 });
    expect(kept.closed()).toBe(false);
    expect(
      harness.logs.some((l) =>
        l.includes(
          `tunnel reaped: profile=p-in-chromium host=127.0.0.1:${drop.port}`,
        ),
      ),
    ).toBe(true);
    kept.socket.destroy();
  });

  it("destroys every open tunnel when the proxy is closed", async () => {
    const server = await echo();
    const { proxy } = await startProxy([`127.0.0.1:${server.port}`]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${server.port}`);
    await waitFor(() => tunnel.head().includes("\r\n\r\n"));
    await proxy.close();
    await waitFor(() => tunnel.closed());
  });
});

describe("what the proxy will not dial", () => {
  it("refuses its own port and any other proxy's, even with no list", async () => {
    const own = await SiteProxy.start({
      profile: "own",
      allowedOrigins: () => null,
      isOwnPort: (port) => port === ownPortRef.port,
      describeBlock: (url) => url,
      onRefusal: () => {},
      log: () => {},
    });
    cleanup.push(() => own.close());
    const ownPortRef = { port: own.port };
    const tunnel = await connectVia(own, `127.0.0.1:${own.port}`);
    await waitFor(() => tunnel.closed());
    expect(tunnel.head()).toMatch(/^HTTP\/1\.1 403/);
  });

  it("refuses a loopback host unless the list names a loopback host", async () => {
    const server = await echo();
    const viaWildcard = await startProxy([`example.com:*`]);
    const tunnel = await connectVia(
      viaWildcard.proxy,
      `127.0.0.1:${server.port}`,
    );
    await waitFor(() => tunnel.closed());
    expect(tunnel.head()).toMatch(/^HTTP\/1\.1 403/);

    const named = await startProxy(["localhost:*"]);
    const ok = await connectVia(named.proxy, `localhost:${server.port}`);
    await waitFor(() => ok.head().includes("\r\n\r\n"));
    expect(ok.head()).toMatch(/^HTTP\/1\.1 200/);
    ok.socket.destroy();
  });

  it("refuses a listed name that resolves to loopback, checked at dial time", async () => {
    const server = await echo();
    const { proxy, refusals } = await startProxy(["rebind.example.com:*"], {
      lookup: async () => ["127.0.0.1"],
    });
    const tunnel = await connectVia(proxy, `rebind.example.com:${server.port}`);
    await waitFor(() => tunnel.closed());
    expect(tunnel.head()).toMatch(/^HTTP\/1\.1 403/);
    expect(server.sockets.size).toBe(0);
    expect(refusals).toHaveLength(1);
  });
});
