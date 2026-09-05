/**
 * This package's own version, for the `Implementation` info an MCP transport
 * reports at `initialize`.
 *
 * Walked up from the caller's own location rather than a fixed relative path.
 * `bin/multi-memory-mcp.ts` first read this via `join(__dirname, "..",
 * "package.json")`, correct from the source tree (`bin/` is one level under
 * the package root) and wrong once compiled: `tsconfig.build.json` mirrors
 * that same tree one level deeper, under `dist/`, so the fixed path resolved
 * to a nonexistent `dist/package.json`. Walking up is correct from source,
 * from the build, and from inside a real install under someone else's
 * `node_modules/multi-graph-memory/` — three depths, one function, no case
 * that has to be re-measured by hand if the build layout changes again.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function packageVersion(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      return (JSON.parse(readFileSync(candidate, "utf8")) as { version: string }).version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${startDir}`);
    dir = parent;
  }
}
