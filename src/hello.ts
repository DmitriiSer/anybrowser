/**
 * The hello line protocol: the first line written by every client on a
 * fresh connection to the daemon's Unix socket, a single JSON object
 * followed by `\n`:
 *
 *   {"anybrowser":{"version":"<package version>","role":"mcp"}}
 *
 * `role` selects what the rest of the connection carries. See daemon.ts for
 * how each role is handled.
 */

export type HelloRole = "mcp" | "status" | "stop";

const HELLO_ROLES: readonly HelloRole[] = ["mcp", "status", "stop"];

export interface HelloLine {
  anybrowser: {
    version: string;
    role: HelloRole;
  };
}

/** Status payload reported by the `status` hello role and the `daemon_status` tool. */
export interface DaemonStatus {
  version: string;
  pid: number;
  uptimeSeconds: number;
  sessions: number;
  profiles: unknown[];
}

export function isHelloRole(value: unknown): value is HelloRole {
  return (
    typeof value === "string" &&
    (HELLO_ROLES as readonly string[]).includes(value)
  );
}

/** Formats a hello line, including its trailing newline. */
export function formatHelloLine(role: HelloRole, version: string): string {
  const hello: HelloLine = { anybrowser: { version, role } };
  return JSON.stringify(hello) + "\n";
}

export type ParsedHello =
  { ok: true; version: string; role: HelloRole } | { ok: false; error: string };

/**
 * Parses a hello line (without its trailing newline). Never throws: any
 * problem is reported through the `ok: false` branch so the caller can
 * reply with an error line instead of crashing.
 */
export function parseHelloLine(line: string): ParsedHello {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, error: "first line is not valid JSON" };
  }

  if (typeof data !== "object" || data === null || !("anybrowser" in data)) {
    return { ok: false, error: "missing 'anybrowser' key" };
  }

  const envelope = (data as { anybrowser: unknown }).anybrowser;
  if (typeof envelope !== "object" || envelope === null) {
    return { ok: false, error: "'anybrowser' must be an object" };
  }

  const { version, role } = envelope as { version?: unknown; role?: unknown };
  if (typeof version !== "string") {
    return { ok: false, error: "missing 'anybrowser.version'" };
  }
  if (!isHelloRole(role)) {
    return { ok: false, error: `unknown role '${String(role)}'` };
  }

  return { ok: true, version, role };
}

/** One JSON line the daemon sends back when a hello line is invalid. */
export function formatErrorLine(reason: string): string {
  return JSON.stringify({ error: reason }) + "\n";
}

/** One JSON line the daemon sends back to acknowledge a `stop` hello. */
export function formatStopAckLine(): string {
  return JSON.stringify({ ok: true }) + "\n";
}

/** One JSON line the daemon sends back to a `status` hello. */
export function formatStatusLine(status: DaemonStatus): string {
  return JSON.stringify(status) + "\n";
}
