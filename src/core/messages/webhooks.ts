import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { InboundMessage } from "./types.js";

/**
 * Parsers and signature checks for inbound-SMS webhooks.
 *
 * Every endpoint that accepts a message must authenticate it: a forged SMS is
 * a forged one-time code, and the agent would type it.
 */

type Incoming = Omit<InboundMessage, "receivedAt">;

export class WebhookAuthError extends Error {}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ------------------------------------------------------------------ Telnyx

/** DER prefix that turns a raw 32-byte Ed25519 key into SPKI, which node:crypto can load. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Telnyx signs `${timestamp}|${rawBody}` with Ed25519. The public key is shown
 * in the Telnyx portal (Keys & Credentials → Public Key), base64.
 */
export function verifyTelnyx(
  rawBody: string,
  headers: { signature?: string; timestamp?: string },
  publicKeyB64: string,
  opts: { now?: number; toleranceSec?: number } = {},
): void {
  if (!headers.signature || !headers.timestamp) {
    throw new WebhookAuthError("missing telnyx-signature-ed25519 / telnyx-timestamp headers");
  }
  const ts = Number(headers.timestamp);
  const now = (opts.now ?? Date.now()) / 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (opts.toleranceSec ?? 300)) {
    throw new WebhookAuthError("telnyx timestamp outside tolerance (replay?)");
  }
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new WebhookAuthError("telnyx public key must be 32 bytes, base64");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  const ok = verify(null, Buffer.from(`${headers.timestamp}|${rawBody}`), key, Buffer.from(headers.signature, "base64"));
  if (!ok) throw new WebhookAuthError("telnyx signature does not verify");
}

interface TelnyxEvent {
  data?: {
    event_type?: string;
    id?: string;
    occurred_at?: string;
    payload?: {
      id?: string;
      direction?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: { phone_number?: string }[];
      received_at?: string;
    };
  };
}

/** Returns undefined for events that are not an inbound message (delivery receipts etc). */
export function parseTelnyx(rawBody: string): Incoming | undefined {
  const ev = JSON.parse(rawBody) as TelnyxEvent;
  const d = ev.data;
  if (d?.event_type !== "message.received" || !d.payload) return undefined;
  const p = d.payload;
  const ts = Date.parse(p.received_at ?? d.occurred_at ?? "");
  return {
    id: p.id ?? d.id ?? `telnyx-${Date.now()}`,
    origin: "telnyx",
    from: p.from?.phone_number ?? "unknown",
    ...(p.to?.[0]?.phone_number ? { to: p.to[0].phone_number } : {}),
    body: p.text ?? "",
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
  };
}

// ------------------------------------------------------------------ Twilio

/**
 * X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + sorted(key+value)...)).
 *
 * `url` must be exactly what Twilio requested — scheme, host, path and query —
 * which is why the server builds it from the configured public URL rather
 * than from the (tunnel-rewritten) Host header when it can.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilio(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): void {
  if (!signature) throw new WebhookAuthError("missing X-Twilio-Signature");
  if (!safeEqual(twilioSignature(authToken, url, params), signature)) {
    throw new WebhookAuthError("twilio signature does not verify (check the public URL matches the webhook URL)");
  }
}

export function parseTwilio(params: Record<string, string>): Incoming {
  return {
    id: params.MessageSid ?? params.SmsSid ?? `twilio-${Date.now()}`,
    origin: "twilio",
    from: params.From ?? "unknown",
    ...(params.To ? { to: params.To } : {}),
    body: params.Body ?? "",
    timestamp: Date.now(),
  };
}

// ------------------------------------------------------------------ relay phone

export function verifyRelay(expected: string | undefined, presented: string | undefined): void {
  if (!expected) throw new WebhookAuthError("no relay token is configured; generate one in the panel or with `agent-phone number relay`");
  if (!presented || !safeEqual(expected, presented)) throw new WebhookAuthError("bad relay token");
}

const pick = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
};

/**
 * A relay is a spare Android phone with a real SIM running an SMS-forwarder
 * app. Those apps disagree on field names, so accept the common spellings.
 */
export function parseRelay(body: Record<string, unknown>): Incoming {
  const from = pick(body, ["from", "sender", "phone", "phoneNumber", "From", "address", "number"]) ?? "unknown";
  const text = pick(body, ["body", "text", "message", "msg", "Body", "content", "sms"]) ?? "";
  const tsRaw = pick(body, ["timestamp", "receivedStamp", "sentStamp", "date", "time", "receivedAt"]);
  let ts = tsRaw ? Number(tsRaw) : NaN;
  if (Number.isFinite(ts) && ts < 1e12) ts *= 1000; // seconds → ms
  if (!Number.isFinite(ts)) ts = tsRaw ? Date.parse(tsRaw) : NaN;
  const id =
    pick(body, ["id", "messageId", "message_id"]) ??
    `relay-${from}-${Number.isFinite(ts) ? ts : Date.now()}-${text.length}`;
  return {
    id,
    origin: "relay",
    from,
    body: text,
    ...(pick(body, ["to", "receiver", "sim"]) ? { to: pick(body, ["to", "receiver", "sim"])! } : {}),
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
  };
}
