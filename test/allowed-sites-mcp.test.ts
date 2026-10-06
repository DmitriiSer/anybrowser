import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProfile,
  cleanupHome,
  connectClient,
  makeHome,
  runCli,
} from "./support.js";

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

describe("profile_status and the allowed-sites list", () => {
  it(
    "reports allowedOrigins: the list for a pinned profile, null for an open one",
    async () => {
      runCli(
        [
          "profile",
          "add",
          "pinned",
          "chromium",
          "--allow",
          "example.com,*.example.com",
        ],
        home,
      );
      addProfile(home, "open", "chromium");
      const { client, close } = await connectClient(home);
      try {
        const status = async (profile: string) =>
          JSON.parse(
            textOf(
              (await client.callTool({
                name: "profile_status",
                arguments: { profile },
              })) as never,
            ),
          ) as { allowedOrigins: string[] | null };

        expect((await status("pinned-in-chromium")).allowedOrigins).toEqual([
          "example.com",
          "*.example.com",
        ]);
        expect((await status("open-in-chromium")).allowedOrigins).toBeNull();
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "reports null for a profile.json written before the field existed",
    async () => {
      const dir = join(home, "profiles", "old-in-chromium");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "profile.json"),
        JSON.stringify({
          name: "old",
          browser: "chromium",
          headless: false,
          executablePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_status",
          arguments: { profile: "old-in-chromium" },
        });
        expect(
          (JSON.parse(textOf(result as never)) as { allowedOrigins: unknown })
            .allowedOrigins,
        ).toBeNull();
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("profile_list and the allowed-sites list", () => {
  it(
    "includes allowedOrigins for each profile",
    async () => {
      runCli(
        ["profile", "add", "pinned", "chromium", "--allow", "example.com"],
        home,
      );
      addProfile(home, "open", "chromium");
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_list",
          arguments: {},
        });
        const byId = Object.fromEntries(
          (
            JSON.parse(textOf(result as never)) as Array<{
              id: string;
              allowedOrigins: string[] | null;
            }>
          ).map((p) => [p.id, p.allowedOrigins]),
        );
        expect(byId["pinned-in-chromium"]).toEqual(["example.com"]);
        expect(byId["open-in-chromium"]).toBeNull();
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("tool descriptions", () => {
  it(
    "profile_list and profile_status say they report the allowed-sites list",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const { tools } = await client.listTools();
        for (const name of ["profile_list", "profile_status"]) {
          const tool = tools.find((t) => t.name === name);
          expect(tool?.description, name).toMatch(/allowedOrigins/);
        }
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("the agent cannot change the allowed-sites list", () => {
  it(
    "exposes no tool that takes an allowed-sites argument",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          const properties = Object.keys(
            (tool.inputSchema as { properties?: Record<string, unknown> })
              .properties ?? {},
          );
          expect(
            properties.filter((name) => /allow|origin/i.test(name)),
            tool.name,
          ).toEqual([]);
        }
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "profile_create rejects an allowedOrigins argument and creates nothing",
    async () => {
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_create",
          arguments: {
            name: "sneaky",
            browser: "chromium",
            allowedOrigins: ["example.com"],
          },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result as never)).toMatch(/anyb profile/);

        const list = await client.callTool({
          name: "profile_list",
          arguments: {},
        });
        expect(JSON.parse(textOf(list as never))).toEqual([]);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a profile.json whose allowedOrigins is hand-edited into a bad shape", () => {
  function breakList(value: unknown): void {
    const file = join(home, "profiles", "pinned-in-chromium", "profile.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    stored["allowedOrigins"] = value;
    writeFileSync(file, JSON.stringify(stored));
  }

  it(
    "profile_status says the list is unreadable instead of calling it active",
    async () => {
      addProfile(home, "pinned", "chromium");
      breakList("127.0.0.1:1234");
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_status",
          arguments: { profile: "pinned-in-chromium" },
        });
        const text = textOf(result as never);
        expect(result.isError, text).toBe(true);
        expect(text).toContain("allowedOrigins");
        expect(text).toMatch(/unreadable/);
        expect(text).not.toMatch(/anyb profile/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "profile_list still lists the profile and flags the list as unreadable",
    async () => {
      addProfile(home, "pinned", "chromium");
      breakList([5, "127.0.0.1:1234"]);
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "profile_list",
          arguments: {},
        });
        const listed = JSON.parse(textOf(result as never)) as Array<{
          id: string;
          error?: string;
        }>;
        const entry = listed.find((p) => p.id === "pinned-in-chromium");
        expect(entry?.error).toMatch(/allowedOrigins.*unreadable/);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("browser_navigate to a scheme that never crosses the network proxy", () => {
  it(
    "refuses file: on a pinned profile with the allowed-sites message, before any browser is launched",
    async () => {
      addProfile(home, "pinned", "chromium", {});
      expect(
        runCli(
          [
            "profile",
            "set",
            "pinned-in-chromium",
            "allowedOrigins=example.com",
          ],
          home,
        ).status,
      ).toBe(0);
      const { client, close } = await connectClient(home);
      try {
        const result = await client.callTool({
          name: "browser_navigate",
          arguments: {
            profile: "pinned-in-chromium",
            url: "file:///tmp/example.txt",
          },
        });
        const text = textOf(result as never);
        expect(result.isError, text).toBe(true);
        expect(text).toContain("file:///tmp/example.txt");
        expect(text).toMatch(/allowed-sites list/);
        const log = readFileSync(join(home, "daemon.log"), "utf8");
        expect(log).toContain("blocked: profile=pinned-in-chromium url=file:");
        expect(log).not.toContain("browser launch:");
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
