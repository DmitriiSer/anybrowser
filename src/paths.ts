import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Unix socket paths are limited to roughly 104 bytes on macOS (sockaddr_un's
 * sun_path is 104 bytes including the trailing NUL) and 108 bytes on Linux.
 * We check against the smaller of the two so state directories that work on
 * macOS also work on Linux.
 */
export const SOCKET_PATH_LIMIT = 104;

export interface AnybrowserPaths {
  /** The state directory, e.g. ~/.anybrowser or $ANYBROWSER_HOME. */
  home: string;
  /** Unix socket the daemon listens on. */
  socket: string;
  /** Exclusive spawn lock file. */
  lock: string;
  /** Daemon stdout/stderr log file. */
  log: string;
}

/**
 * Resolves the anybrowser state directory and the well-known files inside
 * it, honoring ANYBROWSER_HOME when set. Does not touch the filesystem.
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
): AnybrowserPaths {
  const home = env["ANYBROWSER_HOME"]?.trim() || join(homedir(), ".anybrowser");
  return {
    home,
    socket: join(home, "daemon.sock"),
    lock: join(home, "daemon.lock"),
    log: join(home, "daemon.log"),
  };
}

/**
 * Throws a clear error if the socket path would exceed the platform's
 * sockaddr_un length limit, naming the limit and suggesting a fix.
 */
export function assertSocketPathFits(socketPath: string): void {
  const byteLength = Buffer.byteLength(socketPath, "utf8");
  if (byteLength > SOCKET_PATH_LIMIT) {
    throw new Error(
      `anybrowser: socket path is ${byteLength} bytes, which exceeds the ` +
        `${SOCKET_PATH_LIMIT}-byte limit for Unix domain socket paths on ` +
        `macOS (108 on Linux). Set ANYBROWSER_HOME to a shorter path, e.g. ` +
        `ANYBROWSER_HOME=~/.ab, and try again.\n  path: ${socketPath}`,
    );
  }
}
