/**
 * The allowed-sites enforcement point: a small HTTP/CONNECT forward proxy, one
 * loopback listener per running profile, that the profile's browser is
 * launched against (docs: the list is checked by host and port, never by
 * path, because a CONNECT carries no path).
 *
 * - A plain absolute-URI request is http, so its whole URL is checked.
 * - `CONNECT host:port` is checked as `https://host:port/`. WebSockets arrive
 *   as CONNECT too, and `isUrlAllowed` folds `ws`/`wss` to the same checks.
 * - A refusal is shaped by what the browser is loading, because an HTML 403
 *   for an image or a script is swallowed by the browser as a bare
 *   `ERR_BLOCKED_BY_ORB`: `Sec-Fetch-Dest: document` gets an HTML page,
 *   anything else a plain-text 403 a cross-origin page may read. Both carry
 *   `X-Anybrowser-Blocked: 1`. A refused CONNECT is answered `403` and then
 *   closed (never just destroyed: that reads as `ERR_EMPTY_RESPONSE`).
 * - An upstream failure (dial refused, DNS failure) on CONNECT destroys the
 *   socket instead of answering, so an outage can be told from a refusal.
 *
 * There is no proxy credential on purpose: credentials make Chromium disable
 * its HTTP cache. Nothing is buffered; both directions are piped and both
 * sides are destroyed together, because `pipe` does not propagate aborts.
 */
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Duplex } from "node:stream";
import { isUrlAllowed, parseAllowedOrigin } from "./allowedSites.js";

/** One request the proxy refused. The proxy's record decides WHETHER something was blocked. */
export interface Refusal {
  /** `http` for a plain request, `connect` for a tunnel (including WebSockets). */
  kind: "http" | "connect";
  /** The full URL for `http`; `https://host:port/` for `connect` (a tunnel has no path). */
  url: string;
  /** The `Sec-Fetch-Dest` the browser sent; null for a CONNECT, which carries none. */
  destination: string | null;
  /** `Date.now()` when it was refused. */
  at: number;
}

export interface SiteProxyOptions {
  profile: string;
  /** The profile's list right now: null or empty means no restriction. Called for every request. */
  allowedOrigins: () => string[] | null;
  /** Whether `port` on loopback is any anybrowser proxy listener. Those are never dialled. */
  isOwnPort: (port: number) => boolean;
  /** The text shown for a refused URL (HTML-escaped here when it goes in a page). */
  describeBlock: (url: string) => string;
  onRefusal: (refusal: Refusal) => void;
  log: (event: string) => void;
  /** Resolves a name to addresses; only tests replace it. */
  lookup?: (host: string) => Promise<string[]>;
}

interface Tunnel {
  host: string;
  port: number;
  /** `https://host:port/`, the URL the list is asked about. */
  url: string;
  /** The address that was dialled. */
  address: string;
  client: Duplex;
  upstream: Socket;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** How often open tunnels are re-checked against the list when no request prompts a read. */
const REAP_INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 20000;

function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name)) {
      kept[name] = value;
    }
  }
  return kept;
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

/** Whether `address` reaches this machine: loopback, the unspecified address, or an IPv4-mapped form of either. */
function isLocalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped ? (mapped[1] as string) : address;
  if (isIP(plain) === 4) {
    return plain.startsWith("127.") || plain.startsWith("0.");
  }
  return plain === "::1" || plain === "::";
}

/** Whether a host written in a list entry or a URL names this machine. */
function isLoopbackName(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" || bare.endsWith(".localhost") || isLocalAddress(bare)
  );
}

/** Whether some entry that covers `url` itself names a loopback host. */
function loopbackEntryCovers(url: string, entries: string[]): boolean {
  return entries.some((raw) => {
    if (!isUrlAllowed(url, [raw])) {
      return false;
    }
    const parsed = parseAllowedOrigin(raw);
    return parsed.ok && isLoopbackName(parsed.entry.host);
  });
}

async function defaultLookup(host: string): Promise<string[]> {
  const found = await dnsLookup(host, { all: true });
  return found.map((entry) => entry.address);
}

type Verdict =
  | { kind: "allow"; address: string }
  | { kind: "refuse" }
  | { kind: "unreachable" };

export class SiteProxy {
  private readonly tunnels = new Set<Tunnel>();
  private lastListKey: string | undefined;
  private reapTimer: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    private readonly options: SiteProxyOptions,
    private readonly server: Server,
    readonly port: number,
  ) {}

  /** Starts a listener on 127.0.0.1 with a free port. */
  static async start(options: SiteProxyOptions): Promise<SiteProxy> {
    const server = createServer();
    // A long upload or a stream that never ends is normal here.
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const proxy = new SiteProxy(
      options,
      server,
      (server.address() as { port: number }).port,
    );
    server.on("request", (req, res) => {
      proxy.handleRequest(req, res).catch((error: unknown) => {
        options.log(
          `proxy request failed: profile=${options.profile} error=${error instanceof Error ? error.message : String(error)}`,
        );
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
        }
        res.end();
      });
    });
    server.on("connect", (req, socket, head) => {
      proxy.handleConnect(req, socket, head).catch((error: unknown) => {
        options.log(
          `proxy connect failed: profile=${options.profile} error=${error instanceof Error ? error.message : String(error)}`,
        );
        socket.destroy();
      });
    });
    server.on("clientError", (_error, socket) => {
      socket.destroy();
    });
    return proxy;
  }

  /** Stops listening and destroys every open tunnel and connection. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopReapTimer();
    for (const tunnel of [...this.tunnels]) {
      this.destroyTunnel(tunnel);
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** Reads the list. When it differs from the last read, closes tunnels whose host is no longer allowed. */
  private readList(): string[] | null {
    const list = this.options.allowedOrigins();
    const key = JSON.stringify(list);
    if (this.lastListKey !== undefined && key !== this.lastListKey) {
      this.lastListKey = key;
      this.reap(list);
    }
    this.lastListKey = key;
    return list;
  }

  /** The synchronous part of the decision, shared by a new request and by the reaper. */
  private permitted(
    url: string,
    port: number,
    addresses: string[],
    list: string[] | null,
  ): boolean {
    const local = addresses.some(isLocalAddress);
    if (local && this.options.isOwnPort(port)) {
      return false;
    }
    if (!list?.length) {
      return true;
    }
    if (!isUrlAllowed(url, list)) {
      return false;
    }
    return !local || loopbackEntryCovers(url, list);
  }

  private async resolve(host: string): Promise<string[]> {
    const bare = host.replace(/^\[|\]$/g, "");
    if (isIP(bare) !== 0) {
      return [bare];
    }
    const lower = bare.toLowerCase();
    if (lower === "localhost" || lower.endsWith(".localhost")) {
      return ["127.0.0.1"];
    }
    return (this.options.lookup ?? defaultLookup)(bare);
  }

  private async decide(
    url: string,
    host: string,
    port: number,
  ): Promise<Verdict> {
    const list = this.readList();
    // Cheap early refusal: nothing is resolved for an off-list host.
    if (list?.length && !isUrlAllowed(url, list)) {
      return { kind: "refuse" };
    }
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      return { kind: "unreachable" };
    }
    const first = addresses[0];
    if (first === undefined) {
      return { kind: "unreachable" };
    }
    // Re-checked against what the name resolved to, at dial time.
    if (!this.permitted(url, port, addresses, this.readList())) {
      return { kind: "refuse" };
    }
    return { kind: "allow", address: first };
  }

  private refuse(refusal: Omit<Refusal, "at">): void {
    this.options.onRefusal({ ...refusal, at: Date.now() });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("anybrowser site proxy: expected an absolute URL");
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("anybrowser site proxy: only http URLs are proxied");
      return;
    }
    const port = target.port === "" ? 80 : Number(target.port);
    const verdict = await this.decide(target.href, target.hostname, port);
    if (verdict.kind === "refuse") {
      const destination = headerValue(req.headers["sec-fetch-dest"]);
      this.refuse({ kind: "http", url: target.href, destination });
      const message = this.options.describeBlock(target.href);
      const isDocument = destination === "document";
      res.writeHead(403, {
        "content-type": isDocument
          ? "text/html; charset=utf-8"
          : "text/plain; charset=utf-8",
        ...(isDocument ? {} : { "access-control-allow-origin": "*" }),
        "x-anybrowser-blocked": "1",
        "cache-control": "no-store",
        connection: "close",
      });
      res.end(
        isDocument
          ? `<!doctype html><meta charset="utf-8"><title>Blocked</title><p>${escapeHtml(message)}</p>`
          : message,
      );
      return;
    }
    if (verdict.kind === "unreachable") {
      this.badGateway(res);
      return;
    }
    const upstream = request(
      {
        host: verdict.address,
        port,
        method: req.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        headers: withoutHopByHop(req.headers),
        agent: false,
        setHost: false,
      },
      (upstreamResponse) => {
        res.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage ?? "",
          withoutHopByHop(upstreamResponse.headers),
        );
        upstreamResponse.pipe(res);
        upstreamResponse.on("error", () => res.destroy());
        res.on("close", () => upstreamResponse.destroy());
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      this.options.log(
        `proxy upstream failed: profile=${this.options.profile} host=${target.hostname}:${port} code=${error.code ?? error.message}`,
      );
      if (res.headersSent) {
        res.destroy();
      } else {
        this.badGateway(res);
      }
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  private badGateway(res: ServerResponse): void {
    res.writeHead(502, { "content-type": "text/plain", connection: "close" });
    res.end("anybrowser site proxy: the site could not be reached");
  }

  private async handleConnect(
    req: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    client.on("error", () => client.destroy());
    const authority = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!authority) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const host = authority[1] as string;
    const port = Number(authority[2]);
    const url = `https://${host}:${port}/`;
    const verdict = await this.decide(url, host, port);
    if (verdict.kind === "refuse") {
      this.refuse({ kind: "connect", url, destination: null });
      client.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nX-Anybrowser-Blocked: 1\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    if (verdict.kind === "unreachable" || client.destroyed) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: verdict.address, port });
    const tunnel: Tunnel = {
      host: host.replace(/^\[|\]$/g, ""),
      port,
      url,
      address: verdict.address,
      client,
      upstream,
    };
    this.tunnels.add(tunnel);
    this.startReapTimer();
    const drop = () => this.destroyTunnel(tunnel);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, drop);
    upstream.on("error", drop);
    upstream.on("close", drop);
    client.on("close", drop);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      upstream.setNoDelay(true);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  private destroyTunnel(tunnel: Tunnel): void {
    this.tunnels.delete(tunnel);
    tunnel.client.destroy();
    tunnel.upstream.destroy();
    if (this.tunnels.size === 0) {
      this.stopReapTimer();
    }
  }

  /** Destroys every open tunnel the new list no longer allows. The page cannot tell this from a network failure, so each is logged. */
  private reap(list: string[] | null): void {
    for (const tunnel of [...this.tunnels]) {
      if (!this.permitted(tunnel.url, tunnel.port, [tunnel.address], list)) {
        this.options.log(
          `tunnel reaped: profile=${this.options.profile} host=${tunnel.host}:${tunnel.port}`,
        );
        this.destroyTunnel(tunnel);
      }
    }
  }

  private startReapTimer(): void {
    if (this.reapTimer === undefined) {
      this.reapTimer = setInterval(() => this.readList(), REAP_INTERVAL_MS);
      this.reapTimer.unref();
    }
  }

  private stopReapTimer(): void {
    if (this.reapTimer !== undefined) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}
