#!/usr/bin/env node
import { readFileSync } from "node:fs";

const USAGE = `usage: anyb <command>

options:
  -v, --version   print the version
  -h, --help      print this message
`;

function readVersion(): string {
  // Resolves to the package root from both src/ and dist/.
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
  return pkg.version;
}

function main(argv: string[]): number {
  const [command] = argv;
  if (command === "--version" || command === "-v") {
    console.log(readVersion());
    return 0;
  }
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  console.error(`anyb: unknown command '${command}'\n\n${USAGE}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
