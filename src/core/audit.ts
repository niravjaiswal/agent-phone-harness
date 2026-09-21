import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureDir } from "./paths.js";
import { secrets } from "./secrets.js";

export interface TraceEvent {
  ts: number;
  seq: number;
  sessionId: string;
  kind: string;
  ok: boolean;
  /** Action arguments, already redacted. */
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  screenshot?: string;
  screenHash?: string;
}

/**
 * Append-only trace per session plus screenshot artifacts.
 *
 * If an agent does something surprising at 3am on a phone holding real
 * accounts, you need the tape. Everything is redacted through the secret store
 * on the way in.
 */
export class AuditLog {
  readonly dir: string;
  private seq = 0;

  constructor(readonly sessionId: string, root: string = paths.sessions) {
    this.dir = ensureDir(join(root, sessionId));
    ensureDir(join(this.dir, "screens"));
  }

  get tracePath(): string {
    return join(this.dir, "trace.jsonl");
  }

  meta(data: Record<string, unknown>): void {
    writeFileSync(join(this.dir, "session.json"), JSON.stringify(data, null, 2));
    // Open the trace immediately so `agent-phone trace <id>` works even for a session
    // that failed before its first successful action.
    this.record({ kind: "session_start", ok: true, result: { device: data.device, policy: data.policy } });
  }

  record(ev: Omit<TraceEvent, "ts" | "seq" | "sessionId">): TraceEvent {
    const full: TraceEvent = {
      ts: Date.now(),
      seq: ++this.seq,
      sessionId: this.sessionId,
      ...ev,
    };
    const line = secrets.redact(JSON.stringify(full));
    appendFileSync(this.tracePath, `${line}\n`);
    return full;
  }

  /** Persist a screenshot artifact and return its relative path. */
  saveScreen(png: Buffer, tag: string): string {
    const name = `${String(this.seq).padStart(4, "0")}-${tag}.png`;
    const p = join(this.dir, "screens", name);
    writeFileSync(p, png);
    return p;
  }
}
