import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { paths, ensureDir } from "./paths.js";
import { err } from "./errors.js";
import { logger } from "./logger.js";

const log = logger("secrets");

/**
 * Secret values never enter the model's context.
 *
 * The agent references a key (`otp`, `bank_password`); the harness types the
 * value straight onto the device and redacts it from every trace, log line and
 * error message on the way out.
 */
export class SecretStore {
  private values = new Map<string, string>();

  constructor(private file: string = paths.secrets) {
    this.reload();
  }

  reload(): void {
    this.values.clear();

    // Env wins, so containers/CI can inject without writing a file.
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("PHONE_SECRET_") && v) {
        this.values.set(k.slice("PHONE_SECRET_".length).toLowerCase(), v);
      }
    }

    if (!existsSync(this.file)) return;
    const mode = statSync(this.file).mode & 0o777;
    if (mode & 0o077) {
      log.warn(`${this.file} is mode ${mode.toString(8)}; tighten it with chmod 600`);
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") this.values.set(k.toLowerCase(), v);
      }
    } catch (e) {
      log.error(`failed to parse ${this.file}`, (e as Error).message);
    }
  }

  /**
   * Key names only — safe to show an agent.
   *
   * Reloads first: a long-running MCP server must see a secret the operator
   * added a minute ago without being restarted.
   */
  keys(): string[] {
    this.reload();
    return [...this.values.keys()].sort();
  }

  has(key: string): boolean {
    return this.values.has(key.toLowerCase());
  }

  get(key: string): string {
    let v = this.values.get(key.toLowerCase());
    if (v === undefined) {
      // Miss may just mean the store was loaded before the secret existed.
      this.reload();
      v = this.values.get(key.toLowerCase());
    }
    if (v === undefined) {
      throw err("bad_request", `No secret named "${key}"`, {
        hint: `Known keys: ${this.keys().join(", ") || "(none)"}. Add one with \`agent-phone secret set ${key}\`.`,
      });
    }
    return v;
  }

  set(key: string, value: string): void {
    ensureDir(paths.home);
    let existing: Record<string, string> = {};
    if (existsSync(this.file)) {
      try {
        existing = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      } catch {
        existing = {};
      }
    }
    existing[key.toLowerCase()] = value;
    writeFileSync(this.file, JSON.stringify(existing, null, 2), { mode: 0o600 });
    this.values.set(key.toLowerCase(), value);
  }

  /** Remove a file-backed secret. Env-provided secrets can only be removed from the environment. */
  delete(key: string): boolean {
    const k = key.toLowerCase();
    if (!existsSync(this.file)) return false;
    let existing: Record<string, string> = {};
    try {
      existing = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return false;
    }
    if (!(k in existing)) return false;
    delete existing[k];
    writeFileSync(this.file, JSON.stringify(existing, null, 2), { mode: 0o600 });
    this.reload();
    return true;
  }

  /** Key names with where each came from — the panel shows env secrets as read-only. */
  describe(): { key: string; from: "env" | "file" }[] {
    this.reload();
    const env = new Set(
      Object.keys(process.env)
        .filter((k) => k.startsWith("PHONE_SECRET_") && process.env[k])
        .map((k) => k.slice("PHONE_SECRET_".length).toLowerCase()),
    );
    return [...this.values.keys()].sort().map((key) => ({ key, from: env.has(key) ? "env" : "file" }));
  }

  /** Scrub every known secret value out of arbitrary text before it is logged or returned. */
  redact(text: string): string {
    let out = text;
    for (const [k, v] of this.values) {
      if (v.length < 3) continue;
      out = out.split(v).join(`«secret:${k}»`);
    }
    return out;
  }
}

export const secrets = new SecretStore();
