import { ensureDaemon } from "./connect.js";
import { formatHelloLine } from "./hello.js";
import type { AnybrowserPaths } from "./paths.js";
import { readVersion } from "./version.js";

/**
 * Runs the stdio-to-socket proxy: `anyb mcp`. Spawns the daemon if needed,
 * sends the hello line, then pipes stdin/stdout to/from the daemon socket.
 * Only the MCP JSON-RPC stream may touch stdout; everything else goes to
 * stderr.
 */
export async function runProxy(paths: AnybrowserPaths): Promise<number> {
  let socket;
  try {
    socket = await ensureDaemon(paths);
  } catch (error) {
    process.stderr.write(
      `anyb: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  socket.write(formatHelloLine("mcp", readVersion()));

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    socket.on("close", () => finish(0));
    socket.on("error", (error) => {
      process.stderr.write(`anyb: daemon connection error: ${error.message}\n`);
      finish(1);
    });

    process.stdin.on("end", () => {
      socket.end();
    });

    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
}
