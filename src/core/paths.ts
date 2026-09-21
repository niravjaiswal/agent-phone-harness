import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const HOME_DIR = process.env.PHONE_HOME ?? join(homedir(), ".agent-phone");

export const paths = {
  home: HOME_DIR,
  secrets: join(HOME_DIR, "secrets.json"),
  policy: join(HOME_DIR, "policy.json"),
  approvals: join(HOME_DIR, "approvals"),
  sessions: join(HOME_DIR, "sessions"),
};

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}
