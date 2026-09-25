import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const HOME_DIR = process.env.PHONE_HOME ?? join(homedir(), ".agent-phone");

export const paths = {
  home: HOME_DIR,
  secrets: join(HOME_DIR, "secrets.json"),
  /** Operator policy ceiling. Agents can narrow it, never widen it. */
  policy: process.env.PHONE_POLICY_FILE ?? join(HOME_DIR, "policy.json"),
  /** Tokens, identity, notification channels, message sources. */
  config: join(HOME_DIR, "config.json"),
  approvals: join(HOME_DIR, "approvals"),
  sessions: join(HOME_DIR, "sessions"),
  /** Messages pushed in by webhooks (SMS providers, relay phones). */
  inbox: join(HOME_DIR, "inbox.jsonl"),
  /** What the human operator did through the panel. */
  operatorLog: join(HOME_DIR, "operator.jsonl"),
};

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}
