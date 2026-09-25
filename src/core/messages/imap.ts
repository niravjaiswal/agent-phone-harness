import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ImapConfig } from "../config.js";
import { parseEmail } from "./mime.js";
import type { InboundMessage, MessageSource, ReadOptions } from "./types.js";

/**
 * A deliberately tiny IMAP client: LOGIN, EXAMINE, SEARCH, FETCH, LOGOUT.
 *
 * Enough to read verification emails and Google Voice SMS forwarded to Gmail,
 * with no dependency. EXAMINE (read-only select) plus BODY.PEEK means reading
 * never marks anything as seen in the operator's mailbox.
 */

export class ImapError extends Error {}

interface Item {
  text: string;
  literals: Buffer[];
}

export interface ImapConnectOptions {
  host: string;
  port?: number;
  /** Default true (port 993). Plain TCP exists for tests. */
  tls?: boolean;
  timeoutMs?: number;
}

const quote = (s: string): string => {
  if (/[\r\n]/.test(s)) throw new ImapError("IMAP credentials may not contain line breaks");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const imapDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};

export class ImapClient {
  private buf = Buffer.alloc(0);
  private tag = 0;
  private waiters: (() => void)[] = [];
  private closed = false;
  private failure?: Error;

  private constructor(
    private sock: Socket,
    private timeoutMs: number,
  ) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    sock.on("error", (e) => {
      this.failure = e;
      this.wake();
    });
    sock.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  static async connect(o: ImapConnectOptions): Promise<ImapClient> {
    const port = o.port ?? (o.tls === false ? 143 : 993);
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s =
        o.tls === false
          ? netConnect({ host: o.host, port })
          : tlsConnect({ host: o.host, port, servername: o.host });
      const t = setTimeout(() => {
        s.destroy();
        reject(new ImapError(`connecting to ${o.host}:${port} timed out`));
      }, o.timeoutMs ?? 15_000);
      s.once(o.tls === false ? "connect" : "secureConnect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const c = new ImapClient(sock, o.timeoutMs ?? 15_000);
    const greeting = await c.readItem(Date.now() + c.timeoutMs);
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) {
      sock.destroy();
      throw new ImapError(`unexpected greeting: ${greeting.text}`);
    }
    return c;
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async waitData(deadline: number): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new ImapError("connection closed by server");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ImapError("IMAP server did not respond in time");
    await new Promise<void>((r) => {
      const t = setTimeout(r, remaining);
      this.waiters.push(() => {
        clearTimeout(t);
        r();
      });
    });
  }

  private async readLine(deadline: number): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 2);
        return line;
      }
      await this.waitData(deadline);
    }
  }

  private async readBytes(n: number, deadline: number): Promise<Buffer> {
    while (this.buf.length < n) await this.waitData(deadline);
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** One response, with any `{n}` literals it carries read out as raw bytes. */
  private async readItem(deadline: number): Promise<Item> {
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const line = await this.readLine(deadline);
      const m = /\{(\d+)\}$/.exec(line);
      if (m) {
        text += `${line}\n`;
        literals.push(await this.readBytes(Number(m[1]), deadline));
        continue;
      }
      return { text: text + line, literals };
    }
  }

  async command(cmd: string): Promise<Item[]> {
    const tag = `A${++this.tag}`;
    this.sock.write(`${tag} ${cmd}\r\n`);
    const deadline = Date.now() + this.timeoutMs;
    const out: Item[] = [];
    for (;;) {
      const item = await this.readItem(deadline);
      if (item.text.startsWith(`${tag} `)) {
        const rest = item.text.slice(tag.length + 1);
        if (!/^OK/i.test(rest)) {
          // Never echo the command: for LOGIN it contains the password.
          throw new ImapError(`${cmd.split(" ")[0]} failed: ${rest}`);
        }
        return out;
      }
      out.push(item);
    }
  }

  login(user: string, pass: string) {
    return this.command(`LOGIN ${quote(user)} ${quote(pass)}`);
  }

  examine(mailbox = "INBOX") {
    return this.command(`EXAMINE ${quote(mailbox)}`);
  }

  async search(criteria: string): Promise<number[]> {
    const items = await this.command(`SEARCH ${criteria}`);
    const out: number[] = [];
    for (const it of items) {
      const m = /^\* SEARCH\s*(.*)$/i.exec(it.text);
      if (m?.[1]) out.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number));
    }
    return out;
  }

  /** Raw RFC 822 bytes plus the server's arrival time, without setting \Seen. */
  async fetch(seqs: number[]): Promise<{ seq: number; internalDate?: number; raw: Buffer }[]> {
    if (!seqs.length) return [];
    const items = await this.command(`FETCH ${seqs.join(",")} (INTERNALDATE BODY.PEEK[])`);
    const out: { seq: number; internalDate?: number; raw: Buffer }[] = [];
    for (const it of items) {
      const m = /^\* (\d+) FETCH/i.exec(it.text);
      if (!m || !it.literals[0]) continue;
      const d = /INTERNALDATE "([^"]+)"/i.exec(it.text);
      const parsed = d ? Date.parse(d[1]!.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$1 $2 $3")) : NaN;
      out.push({
        seq: Number(m[1]),
        ...(Number.isFinite(parsed) ? { internalDate: parsed } : {}),
        raw: it.literals[0],
      });
    }
    return out;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      /* the server may hang up first */
    }
    this.sock.end();
  }
}

export interface ImapSourceOptions {
  /** Do not hit the server more often than this; OTP polling runs every couple of seconds. */
  minIntervalMs?: number;
  tls?: boolean;
  timeoutMs?: number;
}

/**
 * Email as a message source: verification emails, and Google Voice texts
 * (Voice → forward SMS to email → Gmail → here).
 */
export class ImapSource implements MessageSource {
  readonly name = "imap";
  private cache?: { at: number; sinceMs: number; messages: InboundMessage[] };

  constructor(
    private cfg: ImapConfig,
    private password: () => string,
    private opts: ImapSourceOptions = {},
  ) {}

  async read(opts: ReadOptions): Promise<InboundMessage[]> {
    const now = Date.now();
    const c = this.cache;
    if (c && now - c.at < (this.opts.minIntervalMs ?? 8000) && c.sinceMs <= opts.sinceMs) {
      return c.messages.filter((m) => m.receivedAt >= opts.sinceMs).slice(0, opts.limit);
    }

    const client = await ImapClient.connect({
      host: this.cfg.host,
      ...(this.cfg.port ? { port: this.cfg.port } : {}),
      ...(this.opts.tls !== undefined ? { tls: this.opts.tls } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
    });
    try {
      await client.login(this.cfg.user, this.password());
      await client.examine(this.cfg.mailbox ?? "INBOX");
      // SINCE has day granularity and ignores time zones; look back a day and filter precisely below.
      const seqs = await client.search(`SINCE ${imapDate(opts.sinceMs - 86_400_000)}`);
      const recent = seqs.slice(-Math.min(opts.limit, 25));
      const fetched = await client.fetch(recent);
      const messages: InboundMessage[] = [];
      for (const f of fetched) {
        const e = parseEmail(f.raw);
        const receivedAt = f.internalDate ?? e.date ?? now;
        if (receivedAt < opts.sinceMs) continue;
        if (this.cfg.fromContains && !e.from.toLowerCase().includes(this.cfg.fromContains.toLowerCase())) continue;
        messages.push({
          id: e.messageId ?? `imap-${f.seq}-${receivedAt}`,
          origin: "imap",
          from: e.from,
          subject: e.subject,
          // Codes are as often in the subject as in the body.
          body: `${e.subject}\n${e.text}`.slice(0, 2000),
          timestamp: e.date ?? receivedAt,
          receivedAt,
        });
      }
      messages.sort((a, b) => b.receivedAt - a.receivedAt);
      this.cache = { at: now, sinceMs: opts.sinceMs, messages };
      return messages.slice(0, opts.limit);
    } finally {
      await client.logout();
    }
  }
}
