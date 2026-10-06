import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupHome, makeHome, runCli } from "./support.js";

const SPAWN_TIMEOUT = 30000;

let home: string;

beforeEach(() => {
  home = makeHome();
});

afterEach(() => {
  cleanupHome(home);
});

function storedAllowedOrigins(id: string): unknown {
  const json = JSON.parse(
    readFileSync(join(home, "profiles", id, "profile.json"), "utf8"),
  ) as Record<string, unknown>;
  return json["allowedOrigins"];
}

describe("anyb profile add --allow", () => {
  it(
    "writes the comma-separated list to profile.json as allowedOrigins",
    () => {
      const result = runCli(
        [
          "profile",
          "add",
          "work",
          "chromium",
          "--allow",
          "example.com,*.example.com",
        ],
        home,
      );
      expect(result.status).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "example.com",
        "*.example.com",
      ]);
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile add without --allow", () => {
  it(
    "writes allowedOrigins: null (no restriction) to profile.json",
    () => {
      const result = runCli(["profile", "add", "work", "chromium"], home);
      expect(result.status).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toBeNull();
    },
    SPAWN_TIMEOUT,
  );
});

describe("allowed-sites validation", () => {
  function addWith(list: string) {
    return runCli(
      ["profile", "add", "work", "chromium", "--allow", list],
      home,
    );
  }

  it(
    "rejects an empty entry with exit 2, a one-line hint, and creates nothing",
    () => {
      const result = addWith("example.com,,*.example.com");
      expect(result.status).toBe(2);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toMatch(/empty/);
      expect(result.stderr).toContain("*.example.com");
      expect(existsSync(join(home, "profiles", "work-in-chromium"))).toBe(
        false,
      );
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects an entry containing whitespace with exit 2 and a one-line hint",
    () => {
      const result = addWith("example.com,exa mple.com");
      expect(result.status).toBe(2);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toMatch(/whitespace/);
      expect(result.stderr).toContain("*.example.com");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects an entry with a path, whether or not it has a scheme",
    () => {
      for (const entry of ["example.com/x", "https://example.com/x"]) {
        const result = addWith(entry);
        expect(result.status, entry).toBe(2);
        expect(result.stderr.trim().split("\n"), entry).toHaveLength(1);
        expect(result.stderr, entry).toMatch(/path/);
        expect(result.stderr, entry).toContain("*.example.com");
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "accepts the forms upstream matches: a scheme origin, a port, and a wildcard port",
    () => {
      const list = [
        "https://example.com",
        "example.com:8080",
        "http://localhost:*",
        "*.example.com",
      ];
      const result = addWith(list.join(","));
      expect(result.status, result.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual(list);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects other schemes and malformed hosts",
    () => {
      for (const entry of [
        "ftp://example.com",
        "javascript:alert",
        "*",
        "a*b.com",
        "-x.com",
        "example.com:",
      ]) {
        const result = addWith(entry);
        expect(result.status, entry).toBe(2);
        expect(result.stderr, entry).toContain("*.example.com");
      }
    },
    SPAWN_TIMEOUT,
  );
});

describe("allowed-sites validation: what a pattern may match", () => {
  function addWith(list: string) {
    return runCli(
      ["profile", "add", "work", "chromium", "--allow", list],
      home,
    );
  }

  it(
    "stores hosts lowercased, since URL hosts are compared lowercased",
    () => {
      const result = addWith(
        "EXAMPLE.COM,*.Example.ORG:8080,HTTPS://Shop.Example.com",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "example.com",
        "*.example.org:8080",
        "https://shop.example.com",
      ]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects a port outside 1-65535",
    () => {
      for (const entry of [
        "example.com:99999",
        "example.com:0",
        "example.com:65536",
      ]) {
        const result = addWith(entry);
        expect(result.status, entry).toBe(2);
        expect(result.stderr, entry).toMatch(/port/);
        expect(result.stderr.trim().split("\n"), entry).toHaveLength(1);
      }
      expect(addWith("example.com:65535").status).toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects a wildcard over a bare suffix such as *.com, which would allow a whole top-level domain",
    () => {
      for (const entry of ["*.com", "*.localhost", "*."]) {
        const result = addWith(entry);
        expect(result.status, entry).toBe(2);
        expect(result.stderr, entry).toMatch(/two labels/);
        expect(result.stderr.trim().split("\n"), entry).toHaveLength(1);
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects a single-label host, except localhost",
    () => {
      const bad = addWith("intranet");
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/two labels/);

      const ok = addWith("localhost:3000,http://localhost:*");
      expect(ok.status, ok.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "localhost:3000",
        "http://localhost:*",
      ]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects hosts that are not valid, such as an IPv4 address with an octet over 255",
    () => {
      const result = addWith("999.1.1.1");
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/not a host pattern/);
    },
    SPAWN_TIMEOUT,
  );
});

describe("allowed-sites validation: how an entry may be written", () => {
  function addWith(list: string) {
    return runCli(
      ["profile", "add", "work", "chromium", "--allow", list],
      home,
    );
  }

  it(
    "accepts the scheme in any case, and names an unsupported scheme as such",
    () => {
      const ok = addWith("HTTP://example.com");
      expect(ok.status, ok.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "http://example.com",
      ]);

      for (const entry of [
        "ftp://example.com",
        "FILE://example.com",
        "ws://example.com",
      ]) {
        const result = addWith(entry);
        expect(result.status, entry).toBe(2);
        expect(result.stderr, entry).toMatch(/unsupported scheme/);
        expect(result.stderr, entry).not.toMatch(/path/);
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "trims whitespace around each comma-separated entry but not inside one",
    () => {
      const ok = addWith(" a.example.com , b.example.com ");
      expect(ok.status, ok.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "a.example.com",
        "b.example.com",
      ]);
      expect(addWith("a.example.com, ,b.example.com").status).toBe(2);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "accepts a bracketed IPv6 literal with an optional port, stored in URL form",
    () => {
      const list = [
        "[::1]",
        "[::1]:8080",
        "http://[::1]:*",
        "[0:0:0:0:0:0:0:1]",
      ];
      const ok = addWith(list.join(","));
      expect(ok.status, ok.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "[::1]",
        "[::1]:8080",
        "http://[::1]:*",
        "[::1]",
      ]);
      for (const entry of ["[::1", "::1", "[zzz]", "[::1]:99999"]) {
        expect(addWith(entry).status, entry).toBe(2);
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    "accepts an internationalised domain, stored in its ASCII form",
    () => {
      const ok = addWith("Bücher.example,*.bücher.example");
      expect(ok.status, ok.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "xn--bcher-kva.example",
        "*.xn--bcher-kva.example",
      ]);
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile set allowedOrigins", () => {
  function set(value: string) {
    return runCli(
      ["profile", "set", "work-in-chromium", `allowedOrigins=${value}`],
      home,
    );
  }

  beforeEach(() => {
    runCli(
      ["profile", "add", "work", "chromium", "--allow", "example.com"],
      home,
    );
  });

  it(
    "replaces the whole list",
    () => {
      const result = set("a.example.com,*.example.org");
      expect(result.status, result.stderr).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual([
        "a.example.com",
        "*.example.org",
      ]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "rejects an invalid entry with exit 2 and keeps the old list",
    () => {
      const result = set("example.org/x");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("*.example.com");
      expect(storedAllowedOrigins("work-in-chromium")).toEqual(["example.com"]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "clears back to null with an empty value or 'off'",
    () => {
      expect(set("").status).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toBeNull();

      expect(set("example.com").status).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toEqual(["example.com"]);

      expect(set("off").status).toBe(0);
      expect(storedAllowedOrigins("work-in-chromium")).toBeNull();
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile list and allowed sites", () => {
  it(
    "shows the list for a restricted profile and nothing extra for an unrestricted one",
    () => {
      runCli(["profile", "add", "open", "chromium"], home);
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
      const result = runCli(["profile", "list"], home);
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split("\n");
      const pinned = lines.find((l) => l.startsWith("pinned-in-chromium"));
      const open = lines.find((l) => l.startsWith("open-in-chromium"));
      // The list is a column of the table, and an unrestricted profile
      // shows a dash there.
      expect(pinned).toMatch(/example\.com,\*\.example\.com$/);
      expect(open).toMatch(/^open-in-chromium\s+chromium\s+false\s+-$/);
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile add usage", () => {
  it(
    "shows --allow beside --headless and says what an entry covers",
    () => {
      const result = runCli(["profile", "add"], home);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("[--headless]");
      expect(result.stderr).toContain("[--allow <list>]");
      expect(result.stderr).toMatch(/subdomains/);
      expect(result.stderr).toMatch(/port/);
    },
    SPAWN_TIMEOUT,
  );
});

describe("anyb profile list with a hand-edited, malformed allowedOrigins", () => {
  it(
    "still lists the profile and says its list is unreadable",
    () => {
      expect(
        runCli(["profile", "add", "pinned", "chromium"], home).status,
      ).toBe(0);
      const file = join(home, "profiles", "pinned-in-chromium", "profile.json");
      const stored = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      stored["allowedOrigins"] = "127.0.0.1:1234";
      writeFileSync(file, JSON.stringify(stored));

      const result = runCli(["profile", "list"], home);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("pinned-in-chromium");
      expect(result.stdout).toMatch(/allowedOrigins.*unreadable/);
    },
    SPAWN_TIMEOUT,
  );
});
