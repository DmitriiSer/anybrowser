import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { assertSocketPathFits, type AnybrowserPaths } from "./paths.js";

const DEFAULT_SPAWN_WAIT_MS = 10000;

/**
 * How long `ensureDaemon` waits to connect to (or spawn and connect to) the
 * daemon before giving up, configurable for tests. Mirrors
 * `ANYBROWSER_STOP_WAIT_MS` in cli.ts. Invalid values (non-numeric, zero,
 * negative) fall back to the default.
 */
function spawnWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["ANYBROWSER_SPAWN_WAIT_MS"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SPAWN_WAIT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SPAWN_WAIT_MS;
}
/** Lock is considered stale once it is this old, regardless of its contents. */
const LOCK_MAX_AGE_MS = 15000;
/** Lock is considered stale if it's empty/unreadable and at least this old. */
const LOCK_EMPTY_GRACE_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollIntervalMs(): number {
  return 50 + Math.floor(Math.random() * 50);
}

/** Tries once to connect to the daemon socket. Resolves null instead of throwing on any failure. */
export function connectOnce(socketPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = () => {
      cleanup();
      socket.destroy();
      resolve(null);
    };
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

type LockAttempt = "acquired" | "busy";

function tryCreateLockFile(lockPath: string): LockAttempt {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "busy";
    }
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return "acquired";
}

function removeLockFile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best effort: nothing useful to do if it's already gone or unremovable
  }
}

/** Whether the spawn lock at `lockPath` looks abandoned and safe to remove. */
function isLockStale(lockPath: string): boolean {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return false; // gone already; nothing to clean up
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > LOCK_MAX_AGE_MS) {
    return true;
  }

  let content: string;
  try {
    content = readFileSync(lockPath, "utf8");
  } catch {
    return ageMs > LOCK_EMPTY_GRACE_MS;
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return ageMs > LOCK_EMPTY_GRACE_MS;
  }

  const pid = Number(trimmed);
  if (!Number.isInteger(pid)) {
    return ageMs > LOCK_EMPTY_GRACE_MS;
  }

  try {
    process.kill(pid, 0);
    return false; // still alive
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function spawnDaemonProcess(paths: AnybrowserPaths): Promise<void> {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const logFd = openSync(paths.log, "a");
  try {
    const child = spawn(process.execPath, [cliPath, "daemon"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function displayLogPath(
  paths: AnybrowserPaths,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env["ANYBROWSER_HOME"]?.trim()) {
    return paths.log;
  }
  return "~/.anybrowser/daemon.log";
}

/**
 * Returns a socket connected to the daemon, spawning it first if nothing is
 * listening yet. Safe to call concurrently from many processes: exactly one
 * spawns the daemon (via an O_EXCL lock file), the rest wait for it.
 */
export async function ensureDaemon(
  paths: AnybrowserPaths,
  deadlineMs: number = spawnWaitMs(),
): Promise<Socket> {
  assertSocketPathFits(paths.socket);

  // First run: the state directory (e.g. ~/.anybrowser) may not exist yet.
  // Create it before anything below needs to open the lock or log file
  // inside it.
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);

  const deadline = Date.now() + deadlineMs;

  for (;;) {
    const connected = await connectOnce(paths.socket);
    if (connected) {
      return connected;
    }

    if (Date.now() >= deadline) {
      break;
    }

    const lockAttempt = tryCreateLockFile(paths.lock);
    if (lockAttempt === "acquired") {
      try {
        await spawnDaemonProcess(paths);
        while (Date.now() < deadline) {
          const socket = await connectOnce(paths.socket);
          if (socket) {
            return socket;
          }
          await delay(pollIntervalMs());
        }
        break;
      } finally {
        removeLockFile(paths.lock);
      }
    }

    // Someone else holds the lock: wait for them, but reclaim a stale lock.
    let staleDetected = false;
    while (Date.now() < deadline) {
      const socket = await connectOnce(paths.socket);
      if (socket) {
        return socket;
      }
      if (isLockStale(paths.lock)) {
        removeLockFile(paths.lock);
        staleDetected = true;
        break;
      }
      await delay(pollIntervalMs());
    }
    if (!staleDetected) {
      break;
    }
    // loop back around and try to acquire the lock ourselves
  }

  throw new Error(
    `anyb: could not connect to or start the daemon within ${deadlineMs}ms. ` +
      `Check the log at ${displayLogPath(paths)}`,
  );
}
