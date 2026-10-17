import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupHome,
  connectClient,
  daemonStatusFrom,
  isPidAlive,
  logPathFor,
  makeHome,
  packageVersion,
  runCli,
  waitFor,
} from "./support.js";

/**
 * docs/DESIGN.md decision 17: an upgraded `anyb` replaces an old running
 * daemon on its own. ANYBROWSER_TEST_VERSION (read by readVersion()) lets a
 * test run a daemon and a proxy that disagree about the version.
 */

const SPAWN_TIMEOUT = 30000;
const OLD_VERSION = "0.0.1-old";
const OLD_ENV = { ANYBROWSER_TEST_VERSION: OLD_VERSION };

let home: string;

/** Polls `anyb status` (the status hello role) until the daemon reports `count` sessions. */
async function waitForSessions(count: number): Promise<void> {
  await waitFor(
    () => {
      const result = runCli(["status"], home);
      return (
        result.status === 0 &&
        (JSON.parse(result.stdout.trim()) as { sessions: number }).sessions ===
          count
      );
    },
    { timeoutMs: 8000 },
  );
}

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

describe("a proxy of a new version meets an old daemon with no sessions", () => {
  it(
    "replaces the old daemon: its pid is gone and a new daemon of the new version serves the session",
    async () => {
      const old = await connectClient(home, OLD_ENV);
      const oldStatus = await daemonStatusFrom(old.client);
      expect(oldStatus.version).toBe(OLD_VERSION);
      await old.close();
      await waitForSessions(0);

      const fresh = await connectClient(home);
      try {
        const status = await daemonStatusFrom(fresh.client);
        expect(status.version).toBe(packageVersion);
        expect(status.pid).not.toBe(oldStatus.pid);
        await waitFor(() => !isPidAlive(oldStatus.pid), { timeoutMs: 8000 });
        const log = readFileSync(logPathFor(home), "utf8");
        expect(log).toContain("start pid=");
      } finally {
        await fresh.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a proxy of a new version meets an old daemon with a live session", () => {
  it(
    "is served by the old daemon, which retires and exits once both sessions are gone; the next connection gets a new daemon",
    async () => {
      const old = await connectClient(home, OLD_ENV);
      const oldStatus = await daemonStatusFrom(old.client);
      expect(oldStatus.retiring).toBe(false);

      const fresh = await connectClient(home);
      try {
        const served = await daemonStatusFrom(fresh.client);
        expect(served.pid).toBe(oldStatus.pid);
        expect(served.version).toBe(OLD_VERSION);
        expect(served.retiring).toBe(true);
        expect(served.sessions).toBe(2);
      } finally {
        await fresh.close();
      }
      await waitForSessions(1);
      // Still one live session: the daemon must keep serving it.
      expect(isPidAlive(oldStatus.pid)).toBe(true);
      await old.close();

      await waitFor(() => !isPidAlive(oldStatus.pid), { timeoutMs: 8000 });
      const log = readFileSync(logPathFor(home), "utf8");
      const retireLines = log
        .split("\n")
        .filter((line) => line.includes("retiring"));
      expect(retireLines.length).toBe(2);
      for (const line of retireLines) {
        expect(line).toContain(OLD_VERSION);
        expect(line).toContain(packageVersion);
      }

      const next = await connectClient(home);
      try {
        const status = await daemonStatusFrom(next.client);
        expect(status.version).toBe(packageVersion);
        expect(status.pid).not.toBe(oldStatus.pid);
        expect(status.retiring).toBe(false);
      } finally {
        await next.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("a proxy of the same version meets a running daemon", () => {
  it(
    "changes nothing: same pid, not retiring",
    async () => {
      const first = await connectClient(home);
      const firstStatus = await daemonStatusFrom(first.client);
      await first.close();
      await waitForSessions(0);

      const second = await connectClient(home);
      try {
        const status = await daemonStatusFrom(second.client);
        expect(status.pid).toBe(firstStatus.pid);
        expect(status.retiring).toBe(false);
      } finally {
        await second.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("two proxies of a new version connect at the same moment to an old idle daemon", () => {
  it(
    "end with exactly one new daemon serving both",
    async () => {
      const old = await connectClient(home, OLD_ENV);
      const oldStatus = await daemonStatusFrom(old.client);
      await old.close();
      await waitForSessions(0);

      const pair = await Promise.all([
        connectClient(home),
        connectClient(home),
      ]);
      try {
        const statuses = await Promise.all(
          pair.map((c) => daemonStatusFrom(c.client)),
        );
        expect(new Set(statuses.map((s) => s.pid)).size).toBe(1);
        expect(statuses[0]!.pid).not.toBe(oldStatus.pid);
        expect(statuses[0]!.version).toBe(packageVersion);

        const startLines = readFileSync(logPathFor(home), "utf8")
          .split("\n")
          .filter((line) => line.includes(`version=${packageVersion}`));
        expect(startLines.length).toBe(1);
      } finally {
        await Promise.allSettled(pair.map((c) => c.close()));
      }
    },
    SPAWN_TIMEOUT,
  );
});
