import { basename, isAbsolute, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createConnection } from "@playwright/mcp";
import { chromium, type BrowserContext } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnybrowserPaths } from "./paths.js";
import { profileExists, readProfile } from "./profile.js";

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

/**
 * Owns the one persistent Chromium context per profile, launched lazily on
 * the first browser tool CALL (never on daemon start, never on a bare
 * `tools/list`). A per-profile "launching" promise makes concurrent first
 * calls share one launch instead of racing (decision 10).
 */
/** Thrown by `BrowserContextRouter.loginLaunch` when a profile is already running headless without the global override. */
export class ProfileHeadlessRunningError extends Error {}

export class BrowserContextRouter {
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profiles whose launch has SUCCEEDED (a resolved context), for profile_status/profile_list/daemon_status. */
  private readonly runningContexts = new Map<string, BrowserContext>();
  /** Whether each running profile's browser is headless, for profile_login's headless-relaunch guard. */
  private readonly runningHeadless = new Map<string, boolean>();

  constructor(
    readonly paths: AnybrowserPaths,
    private readonly log: (event: string) => void,
  ) {}

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

  /** Ids of profiles with a currently running (successfully launched) browser, sorted. */
  runningProfileIds(): string[] {
    return [...this.runningContexts.keys()].sort();
  }

  /** The running context for `profile`, or undefined if it isn't currently running. */
  runningContext(profile: string): BrowserContext | undefined {
    return this.runningContexts.get(profile);
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
    const page = await context.newPage();
    await page.goto(url);
    await page.bringToFront();
  }

  private async launch(
    profile: string,
    headlessOverride?: boolean,
  ): Promise<BrowserContext> {
    const stored = readProfile(this.paths, profile);
    if (!stored) {
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
    return chromium.launchPersistentContext(userDataDir, {
      headless,
      ...(stored.executablePath
        ? { executablePath: stored.executablePath }
        : {}),
    });
  }
}

/** One embedded `@playwright/mcp` connection for a single (session, profile) pair. */
interface UpstreamConnection {
  client: Client;
  /** Whether this connection has already opened its own fresh tab (decision 10). */
  tabOpened: boolean;
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
    const connection = await this.getConnection(profile);
    if (!connection.tabOpened) {
      // Every new embedded connection starts on the shared context's FIRST
      // page (verified in the design spike), so without this, two sessions
      // would share one tab and overwrite each other's navigation. Opening
      // a fresh tab through the upstream tool surface (rather than touching
      // Playwright directly) keeps upstream's own "current tab" bookkeeping
      // correct (decision 10).
      await connection.client.callTool({
        name: "browser_tabs",
        arguments: { action: "new" },
      });
      connection.tabOpened = true;
    }
    const result = await connection.client.callTool({
      name,
      arguments: upstreamArgs,
    });
    const typed = result as { content: unknown[]; isError?: boolean };
    return { ...typed, content: absolutizeSnapshotLinks(typed.content) };
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
    let connection = this.connections.get(profile);
    if (!connection) {
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
