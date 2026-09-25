import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, paths } from "../paths.js";
import type { InboundMessage, MessageSource, ReadOptions } from "./types.js";

export interface InboxOptions {
  /** Drop messages older than this. OTPs are sensitive and short-lived. Default 72h. */
  maxAgeMs?: number;
  /** Keep at most this many. Default 500. */
  maxCount?: number;
}

/**
 * Messages pushed in from outside the device: SMS provider webhooks, a relay
 * phone, a manual test message.
 *
 * An append-only JSONL file rather than memory, because the process receiving
 * the webhook (the HTTP server) is often not the process waiting for the code
 * (a stdio MCP server on the same machine).
 */
export class Inbox implements MessageSource {
  readonly name = "inbox";
  private listeners = new Set<(m: InboundMessage) => void>();

  constructor(
    private file: string = paths.inbox,
    private opts: InboxOptions = {},
  ) {}

  private readAll(): InboundMessage[] {
    if (!existsSync(this.file)) return [];
    const out: InboundMessage[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as InboundMessage);
      } catch {
        /* a torn write from a crash; skip the line */
      }
    }
    return out;
  }

  /** Store a message. Returns undefined if it is a duplicate (providers retry webhooks). */
  add(m: Omit<InboundMessage, "receivedAt"> & { receivedAt?: number }): InboundMessage | undefined {
    const all = this.readAll();
    if (all.some((x) => x.origin === m.origin && x.id === m.id)) return undefined;
    const full: InboundMessage = { ...m, receivedAt: m.receivedAt ?? Date.now() };
    ensureDir(dirname(this.file));
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    if (all.length + 1 > (this.opts.maxCount ?? 500) * 1.2) this.compact();
    for (const l of this.listeners) l(full);
    return full;
  }

  list(opts: Partial<ReadOptions> = {}): InboundMessage[] {
    const cutoff = Math.max(opts.sinceMs ?? 0, Date.now() - (this.opts.maxAgeMs ?? 72 * 3600_000));
    return this.readAll()
      .filter((m) => m.receivedAt >= cutoff)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, opts.limit ?? 50);
  }

  async read(opts: ReadOptions): Promise<InboundMessage[]> {
    return this.list(opts);
  }

  /** Rewrite the file keeping only what retention allows. */
  compact(): void {
    const keep = this.list({ limit: this.opts.maxCount ?? 500 }).reverse();
    writeFileSync(this.file, keep.map((m) => JSON.stringify(m)).join("\n") + (keep.length ? "\n" : ""), {
      mode: 0o600,
    });
  }

  clear(): void {
    if (existsSync(this.file)) writeFileSync(this.file, "", { mode: 0o600 });
  }

  onMessage(fn: (m: InboundMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const inbox = new Inbox();
