import type { Message } from "../types.js";

/** Where a message came from. Shown to the agent so it can tell a device SMS from a forwarded email. */
export type MessageOrigin =
  | "device-sms"
  | "notification"
  | "telnyx"
  | "twilio"
  | "relay"
  | "imap"
  | "test";

export interface InboundMessage extends Message {
  /** Unique within its origin. */
  id: string;
  origin: MessageOrigin;
  /** The number or address it was sent to, when known. */
  to?: string;
  /** Email subject. */
  subject?: string;
  /** When the harness received it (epoch ms) — the clock `since` filters use. */
  receivedAt: number;
}

export interface ReadOptions {
  sinceMs: number;
  limit: number;
}

export interface MessageSource {
  /** For error reporting: "device-sms", "inbox", "imap"... */
  readonly name: string;
  read(opts: ReadOptions): Promise<InboundMessage[]>;
}
