/**
 * The allowed-sites list: validation and matching. Each entry is
 * `[scheme://]host[:port]`:
 *
 * - `host` is a domain name, an IPv4 address or a bracketed IPv6 literal. A
 *   leading `*.` (names only) means any subdomain, NOT the apex: `example.com`
 *   and `*.example.com` are separate entries, on purpose. A list is a safety
 *   boundary, so nothing is allowed that was not written down.
 * - `scheme` is `http` or `https`; without it an entry covers both.
 * - `port` is a number from 1 to 65535 or `*` for any; without it an entry
 *   covers the scheme's default port only (80, 443).
 */

interface ParsedEntry {
  scheme: "http" | "https" | null;
  wildcard: boolean;
  /** Lowercased, ASCII (punycode) host as `URL.hostname` spells it. */
  host: string;
  /** A fixed port, `"*"` for any, or null for the scheme's default. */
  port: number | "*" | null;
}

export type ParseResult =
  | { ok: true; entry: ParsedEntry; normalized: string }
  | { ok: false; error: string };

const HINT = "pass host patterns like example.com or *.example.com";

/** A domain label: letters or digits (any script) with inner hyphens. */
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

function fail(error: string): ParseResult {
  return { ok: false, error: `${error}; ${HINT}` };
}

/** Validates and normalizes one entry (see the module comment for the forms). */
export function parseAllowedOrigin(raw: string): ParseResult {
  const text = raw.trim();
  if (text.length === 0) {
    return fail("allowed-sites entry is empty");
  }
  if (/\s/.test(text)) {
    return fail(`allowed-sites entry '${text}' contains whitespace`);
  }
  let rest = text;
  let scheme: "http" | "https" | null = null;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest);
  if (schemeMatch) {
    const name = (schemeMatch[1] as string).toLowerCase();
    if (name !== "http" && name !== "https") {
      return fail(
        `allowed-sites entry '${text}' has an unsupported scheme '${name}' (only http and https)`,
      );
    }
    scheme = name;
    rest = rest.slice(schemeMatch[0].length);
  }
  if (/[/?#]/.test(rest)) {
    return fail(`allowed-sites entry '${text}' has a path`);
  }
  const wildcard = rest.startsWith("*.");
  if (wildcard) {
    rest = rest.slice(2);
  }

  let host: string;
  let portText: string | undefined;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (
      close === -1 ||
      (close !== rest.length - 1 && rest[close + 1] !== ":")
    ) {
      return fail(`allowed-sites entry '${text}' is not a host pattern`);
    }
    host = rest.slice(0, close + 1);
    portText = close === rest.length - 1 ? undefined : rest.slice(close + 2);
  } else {
    const parts = rest.split(":");
    if (parts.length > 2) {
      return fail(`allowed-sites entry '${text}' is not a host pattern`);
    }
    host = parts[0] as string;
    portText = parts[1];
  }

  let port: number | "*" | null = null;
  if (portText !== undefined) {
    if (portText === "*") {
      port = "*";
    } else if (/^\d{1,5}$/.test(portText)) {
      port = Number(portText);
      if (port < 1 || port > 65535) {
        return fail(`allowed-sites entry '${text}' has a port outside 1-65535`);
      }
    } else {
      return fail(`allowed-sites entry '${text}' is not a host pattern`);
    }
  }

  const isIpv6 = host.startsWith("[");
  if (wildcard && host === "") {
    return fail(
      `allowed-sites entry '${text}' needs at least two labels after '*.'`,
    );
  }
  if (!isIpv6 && !host.split(".").every((label) => LABEL.test(label))) {
    return fail(`allowed-sites entry '${text}' is not a host pattern`);
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return fail(`allowed-sites entry '${text}' is not a host pattern`);
  }
  const isAddress = isIpv6 || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (wildcard && isAddress) {
    return fail(`allowed-sites entry '${text}' is not a host pattern`);
  }
  if (!isAddress) {
    const labels = hostname.split(".").length;
    if (wildcard && labels < 2) {
      return fail(
        `allowed-sites entry '${text}' needs at least two labels after '*.' (a wildcard over a whole top-level domain allows far too much)`,
      );
    }
    if (!wildcard && labels < 2 && hostname !== "localhost") {
      return fail(
        `allowed-sites entry '${text}' needs at least two labels (localhost is the one exception)`,
      );
    }
  }

  const normalized =
    (scheme ? `${scheme}://` : "") +
    (wildcard ? "*." : "") +
    hostname +
    (port === null ? "" : `:${port}`);
  return {
    ok: true,
    entry: { scheme, wildcard, host: hostname, port },
    normalized,
  };
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

const parsedCache = new Map<string, ParsedEntry | null>();

function parsedEntry(raw: string): ParsedEntry | null {
  let cached = parsedCache.get(raw);
  if (cached === undefined) {
    const result = parseAllowedOrigin(raw);
    cached = result.ok ? result.entry : null;
    parsedCache.set(raw, cached);
  }
  return cached;
}

/** Whether `url` may be requested by a profile with this list. Non-network schemes (data, blob, about) never leave the browser and are allowed; any other scheme (file, ftp, ...) is not. */
export function isUrlAllowed(url: string, entries: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme === "data" || scheme === "blob" || scheme === "about") {
    return true;
  }
  const effectiveScheme =
    scheme === "ws" ? "http" : scheme === "wss" ? "https" : scheme;
  if (effectiveScheme !== "http" && effectiveScheme !== "https") {
    return false;
  }
  const port =
    parsed.port === "" ? DEFAULT_PORTS[effectiveScheme] : Number(parsed.port);
  return entries.some((raw) => {
    const entry = parsedEntry(raw);
    if (!entry) {
      return false;
    }
    if (entry.scheme !== null && entry.scheme !== effectiveScheme) {
      return false;
    }
    const hostMatches = entry.wildcard
      ? parsed.hostname.endsWith(`.${entry.host}`)
      : parsed.hostname === entry.host;
    if (!hostMatches) {
      return false;
    }
    return (
      entry.port === "*" ||
      port === (entry.port ?? DEFAULT_PORTS[effectiveScheme])
    );
  });
}
