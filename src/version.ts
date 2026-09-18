import { readFileSync } from "node:fs";

/**
 * Reads the package version from package.json, resolved relative to this
 * module so it works both from src/ (ts-node/vitest) and dist/ (built CLI).
 */
export function readVersion(): string {
  // Resolves to the package root from both src/ and dist/.
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
  return pkg.version;
}
