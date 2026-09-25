import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProfile, cleanupHome, connectClient, makeHome } from "./support.js";

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text content item");
  }
  return first.text;
}

describe("profile_list MCP tool", () => {
  it(
    "lists tools including profile_list, and returns JSON with id, browser, headless, running for each profile",
    async () => {
      addProfile(home, "work", "chromium");
      addProfile(home, "docs", "chromium", { headless: true });

      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain("profile_list");

        const result = await client.callTool({
          name: "profile_list",
          arguments: {},
        });
        const parsed = JSON.parse(textOf(result as never)) as Array<{
          id: string;
          browser: string;
          headless: boolean;
          running: boolean;
        }>;
        expect(parsed).toHaveLength(2);
        const byId = Object.fromEntries(parsed.map((p) => [p.id, p]));
        expect(byId["work-in-chromium"]).toMatchObject({
          browser: "chromium",
          headless: false,
          running: false,
        });
        expect(byId["docs-in-chromium"]).toMatchObject({
          browser: "chromium",
          headless: true,
          running: false,
        });
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("profile_create MCP tool", () => {
  it(
    "creates a profile with the same validation as the CLI, and returns its id",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain("profile_create");

        const result = await client.callTool({
          name: "profile_create",
          arguments: { name: "work", browser: "chromium", headless: true },
        });
        expect(result.isError).toBeFalsy();
        expect(textOf(result as never)).toBe("work-in-chromium");

        const listResult = await client.callTool({
          name: "profile_list",
          arguments: {},
        });
        const parsed = JSON.parse(textOf(listResult as never)) as Array<{
          id: string;
        }>;
        expect(parsed.map((p) => p.id)).toContain("work-in-chromium");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "returns an MCP error for an invalid name, without creating anything",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_create",
          arguments: { name: "Not Valid", browser: "chromium" },
        });
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("profile_status MCP tool", () => {
  it(
    "reports running=false, headless and browser for a profile that has never been launched",
    async () => {
      addProfile(home, "work", "chromium", { headless: true });
      const { client, close } = await connectClient(home);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain("profile_status");

        const result = await client.callTool({
          name: "profile_status",
          arguments: { profile: "work-in-chromium" },
        });
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(textOf(result as never)) as {
          running: boolean;
          headless: boolean;
          browser: string;
          tabCount?: number;
        };
        expect(parsed.running).toBe(false);
        expect(parsed.headless).toBe(true);
        expect(parsed.browser).toBe("chromium");
        expect(parsed.tabCount).toBeUndefined();
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "returns an MCP error naming the profile when it does not exist",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        await expect(
          client.callTool({
            name: "profile_status",
            arguments: { profile: "no-such-profile" },
          }),
        ).rejects.toThrow(/no-such-profile/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
