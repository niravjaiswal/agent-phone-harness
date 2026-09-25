import type { IncomingMessage, ServerResponse } from "node:http";
import type { OperatorConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import {
  parseRelay, parseTelnyx, parseTwilio, verifyRelay, verifyTelnyx, verifyTwilio, WebhookAuthError,
  type Inbox,
} from "../core/messages/index.js";
import { json, text } from "./util.js";

const log = logger("hooks");

export interface HookContext {
  inbox: Inbox;
  config: () => OperatorConfig;
  /** Every base URL this server might have been called on — Twilio signs the exact one it used. */
  baseUrls: (req: IncomingMessage) => string[];
}

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function formOrJson(req: IncomingMessage, raw: string): Record<string, unknown> {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Inbound SMS. Public routes — they authenticate by provider signature or
 * relay token instead of a bearer token, because Telnyx and Twilio cannot be
 * told to send one.
 */
export async function hookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  raw: string,
  ctx: HookContext,
): Promise<boolean> {
  const m = /^\/hooks\/sms\/(telnyx|twilio|relay)\/?$/.exec(url.pathname);
  if (!m) return false;
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "POST only" });
    return true;
  }
  const provider = m[1]!;
  const cfg = ctx.config().sources;

  try {
    if (provider === "telnyx") {
      if (!cfg.telnyxPublicKey) {
        json(res, 503, { ok: false, error: "Telnyx is not configured on this phone (set its public key in the panel)" });
        return true;
      }
      verifyTelnyx(
        raw,
        {
          signature: req.headers["telnyx-signature-ed25519"] as string | undefined,
          timestamp: req.headers["telnyx-timestamp"] as string | undefined,
        },
        cfg.telnyxPublicKey,
      );
      const msg = parseTelnyx(raw);
      if (msg && ctx.inbox.add(msg)) log.info(`SMS from ${msg.from} via Telnyx`);
      json(res, 200, { ok: true });
      return true;
    }

    if (provider === "twilio") {
      if (!cfg.twilioAuthToken) {
        json(res, 503, { ok: false, error: "Twilio is not configured on this phone (set its auth token in the panel)" });
        return true;
      }
      const params = Object.fromEntries(new URLSearchParams(raw));
      const sig = req.headers["x-twilio-signature"] as string | undefined;
      const candidates = ctx.baseUrls(req).map((b) => `${b}${url.pathname}${url.search}`);
      let lastErr: unknown;
      let ok = false;
      for (const u of candidates) {
        try {
          verifyTwilio(cfg.twilioAuthToken, u, params, sig);
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!ok) throw lastErr instanceof Error ? lastErr : new WebhookAuthError("twilio signature does not verify");
      const msg = parseTwilio(params);
      if (ctx.inbox.add(msg)) log.info(`SMS from ${msg.from} via Twilio`);
      text(res, 200, TWIML_EMPTY, "text/xml");
      return true;
    }

    // relay
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    verifyRelay(cfg.relayToken, auth ?? url.searchParams.get("token") ?? undefined);
    const msg = parseRelay(formOrJson(req, raw));
    if (ctx.inbox.add(msg)) log.info(`SMS from ${msg.from} via relay`);
    json(res, 200, { ok: true });
    return true;
  } catch (e) {
    if (e instanceof WebhookAuthError) {
      log.warn(`rejected ${provider} webhook: ${e.message}`);
      json(res, 401, { ok: false, error: e.message });
      return true;
    }
    if (e instanceof SyntaxError) {
      json(res, 400, { ok: false, error: "malformed body" });
      return true;
    }
    throw e;
  }
}
