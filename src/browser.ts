import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "@playwright/mcp";
import { chromium, type BrowserContext } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnybrowserPaths } from "./paths.js";

/**
 * The one hard-coded profile this slice supports. Profile management
 * (multiple profiles, browser choice, creation) is a later slice.
 */
export const HARD_CODED_PROFILE = "default-in-chromium";

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

/**
 * Owns the one persistent Chromium context per profile, launched lazily on
 * the first browser tool CALL (never on daemon start, never on a bare
 * `tools/list`). A per-profile "launching" promise makes concurrent first
 * calls share one launch instead of racing (decision 10).
 */
export class BrowserContextRouter {
  private readonly contexts = new Map<string, Promise<BrowserContext>>();

  constructor(
    readonly paths: AnybrowserPaths,
    private readonly log: (event: string) => void,
  ) {}

  /** Returns the shared persistent context for `profile`, launching it on first use. */
  getContext(profile: string): Promise<BrowserContext> {
    let launching = this.contexts.get(profile);
    if (!launching) {
      launching = this.launch(profile);
      this.contexts.set(profile, launching);
    }
    return launching;
  }

  private async launch(profile: string): Promise<BrowserContext> {
    const profileDir = join(this.paths.home, "profiles", profile);
    const userDataDir = join(profileDir, "user-data");
    const downloadsDir = join(profileDir, "downloads");
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(downloadsDir, { recursive: true });

    const headless = isHeadless();
    this.log(`browser launch: profile=${profile} headless=${headless}`);

    return chromium.launchPersistentContext(userDataDir, { headless });
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
    if (profile !== HARD_CODED_PROFILE) {
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
    return result as { content: unknown[]; isError?: boolean };
  }

  private async fetchUpstreamTools(): Promise<Tool[]> {
    // Any profile's upstream connection reports the same tool set (the set
    // is fixed by our config, not by which profile is running), and asking
    // for it never touches `contextGetter`, so this never launches a
    // browser. Use the hard-coded profile's connection.
    const { client } = await this.getConnection(HARD_CODED_PROFILE);
    const upstream = await client.listTools();
    return upstream.tools.filter((tool) => !REMOVED_TOOLS.has(tool.name));
  }

  private getConnection(profile: string): Promise<UpstreamConnection> {
    let connection = this.connections.get(profile);
    if (!connection) {
      connection = this.openConnection(profile);
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
