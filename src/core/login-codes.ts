import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths } from "./paths.js";

/**
 * One-time panel sign-in links.
 *
 * Printing the operator token inside a URL would leave it in browser history
 * forever. Instead the CLI mints a short-lived, single-use code; the panel
 * trades it for a session cookie. File-backed so the CLI (often `docker
 * compose exec`) and the server need not share a process.
 */

interface Entry {
  hash: string;
  expiresAt: number;
  used: boolean;
}

const FILE = () => join(paths.home, "login-codes.json");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function read(): Entry[] {
  if (!existsSync(FILE())) return [];
  try {
    return (JSON.parse(readFileSync(FILE(), "utf8")) as Entry[]).filter((e) => e.expiresAt > Date.now() && !e.used);
  } catch {
    return [];
  }
}

function write(entries: Entry[]): void {
  ensureDir(paths.home);
  writeFileSync(FILE(), JSON.stringify(entries), { mode: 0o600 });
}

export function mintLoginCode(ttlMs = 15 * 60_000): string {
  const code = randomBytes(18).toString("base64url");
  write([...read(), { hash: sha(code), expiresAt: Date.now() + ttlMs, used: false }]);
  return code;
}

export function redeemLoginCode(code: string): boolean {
  const entries = read();
  const h = Buffer.from(sha(code));
  const hit = entries.find((e) => {
    const x = Buffer.from(e.hash);
    return x.length === h.length && timingSafeEqual(x, h);
  });
  if (!hit) return false;
  hit.used = true;
  write(entries.filter((e) => !e.used));
  return true;
}
