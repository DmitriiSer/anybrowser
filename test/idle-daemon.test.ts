import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupHome,
  connectClient,
  daemonStatusFrom,
  isPidAlive,
  logPathFor,
  makeHome,
  runCli,
  socketExists,
  waitFor,
} from "./support.js";

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("daemon idle exit with no sessions", () => {
  it(
    "the daemon exits on its own after ANYBROWSER_IDLE_MS with no session connected, logging one idle-exit line",
    async () => {
      const idleMs = 400;
      const { client, close } = await connectClient(home, {
        ANYBROWSER_IDLE_MS: String(idleMs),
      });
      // Sanity check: the daemon is really up and answering before it goes idle.
      await daemonStatusFrom(client);
      await close();

      await waitFor(() => !socketExists(home), { timeoutMs: idleMs + 8000 });

      const status = runCli(["status"], home);
      expect(status.status).toBe(1);
      expect(status.stdout.trim()).toBe("not running");

      const log = readFileSync(logPathFor(home), "utf8");
      const idleLines = log
        .split("\n")
        .filter((line) => line.includes("idle exit"));
      expect(idleLines.length).toBe(1);
    },
    SPAWN_TIMEOUT,
  );
});

describe("a connected session keeps the daemon alive", () => {
  it(
    "stays running, unresponded, through several idle periods while one session stays connected, and still answers daemon_status",
    async () => {
      const idleMs = 300;
      const { client, close } = await connectClient(home, {
        ANYBROWSER_IDLE_MS: String(idleMs),
      });
      try {
        const firstStatus = await daemonStatusFrom(client);
        expect(firstStatus.idleMs).toBe(idleMs);

        // Idle (no tool calls at all) for several times the idle window,
        // with the session still connected throughout.
        await new Promise((resolve) => setTimeout(resolve, idleMs * 6));

        expect(socketExists(home)).toBe(true);
        const secondStatus = await daemonStatusFrom(client);
        expect(secondStatus.pid).toBe(firstStatus.pid);

        const log = readFileSync(logPathFor(home), "utf8");
        expect(log.includes("idle exit")).toBe(false);
      } finally {
        await close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("ANYBROWSER_IDLE_MS=off disables the daemon-exit timer", () => {
  it(
    "daemon_status.idleMs is null and the daemon never exits for idleness, even with no session connected for several idle windows",
    async () => {
      const referenceIdleMs = 300;
      const { client, close } = await connectClient(home, {
        ANYBROWSER_IDLE_MS: "off",
      });
      const status = await daemonStatusFrom(client);
      expect(status.idleMs).toBeNull();
      await close();

      // No session connected for several times a would-be idle window: the
      // daemon must still be up and answering.
      await new Promise((resolve) => setTimeout(resolve, referenceIdleMs * 6));
      expect(socketExists(home)).toBe(true);
      expect(isPidAlive(status.pid)).toBe(true);

      const result = runCli(["status"], home);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        pid: number;
        idleMs: number | null;
      };
      expect(parsed.pid).toBe(status.pid);
      expect(parsed.idleMs).toBeNull();

      const log = readFileSync(logPathFor(home), "utf8");
      expect(log.includes("idle exit")).toBe(false);
    },
    SPAWN_TIMEOUT,
  );
});
