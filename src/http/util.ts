import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessError } from "../core/errors.js";

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(s);
};

export const text = (res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
};

export const png = (res: ServerResponse, data: Buffer, headers: Record<string, string> = {}) => {
  res.writeHead(200, { "content-type": "image/png", "content-length": data.length, "cache-control": "no-store", ...headers });
  res.end(data);
};

const MAX_BODY = 2 * 1024 * 1024;

/** Raw body, capped — nothing legitimate posts megabytes here. */
export async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HarnessError("bad_request", "Body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse a JSON body. Requires a JSON content type: a browser can send
 * `text/plain` cross-origin without a preflight, so accepting it would let any
 * web page the operator visits post to this server.
 */
export function parseJson(req: IncomingMessage, raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    throw new HarnessError("bad_request", "Send JSON with content-type: application/json");
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return { _batch: v };
    if (!v || typeof v !== "object") throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HarnessError("bad_request", "Body must be a JSON object");
  }
}

export function statusFor(e: HarnessError): number {
  switch (e.code) {
    case "bad_request":
    case "no_match":
    case "ambiguous":
    case "stale_ref":
      return 400;
    case "policy_denied":
      return 403;
    case "awaiting_approval":
      return 202;
    case "session_not_found":
    case "device_not_found":
      return 404;
    case "device_busy":
      return 409;
    case "timeout":
      return 408;
    case "budget_exceeded":
      return 429;
    case "unsupported":
      return 501;
    default:
      return 500;
  }
}

/** Loopback or private-network peer: our own tunnel, or a sibling container. */
const PRIVATE =
  /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i;

/**
 * Client address. Behind the tunnel every request arrives from the tunnel
 * container, so without the forwarded address all visitors would share one
 * rate-limit bucket — and anyone could lock the operator out. The forwarded
 * headers are only believed from a loopback or private peer.
 */
export function clientIp(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "";
  if (!PRIVATE.test(direct)) return direct;
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf.trim();
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0]!.trim();
  return direct;
}

/** The base URL this request came in on — used when no public URL is configured. */
export function requestBase(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  return `${proto}://${String(host).split(",")[0]!.trim()}`;
}
