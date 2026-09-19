import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { cleanupHome, cliPath, envFor, makeHome, waitFor } from "./support.js";

const SPAWN_TIMEOUT = 30000;

describe("anyb mcp stdout framing", () => {
  it(
    "carries only JSON-RPC frames on stdout: every non-empty line parses as JSON with jsonrpc '2.0', and the three responses are present",
    async () => {
      const home = makeHome();
      try {
        const child = spawn(process.execPath, [cliPath, "mcp"], {
          env: envFor(home),
          stdio: ["pipe", "pipe", "inherit"],
        });

        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });

        const send = (message: unknown): void => {
          child.stdin.write(JSON.stringify(message) + "\n");
        };

        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "anybrowser-proxy-test", version: "0.0.0" },
          },
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "daemon_status", arguments: {} },
        });

        const seenIds = (): Set<unknown> => {
          const ids = new Set<unknown>();
          for (const line of stdout.split("\n")) {
            if (line.trim().length === 0) continue;
            try {
              const parsed = JSON.parse(line) as { id?: unknown };
              if ("id" in parsed) ids.add(parsed.id);
            } catch {
              // ignored here; checked strictly below
            }
          }
          return ids;
        };

        await waitFor(
          () => {
            const ids = seenIds();
            return ids.has(1) && ids.has(2) && ids.has(3);
          },
          { timeoutMs: 15000 },
        );

        child.stdin.end();
        await new Promise<void>((resolve) => {
          child.on("exit", () => resolve());
        });

        const lines = stdout
          .split("\n")
          .filter((line) => line.trim().length > 0);
        expect(lines.length).toBeGreaterThan(0);

        const ids = new Set<unknown>();
        for (const line of lines) {
          const parsed = JSON.parse(line) as {
            jsonrpc?: unknown;
            id?: unknown;
          };
          expect(parsed.jsonrpc).toBe("2.0");
          if ("id" in parsed) ids.add(parsed.id);
        }
        expect(ids.has(1)).toBe(true);
        expect(ids.has(2)).toBe(true);
        expect(ids.has(3)).toBe(true);
      } finally {
        cleanupHome(home);
      }
    },
    SPAWN_TIMEOUT,
  );
});
