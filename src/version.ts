import { readFileSync } from "node:fs";

/**
 * Read once from package.json so the CLI, MCP handshake and /health can never
 * disagree. `src/` and `dist/` both sit one level below the package root.
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
