/**
 * The book of requests a profile's proxy has refused. Two sources feed it and
 * neither is enough alone:
 *
 * - The proxy's own refusal record (`record`) decides WHETHER something was
 *   blocked. It is the only thing that is never wrong about that.
 * - Playwright's context-level events (`claimConnect`, `claimHttp`) say WHICH
 *   URL and WHICH page. They are subscribed at context level because popups
 *   and service-worker requests emit no page event.
 *
 * A refusal starts unclaimed and is claimed by at most one event. Error text
 * is never parsed: a refusal, an upstream `ECONNREFUSED` and a proxy 502 all
 * look the same to the browser.
 *
 * Each tool call takes a `mark` before it runs and reads `since(mark)` after,
 * so what it reports is what was refused during ITS window, and each entry
 * says which page it happened on so a caller can tell its own from another
 * session's. Bounded: only the newest 300 refusals are kept.
 */
import type { Frame, Page } from "playwright";
import type { Refusal } from "./siteProxy.js";

/** What a Playwright event revealed about a refused request. */
export interface BlockAttribution {
  /** The URL the page asked for (for a tunnel, with its real path). */
  url: string;
  /** Whether it was a top-level page navigation. */
  navigation: boolean;
  /** The page it happened on; null when Playwright gave none (a service worker, say). */
  page: Page | null;
  frame: Frame | null;
  /** For a top-level navigation: resolves once the tab has committed what replaces it, or after a deadline. */
  settled?: Promise<void>;
}

export interface LedgerEntry {
  seq: number;
  refusal: Refusal;
  claim?: BlockAttribution;
}

const MAX_ENTRIES = 300;

/** `host:port` of the destination a CONNECT refusal or a ws/https request URL names. */
function authorityOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const defaults: Record<string, string> = {
      "https:": "443",
      "wss:": "443",
      "http:": "80",
      "ws:": "80",
    };
    const port = parsed.port || defaults[parsed.protocol];
    return port === undefined ? null : `${parsed.hostname}:${port}`;
  } catch {
    return null;
  }
}

function hrefOf(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

export class BlockLedger {
  private entries: LedgerEntry[] = [];
  private seq = 0;
  private readonly changed = new Set<() => void>();

  /** A cursor: everything refused after this call is "new". */
  mark(): number {
    return this.seq;
  }

  /** Records one refusal made by the proxy. */
  record(refusal: Refusal): void {
    this.entries.push({ seq: ++this.seq, refusal });
    this.entries = this.entries.slice(-MAX_ENTRIES);
    this.notify();
  }

  /**
   * A failed request whose URL names a destination the proxy refused a
   * CONNECT to (https, wss, or a ws tunnel). Claims the newest unclaimed
   * refusal for it; returns false when there is none, i.e. the failure was
   * not a refusal.
   */
  claimConnect(
    url: string,
    attribution: (refusedAt: number) => BlockAttribution,
  ): boolean {
    const wanted = authorityOf(url);
    if (wanted === null) {
      return false;
    }
    const entry = this.newestUnclaimed(
      (e) =>
        e.refusal.kind === "connect" && authorityOf(e.refusal.url) === wanted,
    );
    if (!entry) {
      return false;
    }
    entry.claim = attribution(entry.refusal.at);
    this.notify();
    return true;
  }

  /** A response carrying the proxy's block header for `url`; claims the newest matching plain-HTTP refusal. */
  claimHttp(
    url: string,
    attribution: (refusedAt: number) => BlockAttribution,
  ): boolean {
    const wanted = hrefOf(url);
    const entry = this.newestUnclaimed(
      (e) => e.refusal.kind === "http" && hrefOf(e.refusal.url) === wanted,
    );
    if (!entry) {
      return false;
    }
    entry.claim = attribution(entry.refusal.at);
    this.notify();
    return true;
  }

  /**
   * The NEWEST unclaimed refusal matching `matches`. An event trails its own
   * refusal by moments, so the newest match is the one it describes; older
   * unclaimed ones (a blocked WebSocket or the browser's own traffic emits no
   * event, ever) are stale and must not shadow it.
   */
  private newestUnclaimed(
    matches: (entry: LedgerEntry) => boolean,
  ): LedgerEntry | undefined {
    return this.entries.findLast((e) => e.claim === undefined && matches(e));
  }

  /** Entries refused after `mark`, oldest first. */
  since(mark: number): LedgerEntry[] {
    return this.entries.filter((e) => e.seq > mark);
  }

  /** Resolves once every refusal after `mark` has been claimed by an event, or after `timeoutMs`. */
  async whenClaimed(mark: number, timeoutMs: number): Promise<void> {
    const pending = () => this.since(mark).some((e) => e.claim === undefined);
    if (!pending()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changed.delete(check);
        resolve();
      };
      const check = () => {
        if (!pending()) {
          done();
        }
      };
      const timer = setTimeout(done, timeoutMs);
      this.changed.add(check);
    });
  }

  private notify(): void {
    for (const listener of [...this.changed]) {
      listener();
    }
  }
}
