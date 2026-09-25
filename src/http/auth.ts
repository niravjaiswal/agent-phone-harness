import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { clientIp } from "./util.js";

/**
 * Two principals, never interchangeable.
 *
 *  agent    — drives the phone: MCP, sessions, devices.
 *  operator — the human: approvals, secrets, takeover, configuration.
 *
 * The operator can do everything an agent's approvals depend on, so an agent
 * holding the operator credential could approve its own payment. The server
 * therefore refuses to start with equal tokens and refuses the operator token
 * on agent routes — a pasted-the-wrong-token mistake fails loudly instead of
 * silently handing the agent the keys.
 */
export type Principal = "agent" | "operator" | "none";

export const COOKIE = "ap_op";
/** Required on cookie-authenticated writes. A cross-site form cannot set it. */
export const CSRF_HEADER = "x-agent-phone";

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface AuthConfig {
  /** Undefined only in explicit no-auth loopback mode. */
  agentToken?: string;
  operatorToken?: string;
  cookieSecret: string;
  /** Operator cookies expire after this long. Default 7 days. */
  cookieTtlMs?: number;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim();
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return out;
}

export class Auth {
  private failures = new Map<string, { count: number; since: number }>();

  constructor(private cfg: AuthConfig) {}

  /** Rotation: the old agent token stops working immediately. */
  setAgentToken(t: string): void {
    this.cfg.agentToken = t;
  }

  get open(): boolean {
    return !this.cfg.agentToken && !this.cfg.operatorToken;
  }

  /** Who is calling, by bearer token or operator cookie. */
  identify(req: IncomingMessage): { principal: Principal; via?: "bearer" | "cookie" } {
    const t = bearer(req);
    if (t) {
      if (this.cfg.operatorToken && eq(t, this.cfg.operatorToken)) return { principal: "operator", via: "bearer" };
      if (this.cfg.agentToken && eq(t, this.cfg.agentToken)) return { principal: "agent", via: "bearer" };
      return { principal: "none" };
    }
    const c = cookies(req).get(COOKIE);
    if (c && this.verifyCookie(c)) return { principal: "operator", via: "cookie" };
    return { principal: "none" };
  }

  checkOperatorToken(token: string): boolean {
    return Boolean(this.cfg.operatorToken && eq(token, this.cfg.operatorToken));
  }

  /** `exp.signature` — stateless, so a restart does not log the operator out. */
  issueCookie(now = Date.now()): string {
    const exp = String(now + (this.cfg.cookieTtlMs ?? 7 * 86_400_000));
    return `${exp}.${this.sign(exp)}`;
  }

  private sign(v: string): string {
    // Bound to the operator token: rotating it invalidates every panel session.
    return createHmac("sha256", this.cfg.cookieSecret)
      .update(`${v}|${this.cfg.operatorToken ?? ""}`)
      .digest("base64url");
  }

  private verifyCookie(v: string): boolean {
    const [exp, sig] = v.split(".");
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    if (Number(exp) < Date.now()) return false;
    return eq(sig, this.sign(exp));
  }

  cookieHeader(value: string, secure: boolean, maxAgeSec?: number): string {
    return [
      `${COOKIE}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      ...(secure ? ["Secure"] : []),
      `Max-Age=${maxAgeSec ?? Math.floor((this.cfg.cookieTtlMs ?? 7 * 86_400_000) / 1000)}`,
    ].join("; ");
  }

  /** Blunt online guessing of the operator token. 10 failures a minute per address. */
  throttled(req: IncomingMessage): boolean {
    const ip = clientIp(req);
    const f = this.failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > 60_000) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= 10;
  }

  recordFailure(req: IncomingMessage): void {
    const ip = clientIp(req);
    const f = this.failures.get(ip);
    if (!f || Date.now() - f.since > 60_000) this.failures.set(ip, { count: 1, since: Date.now() });
    else f.count++;
  }
}

/**
 * A browser always sends Origin on cross-origin requests. Refusing a mismatch
 * closes cross-site request forgery for every route in one place.
 */
export function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return Boolean(origin); // "null" origin: sandboxed/opaque — refuse
  try {
    const o = new URL(origin);
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
    return o.host !== host.split(",")[0]!.trim();
  } catch {
    return true;
  }
}

/** In no-auth mode, only accept loopback Host headers — defeats DNS rebinding. */
export function loopbackHost(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? "").toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}
