import { createHash } from "node:crypto";
import { loadConfig, type ImapConfig, type OperatorConfig } from "../config.js";
import { logger } from "../logger.js";
import { secrets, type SecretStore } from "../secrets.js";
import type { Device } from "../types.js";
import { ImapSource } from "./imap.js";
import { inbox as defaultInbox, type Inbox } from "./inbox.js";
import type { InboundMessage, MessageSource, ReadOptions } from "./types.js";

export * from "./types.js";
export { Inbox, inbox } from "./inbox.js";
export { findOtp, otpCandidates } from "./otp.js";
export { ImapClient, ImapSource } from "./imap.js";
export { parseEmail } from "./mime.js";
export * from "./webhooks.js";

const log = logger("messages");

const short = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** SMS stored on the device itself (emulator injection, a real SIM). */
export class DeviceSmsSource implements MessageSource {
  readonly name = "device-sms";
  constructor(private device: Device) {}
  async read(opts: ReadOptions): Promise<InboundMessage[]> {
    if (!this.device.readSms) return [];
    return (await this.device.readSms({ limit: opts.limit, sinceMs: opts.sinceMs })).map((m) => ({
      ...m,
      id: m.id ?? short(`${m.from}|${m.timestamp}|${m.body}`),
      origin: "device-sms" as const,
      receivedAt: m.timestamp,
    }));
  }
}

/** The notification shade — catches in-app push codes and SMS when the SMS provider is unreadable. */
export class NotificationSource implements MessageSource {
  readonly name = "notification";
  constructor(private device: Device) {}
  async read(opts: ReadOptions): Promise<InboundMessage[]> {
    if (!this.device.readNotifications) return [];
    const out: InboundMessage[] = [];
    for (const n of await this.device.readNotifications({ limit: opts.limit })) {
      if (n.timestamp && n.timestamp < opts.sinceMs) continue;
      const body = [n.title, n.text].filter(Boolean).join(" ");
      const ts = n.timestamp ?? Date.now();
      out.push({
        id: short(`${n.pkg}|${n.timestamp ?? ""}|${body}`),
        origin: "notification",
        from: n.title ?? n.pkg,
        body,
        timestamp: ts,
        receivedAt: ts,
      });
    }
    return out;
  }
}

/** One IMAP source per mailbox, so its rate-limit cache survives across sessions. */
const imapSources = new Map<string, ImapSource>();
function imapFor(cfg: ImapConfig, store: SecretStore): ImapSource {
  const key = `${cfg.user}@${cfg.host}:${cfg.port ?? 993}/${cfg.mailbox ?? "INBOX"}|${cfg.fromContains ?? ""}`;
  let s = imapSources.get(key);
  if (!s) {
    s = new ImapSource(cfg, () => store.get(cfg.passwordSecret ?? "imap_password"));
    imapSources.set(key, s);
  }
  return s;
}

export interface SourceDeps {
  config?: OperatorConfig;
  secretStore?: SecretStore;
  inbox?: Inbox;
}

/** Every place a code could arrive for this device, given the operator's configuration. */
export function defaultSources(device: Device, deps: SourceDeps = {}): MessageSource[] {
  const cfg = deps.config ?? loadConfig();
  const out: MessageSource[] = [];
  if (device.readSms) out.push(new DeviceSmsSource(device));
  if (device.readNotifications) out.push(new NotificationSource(device));
  out.push(deps.inbox ?? defaultInbox);
  if (cfg.sources.imap) out.push(imapFor(cfg.sources.imap, deps.secretStore ?? secrets));
  return out;
}

export interface Collected {
  messages: InboundMessage[];
  /** A broken source (IMAP down) must not hide the others; failures are reported, not thrown. */
  errors: { source: string; error: string }[];
}

export async function collectMessages(sources: MessageSource[], opts: ReadOptions): Promise<Collected> {
  const errors: Collected["errors"] = [];
  const lists = await Promise.all(
    sources.map((s) =>
      s.read(opts).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log.debug(`${s.name} read failed`, msg);
        errors.push({ source: s.name, error: msg });
        return [] as InboundMessage[];
      }),
    ),
  );
  const messages = lists
    .flat()
    .filter((m) => m.receivedAt >= opts.sinceMs)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, opts.limit);
  return { messages, errors };
}
