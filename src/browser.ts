import { basename, isAbsolute, join, resolve } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { createConnection } from "@playwright/mcp";
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Page,
  type Request,
  type Response,
} from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnybrowserPaths } from "./paths.js";
import { isUrlAllowed } from "./allowedSites.js";
import { BlockLedger, type BlockAttribution } from "./blockLedger.js";
import {
  allowedOriginsProblem,
  profileExists,
  profileJsonPath,
  readProfile,
} from "./profile.js";
import { escapeHtml, SiteProxy } from "./siteProxy.js";

/**
 * A reserved key used only to fetch the upstream tool schema (never a real
 * profile id: real ids always contain "-in-", which this key does not, so it
 * can never collide with one). Listing tools never touches the router's
 * `contextGetter`, so this never launches a browser or requires any profile
 * to exist.
 */
const TOOLS_SCHEMA_KEY = "__anybrowser_tools_schema__";

/**
 * Tools the daemon removes from upstream's list: the daemon owns browser
 * lifetime (decision 14), so `browser_close` is dropped (and would refuse
 * anyway under `sharedBrowserContext: true`), and `browser_install` is
 * dropped because the launcher handles downloads itself.
 */
const REMOVED_TOOLS = new Set(["browser_close", "browser_install"]);

const PROFILE_PROPERTY = {
  type: "string",
  description: "The anybrowser profile to run this tool against.",
} as const;

/** Reads whether the browser should launch headless. Unset/anything else means headed. */
export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["ANYBROWSER_HEADLESS"];
  return raw === "1" || raw === "true";
}

/** Adds a required string `profile` property to a plain-JSON-Schema tool input schema. */
function addProfileProperty(tool: Tool): Tool {
  const schema = tool.inputSchema as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
  const properties = {
    ...(schema.properties ?? {}),
    profile: PROFILE_PROPERTY,
  };
  const required = [...(schema.required ?? []), "profile"];
  return {
    ...tool,
    inputSchema: {
      ...schema,
      type: "object",
      properties,
      required,
    },
  };
}

/** Matches a "[Snapshot](path)" markdown link, as written by upstream's Response.serialize(). */
const SNAPSHOT_LINK_PATTERN = /\[Snapshot\]\(([^)]+)\)/g;

/**
 * Upstream (`@playwright/mcp` 0.0.81) always writes a snapshot produced by
 * `browser_navigate` and friends (any tool using `response.setIncludeSnapshot()`,
 * as opposed to the dedicated `browser_snapshot` tool) to a FILE and returns
 * a markdown link, never inline: `Response._includeSnapshot` is `"full"`
 * there (never `"explicit"`), so `Response._build()`'s `snapshotToFile` is
 * always true and there is no config knob (`snapshot.mode` is only
 * `"full" | "none"`) that keeps it inline. That link is written relative to
 * `Response._clientWorkspace`, which defaults to `context.options.cwd` -
 * `firstRootPath(clientRoots)` in upstream's `initializeServer`, i.e.
 * `process.cwd()` when the MCP client declares no `roots` capability, which
 * our embedded client (below) does not. So the link is always relative to
 * the DAEMON's cwd, not the outputDir the file actually lives in, and
 * `path.relative` never produces an absolute result on POSIX - there is no
 * config that fixes this for the general (non-`browser_snapshot`) tool path.
 * Cheapest correct fix: resolve the relative link (same `process.cwd()` base
 * upstream used) to an absolute path before it reaches the agent host.
 */
function absolutizeSnapshotLinks(content: unknown[]): unknown[] {
  return content.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return item;
    }
    const text = (item as { text: string }).text;
    const rewritten = text.replace(
      SNAPSHOT_LINK_PATTERN,
      (match, link: string) =>
        isAbsolute(link)
          ? match
          : `[Snapshot](${resolve(process.cwd(), link)})`,
    );
    return rewritten === text ? item : { ...item, text: rewritten };
  });
}

/** How long a refused navigation is given to land on Chromium's error page before the caller moves on. */
const BLOCKED_NAVIGATION_SETTLE_MS = 2000;

/** How long a tool call waits for Playwright's events to say which request the proxy just refused. */
const CLAIM_WAIT_MS = 1000;

/** The longest a cached allowed-sites list is trusted without re-reading profile.json. */
const ALLOWED_CACHE_MAX_AGE_MS = 1000;

/** The message for an agent whose request was refused. It never says how to change the list. */
function blockedMessage(
  profile: string,
  allowedOrigins: string[],
  url: string,
): string {
  return (
    `Blocked: ${url} is not allowed. ` +
    `Profile '${profile}' is restricted to an allowed-sites list (${allowedOrigins.join(", ")}). ` +
    `The user sets that list outside the agent; do not try to change it or get around it. ` +
    `If this site is needed, tell the user.`
  );
}

/** The most hosts a subresource note names before it counts the rest. */
const MAX_NOTED_HOSTS = 5;

/**
 * The note for a page that loaded while requests it made were refused. It
 * names distinct hosts (with the port when it is not the scheme's default,
 * since the list needs it written out), sorted so the text is stable, and
 * never says how to change the list.
 */
function incompletePageMessage(
  profile: string,
  allowedOrigins: string[],
  urls: string[],
): string {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // Not a URL; there is no host to name.
    }
  }
  const sorted = [...hosts].sort();
  const shown = sorted.slice(0, MAX_NOTED_HOSTS).join(", ");
  const named =
    sorted.length > MAX_NOTED_HOSTS
      ? `${shown} and ${sorted.length - MAX_NOTED_HOSTS} more`
      : shown;
  return (
    `The page loaded but may be incomplete: requests it made to ${named} were refused. ` +
    `Profile '${profile}' is restricted to an allowed-sites list (${allowedOrigins.join(", ")}), and these hosts would need to be on it. ` +
    `Only the user can change that list; do not try to change it or get around it. ` +
    `If the page needs them, tell the user.`
  );
}

/** `url` without its query and fragment, for the log: those are where tokens live. */
function loggableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin === "null" ? parsed.protocol : parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/** Whether `page` was opened, directly or through other pages, by `ancestor` (a popup of it). */
async function openedBy(page: Page, ancestor: Page): Promise<boolean> {
  let current: Page = page;
  for (let depth = 0; depth < 5; depth++) {
    const opener = await current.opener().catch(() => null);
    if (opener === null) {
      return false;
    }
    if (opener === ancestor) {
      return true;
    }
    current = opener;
  }
  return false;
}

/** Up to five distinct URLs, then a count of the rest, for one message. */
function describeUrls(blocks: BlockAttribution[]): string {
  const urls = [...new Set(blocks.map((b) => b.url))];
  const shown = urls.slice(0, 5).join(", ");
  return urls.length > 5 ? `${shown} and ${urls.length - 5} more` : shown;
}

/**
 * Owns the one persistent Chromium context per profile, launched lazily on
 * the first browser tool CALL (never on daemon start, never on a bare
 * `tools/list`). A per-profile "launching" promise makes concurrent first
 * calls share one launch instead of racing (decision 10).
 */
/** Thrown by `BrowserContextRouter.loginLaunch` when a profile is already running headless without the global override. */
export class ProfileHeadlessRunningError extends Error {}

/** Thrown by `BrowserContextRouter.loginLaunch` when the allowed-sites list refuses the URL; the message is safe to show the agent. */
export class ProfileUrlBlockedError extends Error {}

/** Per-context close timeout shared by `closeAll` and a single profile's idle-close. */
const PER_CONTEXT_CLOSE_TIMEOUT_MS = 3000;

export class BrowserContextRouter {
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profiles whose launch has SUCCEEDED (a resolved context), for profile_status/profile_list/daemon_status. */
  private readonly runningContexts = new Map<string, BrowserContext>();
  /** Whether each running profile's browser is headless, for profile_login's headless-relaunch guard. */
  private readonly runningHeadless = new Map<string, boolean>();
  /** Per-profile "browser idle close" timer (decision 5), armed by `endActivity`. */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** Timestamp the last tool call naming each running profile FINISHED, for `idleForMs`. */
  private readonly lastActivity = new Map<string, number>();
  /**
   * Count of in-flight tool calls naming each profile. While this is above
   * zero the idle-close timer is held off entirely, so a single slow call
   * (e.g. a slow page load) can never be mistaken for idleness and close
   * the browser out from under it - only cleared, silent time between calls
   * counts towards the idle window.
   */
  private readonly activeCalls = new Map<string, number>();
  /**
   * Bumped every time a profile's context is closed (idle-close or
   * `closeAll`), so a `BrowserSession`'s cached embedded MCP connection for
   * that profile (which is keyed on this generation) is dropped and
   * recreated on the next call instead of reusing a connection bound to a
   * now-closed context.
   */
  private readonly generations = new Map<string, number>();
  /** The last allowed-sites list read for each profile, used if profile.json is unreadable mid-edit. */
  private readonly lastKnownAllowed = new Map<string, string[] | null>();
  /** The profile.json stamp and result of the last list read, so a request does not re-parse the file. */
  private readonly allowedCache = new Map<
    string,
    { stamp: string; list: string[] | null; at: number }
  >();
  /** The running profile's proxy listener (see src/siteProxy.ts). Every profile has one, pinned or not. */
  private readonly proxies = new Map<string, SiteProxy>();
  /**
   * Every listener port ever opened, kept for the daemon's life: a proxy
   * never dials another proxy, whichever profile it belongs to.
   */
  private readonly proxyPorts = new Set<number>();
  /** Listeners whose browser may still be alive (its close failed or timed out), kept so the port is never reused under it. */
  private readonly retiredProxies: SiteProxy[] = [];
  /** What each profile's proxy refused, claimed by Playwright events (see src/blockLedger.ts). */
  private readonly ledgers = new Map<string, BlockLedger>();
  /** Each running profile's first page, which no session owns and none may close. */
  private readonly firstPages = new Map<string, Page>();
  /** When each frame last committed a navigation, so a refused navigation can tell it has been replaced. */
  private readonly commitTimes = new WeakMap<Frame, number>();

  constructor(
    readonly paths: AnybrowserPaths,
    private readonly log: (event: string) => void,
    /** Resolved once at daemon startup (src/idle.ts); null disables per-profile idle close. */
    private readonly idleMs: number | null,
  ) {}

  /** Current generation number for `profile` (see `generations` above). Defaults to 0. */
  generationOf(profile: string): number {
    return this.generations.get(profile) ?? 0;
  }

  private bumpGeneration(profile: string): void {
    this.generations.set(profile, this.generationOf(profile) + 1);
  }

  /** Milliseconds since the last tool call naming `profile`, or undefined if it isn't running. */
  idleForMs(profile: string): number | undefined {
    const last = this.lastActivity.get(profile);
    return last === undefined ? undefined : Date.now() - last;
  }

  private clearIdleTimer(profile: string): void {
    const timer = this.idleTimers.get(profile);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(profile);
    }
  }

  /** (Re-)arms the idle-close timer for `profile`, cancelling any previous one. A no-op when idling is disabled. */
  private armIdleTimer(profile: string): void {
    this.clearIdleTimer(profile);
    if (this.idleMs === null) {
      return;
    }
    const timer = setTimeout(() => {
      void this.closeIdleProfile(profile);
    }, this.idleMs);
    this.idleTimers.set(profile, timer);
  }

  /**
   * Marks the start of one tool call naming `profile`: holds off the
   * idle-close timer until every in-flight call for this profile has
   * finished (see `activeCalls`'s doc comment). Call on every browser tool
   * call and on `profile_login`, paired with `endActivity`.
   */
  beginActivity(profile: string): void {
    this.clearIdleTimer(profile);
    this.activeCalls.set(profile, (this.activeCalls.get(profile) ?? 0) + 1);
  }

  /**
   * Marks the end of one tool call naming `profile`. Once the last
   * concurrent call for this profile finishes, records the current time as
   * its last activity and (re)arms the idle-close timer counting forward
   * from now - never from before the call started.
   */
  endActivity(profile: string): void {
    const remaining = Math.max(0, (this.activeCalls.get(profile) ?? 1) - 1);
    if (remaining > 0) {
      this.activeCalls.set(profile, remaining);
      return;
    }
    this.activeCalls.delete(profile);
    this.lastActivity.set(profile, Date.now());
    this.armIdleTimer(profile);
  }

  /**
   * Closes one profile's browser because it has been idle for `idleMs` with
   * no tool call naming it (decision 5), reusing the same graceful close
   * path as `closeAll` (so the cookie store is flushed - a profile that is
   * idle-closed must keep its logins). The profile relaunches lazily on its
   * next tool call, exactly like a profile that has never been launched.
   *
   * Evicts the profile from the launch cache BEFORE awaiting the close, so
   * a tool call racing this idle-close triggers a fresh launch rather than
   * reusing a context that is mid-close.
   */
  private async closeIdleProfile(profile: string): Promise<void> {
    const context = this.runningContexts.get(profile);
    if (!context) {
      return; // already closed by other means (e.g. daemon shutdown)
    }
    this.clearIdleTimer(profile);
    this.lastActivity.delete(profile);
    this.activeCalls.delete(profile);
    this.contexts.delete(profile);
    this.runningContexts.delete(profile);
    this.runningHeadless.delete(profile);
    this.bumpGeneration(profile);
    const proxy = this.proxies.get(profile);
    this.proxies.delete(profile);
    const closed = await this.closeOneContext(
      profile,
      context,
      PER_CONTEXT_CLOSE_TIMEOUT_MS,
    );
    await this.releaseProxy(profile, proxy, closed);
  }

  /**
   * Closes a profile's listener, but only once its browser is known to be
   * gone: a port released while a browser launched against it may still live
   * could be bound by a different listener later, and the live browser would
   * use that one with no relaunch. An uncertain close keeps the listener.
   */
  private async releaseProxy(
    profile: string,
    proxy: SiteProxy | undefined,
    browserClosed: boolean,
  ): Promise<void> {
    if (!proxy) {
      return;
    }
    if (browserClosed) {
      await proxy.close();
    } else {
      this.retiredProxies.push(proxy);
      this.log(
        `proxy kept: profile=${profile} port=${proxy.port} reason=browser close not confirmed`,
      );
    }
  }

  /**
   * Closes one browser context, bounded by `timeoutMs`, logging exactly one
   * of `browser close: profile=...`, `browser close timed out: profile=...`
   * or `browser close failed: profile=... error=...`. Shared by `closeAll`
   * and `closeIdleProfile` so both reuse the identical graceful-close
   * behaviour (decision 2: a profile must keep its logins across either
   * path).
   */
  private async closeOneContext(
    profile: string,
    context: BrowserContext,
    timeoutMs: number,
  ): Promise<boolean> {
    let timedOut = false;
    let closed = false;
    const closePromise = context.close();
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs).unref();
    });
    try {
      await Promise.race([closePromise, timer]);
      if (timedOut) {
        this.log(`browser close timed out: profile=${profile}`);
      } else {
        closed = true;
        this.log(`browser close: profile=${profile}`);
      }
    } catch (error) {
      this.log(
        `browser close failed: profile=${profile} error=${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // In the timeout case closePromise is still pending: attach a no-op
      // catch so a late rejection never surfaces as an unhandled rejection.
      closePromise.catch(() => {});
    }
    return closed;
  }

  /**
   * Returns the shared persistent context for `profile`, launching it on
   * first use. A launch that fails is logged and evicted from the cache
   * (instead of being cached forever), so the next call retries rather than
   * replaying the same error until the daemon restarts.
   *
   * `headlessOverride`, when given, is used INSTEAD of the profile's own
   * `headless` flag for a first launch (used by `loginLaunch`, decision 12:
   * a human must see the login window). Ignored once the profile is already
   * running.
   */
  getContext(
    profile: string,
    headlessOverride?: boolean,
  ): Promise<BrowserContext> {
    let launching = this.contexts.get(profile);
    if (!launching) {
      launching = this.launch(profile, headlessOverride)
        .then((context) => {
          this.runningContexts.set(profile, context);
          return context;
        })
        .catch((error: unknown) => {
          this.contexts.delete(profile);
          this.log(
            `browser launch failed: profile=${profile} error=${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        });
      this.contexts.set(profile, launching);
    }
    return launching;
  }

  private ledgerFor(profile: string): BlockLedger {
    let ledger = this.ledgers.get(profile);
    if (!ledger) {
      ledger = new BlockLedger();
      this.ledgers.set(profile, ledger);
    }
    return ledger;
  }

  /** A cursor for `blocksSince`: everything refused for `profile` after this call is "new". */
  blockMark(profile: string): number {
    return this.ledgerFor(profile).mark();
  }

  /**
   * What `profile`'s proxy refused after `mark` and a Playwright event has
   * attributed to a URL and a page, one per refusal (a caller dedupes by URL for display). Waits a moment for
   * events that trail the refusal; a refusal no event ever claims (a blocked
   * WebSocket, say) is in the log but cannot be attributed, so it is left out.
   */
  async blocksSince(
    profile: string,
    mark: number,
  ): Promise<Array<BlockAttribution & { seq: number }>> {
    const ledger = this.ledgerFor(profile);
    await ledger.whenClaimed(mark, CLAIM_WAIT_MS);
    const blocks: Array<BlockAttribution & { seq: number }> = [];
    for (const entry of ledger.since(mark)) {
      if (entry.claim) {
        blocks.push({ ...entry.claim, seq: entry.seq });
      }
    }
    return blocks;
  }

  /**
   * The profile's allowed-sites list as stored right now (null or empty: no
   * restriction). Every request the browser makes asks, so the answer is
   * cached against profile.json's modification stamp (and re-read at least
   * once a second): an edit still takes effect on the next request. While
   * profile.json is unreadable (a write in progress), the last list read
   * stays in force rather than the profile briefly becoming open.
   */
  currentAllowedOrigins(profile: string): string[] | null {
    let stamp = "";
    try {
      const stat = statSync(profileJsonPath(this.paths, profile));
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Unreadable below as well; the last good list stays.
    }
    const now = Date.now();
    const cached = this.allowedCache.get(profile);
    if (
      cached &&
      stamp !== "" &&
      cached.stamp === stamp &&
      now - cached.at < ALLOWED_CACHE_MAX_AGE_MS
    ) {
      return cached.list;
    }
    const stored = readProfile(this.paths, profile);
    if (stored) {
      this.lastKnownAllowed.set(profile, stored.allowedOrigins);
      this.allowedCache.set(profile, {
        stamp,
        list: stored.allowedOrigins,
        at: now,
      });
      return stored.allowedOrigins;
    }
    return this.lastKnownAllowed.get(profile) ?? null;
  }

  /**
   * A refusal message for a `browser_navigate` URL whose scheme never crosses
   * the proxy (`file:`, `javascript:`, ...), or null when the proxy is the
   * right judge of it. Only a pinned profile refuses; `http` and `https` are
   * always left to the proxy.
   */
  refuseNonNetworkUrl(profile: string, url: string): string | null {
    const list = this.currentAllowedOrigins(profile);
    if (!list?.length) {
      return null;
    }
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return null; // The browser decides what an unparseable URL means.
    }
    if (protocol === "http:" || protocol === "https:") {
      return null;
    }
    if (isUrlAllowed(url, list)) {
      return null;
    }
    this.log(`blocked: profile=${profile} url=${loggableUrl(url)}`);
    return blockedMessage(profile, list, url);
  }

  /** Context-level events: they see popups and service-worker requests that no page event does. */
  private watchBlocks(profile: string, context: BrowserContext): void {
    const ledger = this.ledgerFor(profile);
    const attribute =
      (request: Request) =>
      (refusedAt: number): BlockAttribution => {
        let frame: Frame | null = null;
        let page: Page | null = null;
        let navigation = false;
        try {
          frame = request.frame();
          page = frame.page();
          navigation =
            request.isNavigationRequest() && frame.parentFrame() === null;
        } catch {
          // A request with no frame (e.g. a service worker's).
        }
        if (page === null) {
          this.log(
            `blocked request not attributed to a page: profile=${profile} url=${loggableUrl(request.url())}`,
          );
        }
        return {
          url: request.url(),
          navigation,
          page,
          frame,
          ...(navigation && frame
            ? {
                settled: this.whenReplaced(
                  profile,
                  frame,
                  refusedAt,
                  request.url(),
                ),
              }
            : {}),
        };
      };
    context.on("requestfailed", (request: Request) => {
      ledger.claimConnect(request.url(), attribute(request));
    });
    context.on("response", (response: Response) => {
      if (response.headers()["x-anybrowser-blocked"] === "1") {
        ledger.claimHttp(response.url(), attribute(response.request()));
      }
    });
    const track = (page: Page) => {
      page.on("framenavigated", (frame) => {
        this.commitTimes.set(frame, Date.now());
      });
    };
    context.pages().forEach(track);
    context.on("page", track);
  }

  /**
   * After a top-level navigation is refused, the tab commits something in
   * its place (Chromium's own error page, or our block page) a moment later,
   * and a navigation issued before that lands fails with "interrupted by
   * another navigation". Resolves when THIS frame has committed after the
   * refusal (so one already showing from an earlier block cannot satisfy it),
   * when the page goes away, or after a deadline, which it logs.
   */
  private whenReplaced(
    profile: string,
    frame: Frame,
    refusedAt: number,
    url: string,
  ): Promise<void> {
    if ((this.commitTimes.get(frame) ?? 0) >= refusedAt) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const page = frame.page();
      const done = () => {
        clearTimeout(timer);
        page.off("framenavigated", onNavigated);
        page.off("close", done);
        resolve();
      };
      const onNavigated = (navigated: Frame) => {
        if (navigated === frame) {
          done();
        }
      };
      const timer = setTimeout(() => {
        this.log(
          `blocked navigation did not settle: profile=${profile} url=${loggableUrl(url)} waited=${BLOCKED_NAVIGATION_SETTLE_MS}ms`,
        );
        done();
      }, BLOCKED_NAVIGATION_SETTLE_MS);
      page.on("framenavigated", onNavigated);
      page.on("close", done);
    });
  }

  /**
   * Moves a tab that a refused navigation left on an error page to
   * about:blank (which cannot retry), and writes `message` into it so the
   * person watching the window can see what was refused.
   */
  async parkRefusedTab(
    profile: string,
    page: Page | null,
    message: string,
  ): Promise<void> {
    if (page === null || page.isClosed()) {
      return;
    }
    try {
      await page.goto("about:blank");
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><title>Blocked</title><p>${escapeHtml(message)}</p>`,
      );
    } catch (error) {
      this.log(
        `could not park refused tab: profile=${profile} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Ids of profiles with a currently running (successfully launched) browser, sorted. */
  runningProfileIds(): string[] {
    return [...this.runningContexts.keys()].sort();
  }

  /** The running context for `profile`, or undefined if it isn't currently running. */
  runningContext(profile: string): BrowserContext | undefined {
    return this.runningContexts.get(profile);
  }

  /**
   * Closes every open browser context so each one flushes its cookie store
   * (and the rest of its profile state) to disk before the daemon exits: the
   * whole point of anybrowser is that a profile stays logged in
   * (docs/DESIGN.md decision 2), and an abrupt `process.exit()` without this
   * kills Chromium before it ever writes the cookie it just set.
   *
   * Awaits every close, bounded by a few seconds per context and an overall
   * cap of about 10 seconds, so a single hung browser can never stop the
   * daemon from exiting: a timed-out or errored close is logged and skipped
   * rather than retried or rethrown.
   */
  async closeAll(): Promise<void> {
    const entries = [...this.runningContexts.entries()];
    const OVERALL_CAP_MS = 10000;
    const overallDeadline = Date.now() + OVERALL_CAP_MS;

    for (const profile of this.idleTimers.keys()) {
      this.clearIdleTimer(profile);
    }

    await Promise.all(
      entries.map(async ([profile, context]) => {
        const timeoutMs = Math.max(
          0,
          Math.min(PER_CONTEXT_CLOSE_TIMEOUT_MS, overallDeadline - Date.now()),
        );
        this.bumpGeneration(profile);
        const proxy = this.proxies.get(profile);
        this.proxies.delete(profile);
        const closed = await this.closeOneContext(profile, context, timeoutMs);
        await this.releaseProxy(profile, proxy, closed);
      }),
    );

    this.contexts.clear();
    this.runningContexts.clear();
    this.runningHeadless.clear();
    this.lastActivity.clear();
  }

  /**
   * Launches `profile` HEADED (unless the global ANYBROWSER_HEADLESS
   * override is set) if it isn't already running, opens `url` in a new tab
   * and brings it to front (decision 12). If the profile is already running
   * headless without the global override, throws
   * `ProfileHeadlessRunningError` rather than silently relaunching under a
   * live session (out of scope for this slice).
   */
  async loginLaunch(profile: string, url: string): Promise<void> {
    const alreadyRunning = this.runningContexts.get(profile);
    let context: BrowserContext;
    if (alreadyRunning) {
      const headless = this.runningHeadless.get(profile) ?? false;
      if (headless && !isHeadless()) {
        throw new ProfileHeadlessRunningError(
          `profile '${profile}' is already running headless; restart it headed first (e.g. 'anyb stop') before logging in`,
        );
      }
      context = alreadyRunning;
    } else {
      context = await this.getContext(profile, isHeadless());
    }
    const allowedOrigins = this.currentAllowedOrigins(profile);
    if (allowedOrigins?.length && !isUrlAllowed(url, allowedOrigins)) {
      this.log(`blocked: profile=${profile} url=${loggableUrl(url)}`);
      throw new ProfileUrlBlockedError(
        blockedMessage(profile, allowedOrigins, url),
      );
    }
    this.beginActivity(profile);
    try {
      const mark = this.blockMark(profile);
      const page = await context.newPage();
      let failure: unknown;
      try {
        await page.goto(url);
      } catch (error) {
        failure = error;
      }
      // The proxy's refusal decides whether this was a block; what the page
      // went through (a redirect off the list, a refused tunnel) decides nothing.
      const blocked = (await this.blocksSince(profile, mark)).find(
        (b) => b.navigation && b.page === page,
      );
      if (blocked && allowedOrigins?.length) {
        await page.close().catch(() => {});
        throw new ProfileUrlBlockedError(
          blockedMessage(profile, allowedOrigins, blocked.url),
        );
      }
      if (failure !== undefined) {
        throw failure;
      }
      await page.bringToFront();
    } finally {
      this.endActivity(profile);
    }
  }

  private async launch(
    profile: string,
    headlessOverride?: boolean,
  ): Promise<BrowserContext> {
    const stored = readProfile(this.paths, profile);
    if (!stored) {
      const problem = allowedOriginsProblem(this.paths, profile);
      if (problem) {
        throw new Error(`profile '${profile}': ${problem}`);
      }
      // Should not normally happen: BrowserSession checks existence before
      // calling getContext. Guards against a profile removed mid-flight.
      throw new Error(`unknown profile '${profile}'`);
    }

    const profileDir = join(this.paths.home, "profiles", profile);
    const userDataDir = join(profileDir, "user-data");
    const downloadsDir = join(profileDir, "downloads");

    // Headless if the profile says so OR the global override is set; the
    // global override remains available for tests and CI regardless of what
    // any individual profile stores. A caller-supplied override (login)
    // replaces the profile's own flag entirely instead of OR-ing with it.
    const headless =
      headlessOverride !== undefined
        ? headlessOverride
        : stored.headless || isHeadless();
    this.runningHeadless.set(profile, headless);
    const executableLabel = stored.executablePath
      ? basename(stored.executablePath)
      : "playwright-chromium";

    // Logged before anything that can fail (directory creation, the launch
    // itself), so this line always marks one launch ATTEMPT, whether or not
    // it succeeds (see getContext's failure handling below).
    this.log(
      `browser launch: profile=${profile} browser=${stored.browser} headless=${headless} executable=${executableLabel}`,
    );

    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(downloadsDir, { recursive: true });

    // Test-only seam: lets tests observe the launch decision (this log line)
    // without ever opening a real browser, headed or headless. Never set
    // outside tests.
    if (process.env["ANYBROWSER_TEST_NO_LAUNCH"] === "1") {
      throw new Error(
        "ANYBROWSER_TEST_NO_LAUNCH: browser launch skipped for tests",
      );
    }

    // Every supported browser (decision 4) launches through Playwright's
    // `chromium` driver: for `chromium` itself with its bundled build (no
    // `executablePath`), for every other Chromium-family browser by pointing
    // that same driver at the installed executable.
    // The listener exists before the browser, for every profile (a pinned one
    // enforces its list; an unpinned one passes everything through). The port
    // is a launch flag, so a conditional listener would make turning a list on
    // need a restart, and an edit must apply to a running session at once.
    const proxy = await SiteProxy.start({
      profile,
      allowedOrigins: () => this.currentAllowedOrigins(profile),
      isOwnPort: (port) => this.proxyPorts.has(port),
      describeBlock: (url) =>
        blockedMessage(profile, this.currentAllowedOrigins(profile) ?? [], url),
      onRefusal: (refusal) => {
        this.ledgerFor(profile).record(refusal);
        this.log(`blocked: profile=${profile} url=${loggableUrl(refusal.url)}`);
      },
      log: this.log,
    });
    this.proxyPorts.add(proxy.port);
    this.proxies.set(profile, proxy);
    // Test-only: trust exactly the certificate whose public key hashes to
    // this value, so a test can serve HTTPS locally. It pins one key; it is
    // not a switch that turns certificate checking off.
    const trustedSpki = process.env["ANYBROWSER_TEST_TRUSTED_SPKI"];
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        // No `bypass`: any loopback host there would switch off Chromium's
        // forced proxying of loopback, and local servers must be checked too.
        proxy: { server: `http://127.0.0.1:${proxy.port}` },
        ...(trustedSpki
          ? { args: [`--ignore-certificate-errors-spki-list=${trustedSpki}`] }
          : {}),
        // The daemon is the sole owner of browser lifetime (decision 5) and
        // already installs its own SIGINT/SIGTERM handlers (daemon.ts) that
        // close every context gracefully before exiting. Without these three
        // flags, Playwright installs ITS OWN process-wide signal handlers that
        // independently race to close the same browser process the instant a
        // signal arrives - confirmed by a spike: on SIGTERM, Playwright's own
        // handler and our explicit `context.close()` call both initiate a
        // close of the same browser concurrently, and whichever tears down
        // the browser process first can do so before the other's cookie
        // flush lands, losing a cookie set moments earlier nondeterministically.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(stored.executablePath
          ? { executablePath: stored.executablePath }
          : {}),
      });
    } catch (error) {
      // The browser never came up, so nothing can be using the port.
      this.proxies.delete(profile);
      await proxy.close();
      throw error;
    }
    this.watchBlocks(profile, context);
    const first = context.pages()[0];
    if (first) {
      this.firstPages.set(profile, first);
    }
    return context;
  }

  /**
   * Closes the tabs a disconnected session opened: `owned` plus any popup
   * those pages opened. The profile's first page, and every page that is
   * neither, are left alone, and so is the browser. A browser that is gone or
   * a page that will not close is logged and skipped, never thrown.
   */
  async closeSessionPages(profile: string, owned: Page[]): Promise<void> {
    const context = this.runningContexts.get(profile);
    if (!context || owned.length === 0) {
      return;
    }
    try {
      const first = this.firstPages.get(profile);
      const doomed = new Set<Page>();
      for (const page of context.pages()) {
        if (page === first || page.isClosed()) {
          continue;
        }
        if (owned.includes(page)) {
          doomed.add(page);
          continue;
        }
        for (const ancestor of owned) {
          if (await openedBy(page, ancestor)) {
            doomed.add(page);
            break;
          }
        }
      }
      for (const page of doomed) {
        await page.close().catch((error: unknown) => {
          this.log(
            `could not close session tab: profile=${profile} ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    } catch (error) {
      this.log(
        `could not close session tabs: profile=${profile} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** One embedded `@playwright/mcp` connection for a single (session, profile) pair. */
interface UpstreamConnection {
  client: Client;
  /** Whether this connection has already opened its own fresh tab (decision 10). */
  tabOpened: boolean;
  /**
   * The ledger position up to which this session has already been told about
   * refused subresources. A page keeps loading between calls, so what a call
   * reports starts here, not at the call's own start.
   */
  noteMark?: number;
}

/**
 * Per MCP session (one per `anyb mcp` proxy connection): lists the browser
 * tool surface (profile added, `browser_close`/`browser_install` removed)
 * without touching the browser, and routes `browser_*` tool calls to a
 * lazily created embedded `@playwright/mcp` connection for the named
 * profile, over the daemon-wide shared persistent context.
 */
export class BrowserSession {
  private toolsPromise: Promise<Tool[]> | undefined;
  private readonly connections = new Map<string, Promise<UpstreamConnection>>();
  /** The router generation each cached connection was opened at (see `BrowserContextRouter.generationOf`). */
  private readonly connectionGenerations = new Map<string, number>();
  /** The tabs this session opened, per profile; closed when the session ends. */
  private readonly ownedPages = new Map<string, Page[]>();

  constructor(private readonly router: BrowserContextRouter) {}

  /** Browser tools with `profile` added, minus the removed tools. Never launches a browser. */
  async listTools(): Promise<Tool[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.fetchUpstreamTools();
    }
    const tools = await this.toolsPromise;
    return tools.map(addProfileProperty);
  }

  /** Calls a browser tool by its (profile-added) name; `profile` is required in `args`. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    if (!name.startsWith("browser_") || REMOVED_TOOLS.has(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool '${name}'`);
    }
    const { profile, ...upstreamArgs } = args;
    if (typeof profile !== "string" || profile.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `tool '${name}' requires a string 'profile' argument`,
      );
    }
    if (!profileExists(this.router.paths, profile)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `unknown profile '${profile}'`,
      );
    }
    if (
      name === "browser_navigate" &&
      typeof upstreamArgs["url"] === "string"
    ) {
      // `file:` and its kin never cross the proxy, so the wrapper is the only
      // place a pinned profile can refuse them.
      const refusal = this.router.refuseNonNetworkUrl(
        profile,
        upstreamArgs["url"],
      );
      if (refusal !== null) {
        return {
          isError: true,
          content: [{ type: "text", text: `### Error\n${refusal}` }],
        };
      }
    }
    this.router.beginActivity(profile);
    try {
      const connection = await this.getConnection(profile);
      if (!connection.tabOpened) {
        // Every new embedded connection starts on the shared context's
        // FIRST page (verified in the design spike), so without this, two
        // sessions would share one tab and overwrite each other's
        // navigation. Opening a fresh tab through the upstream tool surface
        // (rather than touching Playwright directly) keeps upstream's own
        // "current tab" bookkeeping correct (decision 10).
        await connection.client.callTool({
          name: "browser_tabs",
          arguments: { action: "new" },
        });
        connection.tabOpened = true;
        await this.adoptCurrentPage(profile, connection);
      }
      const mark = this.router.blockMark(profile);
      const result = await connection.client.callTool({
        name,
        arguments: upstreamArgs,
      });
      if (name === "browser_tabs" && upstreamArgs["action"] === "new") {
        await this.adoptCurrentPage(profile, connection);
      }
      const typed = result as { content: unknown[]; isError?: boolean };
      const content = absolutizeSnapshotLinks(typed.content);
      const allowedOrigins = this.router.currentAllowedOrigins(profile);
      const blocks = await this.router.blocksSince(
        profile,
        connection.noteMark ?? mark,
      );
      connection.noteMark = this.router.blockMark(profile);
      if (blocks.length === 0 || !allowedOrigins?.length) {
        return { ...typed, content };
      }
      // Only a block on THIS session's own current page is this call's
      // error. A block on another session's tab is not, and says nothing here.
      const ownPage = await this.currentPage(profile, connection);
      const own: BlockAttribution[] = [];
      const notes: BlockAttribution[] = [];
      for (const block of blocks) {
        if (block.navigation && block.seq <= mark) {
          // Refused between calls: no call's navigation, so not an error.
          continue;
        }
        if (block.page !== null && block.page === ownPage) {
          (block.navigation ? own : notes).push(block);
        } else if (
          block.page === null ||
          (ownPage !== null && (await openedBy(block.page, ownPage)))
        ) {
          notes.push(block);
        }
      }
      if (own.length === 0 && notes.length === 0) {
        return { ...typed, content };
      }
      // The tab is mid-way to what replaces it; the caller's next navigation
      // would race it (see BrowserContextRouter.whenReplaced).
      await Promise.all(own.map((b) => b.settled));
      if (own.length > 0) {
        // Chromium's error page retries the refused URL on its own, forever;
        // leave the tab somewhere that cannot.
        const shown = describeUrls([...own, ...notes]);
        await this.router.parkRefusedTab(
          profile,
          ownPage,
          blockedMessage(profile, allowedOrigins, shown),
        );
        return {
          ...typed,
          isError: true,
          content: [
            {
              type: "text",
              text: `### Error\n${blockedMessage(profile, allowedOrigins, shown)}`,
            },
          ],
        };
      }
      const note = incompletePageMessage(
        profile,
        allowedOrigins,
        notes.map((b) => b.url),
      );
      return {
        ...typed,
        content: [...content, { type: "text", text: `### Blocked\n${note}` }],
      };
    } finally {
      this.router.endActivity(profile);
    }
  }

  /** Records this connection's current tab, just opened by it, as one the session owns. */
  private async adoptCurrentPage(
    profile: string,
    connection: UpstreamConnection,
  ): Promise<void> {
    const page = await this.currentPage(profile, connection);
    if (page) {
      this.ownedPages.set(profile, [
        ...(this.ownedPages.get(profile) ?? []),
        page,
      ]);
    }
  }

  /** Closes the tabs this session opened (and their popups); called when its socket closes. */
  async dispose(): Promise<void> {
    for (const [profile, pages] of this.ownedPages) {
      await this.router.closeSessionPages(profile, pages);
    }
    this.ownedPages.clear();
  }

  /**
   * The page this connection's current tab is. Upstream keeps that per
   * connection and does not expose it, so it is read from the tab list
   * (`- 1: (current) ...`), whose order is the context's own page order.
   * Null when it cannot be told, which treats nothing as this call's own.
   */
  private async currentPage(
    profile: string,
    connection: UpstreamConnection,
  ): Promise<Page | null> {
    const context = this.router.runningContext(profile);
    if (!context) {
      return null;
    }
    const tabs = (await connection.client.callTool({
      name: "browser_tabs",
      arguments: { action: "list" },
    })) as { content?: Array<{ type?: string; text?: string }> };
    const text = (tabs.content ?? []).map((item) => item.text ?? "").join("\n");
    const index = /^- (\d+): \(current\)/m.exec(text)?.[1];
    return index === undefined
      ? null
      : (context.pages()[Number(index)] ?? null);
  }

  private async fetchUpstreamTools(): Promise<Tool[]> {
    // Any profile's upstream connection reports the same tool set (the set
    // is fixed by our config, not by which profile is running), and asking
    // for it never touches `contextGetter`, so this never launches a
    // browser and never requires any real profile to exist.
    const { client } = await this.getConnection(TOOLS_SCHEMA_KEY);
    const upstream = await client.listTools();
    return upstream.tools.filter((tool) => !REMOVED_TOOLS.has(tool.name));
  }

  private getConnection(profile: string): Promise<UpstreamConnection> {
    // A profile idle-closed (or closed by daemon shutdown) since this
    // connection was opened bumps its generation at the router: drop the
    // stale connection (bound to a now-closed context) so the call below
    // opens a fresh one over the profile's freshly relaunched context.
    const currentGeneration = this.router.generationOf(profile);
    if (this.connectionGenerations.get(profile) !== currentGeneration) {
      this.connections.delete(profile);
    }
    let connection = this.connections.get(profile);
    if (!connection) {
      this.connectionGenerations.set(profile, currentGeneration);
      // A failed open (e.g. the underlying browser launch failed) must not
      // be cached forever: evict it so the next call retries (same reasoning
      // as BrowserContextRouter.getContext; the launch failure itself is
      // already logged there).
      connection = this.openConnection(profile).catch((error: unknown) => {
        this.connections.delete(profile);
        throw error;
      });
      this.connections.set(profile, connection);
    }
    return connection;
  }

  private async openConnection(profile: string): Promise<UpstreamConnection> {
    const config: Parameters<typeof createConnection>[0] = {
      browser: { isolated: false },
      sharedBrowserContext: true,
      outputDir: join(this.router.paths.home, "profiles", profile, "downloads"),
    };
    const server = await createConnection(config, () =>
      this.router.getContext(profile),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "anybrowser-daemon", version: "0.0.0" });
    await client.connect(clientTransport);
    return { client, tabOpened: false };
  }
}
