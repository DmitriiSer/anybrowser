import { readFileSync } from "node:fs";

/**
 * Reads the package version from package.json, resolved relative to this
 * module so it works both from src/ (ts-node/vitest) and dist/ (built CLI).
 */
export function readVersion(): string {
  // Test-only seam: lets a test run a daemon and a proxy that disagree about
  // the version. Never set outside tests.
  const override = process.env["ANYBROWSER_TEST_VERSION"];
  if (override !== undefined && override !== "") {
    return override;
  }
  // Resolves to the package root from both src/ and dist/.
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
  return pkg.version;
}
