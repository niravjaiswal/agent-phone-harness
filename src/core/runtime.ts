import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths } from "./paths.js";

/**
 * Facts about the running server that other processes need — chiefly the
 * public URL a quick tunnel was given, so an approval raised by a stdio MCP
 * process can still link to the panel.
 */
export interface RuntimeState {
  pid: number;
  startedAt: number;
  localUrl: string;
  publicUrl?: string;
}

const FILE = () => join(paths.home, "server.json");

export function writeRuntime(state: RuntimeState): void {
  ensureDir(paths.home);
  writeFileSync(FILE(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readRuntime(): RuntimeState | undefined {
  if (!existsSync(FILE())) return undefined;
  try {
    const s = JSON.parse(readFileSync(FILE(), "utf8")) as RuntimeState;
    // A stale file from a server that is gone is worse than none.
    try {
      process.kill(s.pid, 0);
    } catch {
      return undefined;
    }
    return s;
  } catch {
    return undefined;
  }
}
