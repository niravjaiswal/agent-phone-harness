import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { approvals } from "../core/approvals.js";
import { HarnessError } from "../core/errors.js";
import { Harness, type HarnessOptions } from "../core/harness.js";
import { logger } from "../core/logger.js";
import { createPhoneMcpServer } from "../mcp/server.js";
import type { Direction, KeyName, Selector, Target } from "../core/types.js";

const log = logger("http");

export interface ServeOptions extends HarnessOptions {
  port?: number;
  host?: string;
  /**
   * Bearer token required on every request. Without one the server refuses to
   * bind anything but loopback — this endpoint can drive a real phone.
   */
  token?: string;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Record<string, unknown>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

function toTarget(b: Record<string, unknown>): Target {
  if (typeof b.ref === "string") return { ref: b.ref };
  if (b.selector && typeof b.selector === "object") return { selector: b.selector as Selector };
  if (typeof b.x === "number" && typeof b.y === "number") return { point: [b.x, b.y] };
  throw new HarnessError("bad_request", "Give ref, selector, or x+y");
}

function optionalTarget(b: Record<string, unknown>): Target | undefined {
  try {
    return toTarget(b);
  } catch {
    return undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HarnessError("bad_request", "Body must be JSON");
  }
}

/**
 * REST + SSE + MCP-over-HTTP.
 *
 * REST exists for agents that do not speak MCP; the MCP endpoint at /mcp is the
 * same tool surface as the stdio server.
 */
export async function serve(opts: ServeOptions = {}): Promise<{ close: () => Promise<void>; port: number; harness: Harness }> {
  const port = opts.port ?? Number(process.env.PHONE_PORT ?? 8712);
  const token = opts.token ?? process.env.PHONE_API_TOKEN;
  let host = opts.host ?? process.env.PHONE_HOST ?? "127.0.0.1";

  if (!token && host !== "127.0.0.1" && host !== "localhost") {
    log.error(`refusing to bind ${host} without PHONE_API_TOKEN — falling back to loopback`);
    host = "127.0.0.1";
  }

  const harness = new Harness(opts);
  const { server: mcpServer } = createPhoneMcpServer(opts);
  const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await mcpServer.connect(mcpTransport);

  /** SSE listeners, fed by the approval watcher below. */
  const sseClients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(payload);
  };

  const seenApprovals = new Set<string>();
  const watcher = setInterval(() => {
    for (const a of approvals.list({ pendingOnly: true })) {
      if (seenApprovals.has(a.id)) continue;
      seenApprovals.add(a.id);
      broadcast("approval_required", a);
    }
    broadcast("heartbeat", { ts: Date.now() });
  }, 2000);
  watcher.unref();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (e instanceof HarnessError) json(res, statusFor(e), e.toJSON());
      else json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") return json(res, 200, { ok: true, version: "0.1.0" });

    if (token) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) return json(res, 401, { ok: false, error: "unauthorized" });
    }

    // MCP streamable HTTP — same tools as the stdio server.
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await mcpTransport.handleRequest(req, res, body);
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
    const ctx: Ctx = { req, res, url, body };
    const seg = url.pathname.split("/").filter(Boolean);

    if (seg[0] === "devices" && req.method === "GET") {
      return json(res, 200, { devices: await harness.listDevices() });
    }
    if (seg[0] === "doctor" && req.method === "GET") {
      return json(res, 200, { reports: await harness.doctor() });
    }

    if (seg[0] === "approvals") {
      if (req.method === "GET" && seg.length === 1) {
        return json(res, 200, { approvals: approvals.list({ pendingOnly: url.searchParams.get("pending") === "1" }) });
      }
      const id = seg[1];
      if (id && req.method === "POST" && (seg[2] === "approve" || seg[2] === "deny")) {
        const decided = approvals.decide(
          id,
          seg[2] === "approve",
          typeof body.by === "string" ? body.by : "http",
          typeof body.note === "string" ? body.note : undefined,
        );
        if (!decided) return json(res, 404, { ok: false, error: `no approval ${id}` });
        broadcast("approval_decided", decided);
        return json(res, 200, { ok: true, approval: decided });
      }
    }

    if (seg[0] === "sessions") {
      if (req.method === "POST" && seg.length === 1) {
        const session = await harness.createSession({
          ...(typeof body.deviceId === "string" ? { deviceId: body.deviceId } : {}),
          ...(body.policy && typeof body.policy === "object" ? { policy: body.policy } : {}),
        });
        const snap = await session.observe();
        return json(res, 201, { sessionId: session.id, device: session.device.info, screen: session.view(snap) });
      }
      if (req.method === "GET" && seg.length === 1) return json(res, 200, { sessions: harness.list() });

      const id = seg[1];
      if (!id) return json(res, 404, { ok: false, error: "not found" });

      if (req.method === "GET" && seg.length === 2) return json(res, 200, harness.get(id).stats());
      if (req.method === "DELETE" && seg.length === 2) {
        await harness.close(id);
        return json(res, 200, { ok: true });
      }
      if (seg[2] === "screenshot" && req.method === "GET") {
        const shot = await harness.get(id).screenshot({
          marks: url.searchParams.get("marks") === "1",
          ...(url.searchParams.get("maxSize") ? { maxSize: Number(url.searchParams.get("maxSize")) } : {}),
        });
        res.writeHead(200, { "content-type": "image/png", "content-length": shot.data.length });
        res.end(shot.data);
        return;
      }
      if (seg[2] && req.method === "POST") {
        return json(res, 200, await action(harness, id, seg[2], ctx.body));
      }
    }

    json(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
  }

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  log.info(`listening on http://${host}:${boundPort}  (MCP: /mcp, events: /events)${token ? "" : "  [no token — loopback only]"}`);

  return {
    port: boundPort,
    harness,
    close: async () => {
      clearInterval(watcher);
      for (const c of sseClients) c.end();
      await harness.closeAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function statusFor(e: HarnessError): number {
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
    case "timeout":
      return 408;
    case "unsupported":
      return 501;
    default:
      return 500;
  }
}

/** REST action dispatch — mirrors the MCP tool set one-for-one. */
async function action(harness: Harness, sessionId: string, name: string, b: Record<string, unknown>): Promise<unknown> {
  const s = harness.get(sessionId);
  const approvalId = typeof b.approvalId === "string" ? { approvalId: b.approvalId } : {};
  switch (name) {
    case "observe": {
      const snap = await s.observe();
      return s.view(snap, typeof b.maxChars === "number" ? { maxChars: b.maxChars } : {});
    }
    case "tap":
      return s.tap(toTarget(b), {
        ...(typeof b.durationMs === "number" ? { durationMs: b.durationMs } : {}),
        ...approvalId,
      });
    case "type":
      return s.type(String(b.text ?? ""), {
        ...(optionalTarget(b) ? { target: optionalTarget(b)! } : {}),
        ...(typeof b.submit === "boolean" ? { submit: b.submit } : {}),
        ...(typeof b.clear === "boolean" ? { clear: b.clear } : {}),
      });
    case "type_secret":
      return s.typeSecret(String(b.key ?? ""), {
        ...(optionalTarget(b) ? { target: optionalTarget(b)! } : {}),
        ...(typeof b.submit === "boolean" ? { submit: b.submit } : {}),
      });
    case "key":
      return s.pressKey(b.key as KeyName);
    case "swipe":
      return s.swipe([Number(b.fromX), Number(b.fromY)], [Number(b.toX), Number(b.toY)], Number(b.durationMs ?? 300));
    case "scroll":
      return s.scroll((b.direction as Direction) ?? "down", {
        ...(optionalTarget(b) ? { target: optionalTarget(b)! } : {}),
        ...(typeof b.amount === "number" ? { amount: b.amount } : {}),
      });
    case "clear_text":
      return s.clearText(optionalTarget(b));
    case "wait_for":
      return s.waitFor(
        {
          ...(b.selector ? { selector: b.selector as Selector } : {}),
          ...(typeof b.textContains === "string" ? { textContains: b.textContains } : {}),
          ...(typeof b.gone === "boolean" ? { gone: b.gone } : {}),
        },
        { ...(typeof b.timeoutMs === "number" ? { timeoutMs: b.timeoutMs } : {}) },
      );
    case "open_app":
      return s.openApp(String(b.appId ?? ""), approvalId);
    case "stop_app":
      return s.stopApp(String(b.appId ?? ""));
    case "open_url":
      return s.openUrl(String(b.url ?? ""), approvalId);
    case "install_app":
      return s.installApp(String(b.path ?? ""), approvalId);
    case "clear_app_data":
      return s.clearAppData(String(b.appId ?? ""), approvalId);
    case "shell":
      return s.shell(String(b.command ?? ""), approvalId);
    case "list_apps":
      return { apps: await s.device.listApps() };
    case "read_sms":
      return { messages: await s.readSms({ ...(typeof b.limit === "number" ? { limit: b.limit } : {}) }) };
    case "read_notifications":
      return { notifications: await s.readNotifications({ ...(typeof b.limit === "number" ? { limit: b.limit } : {}) }) };
    case "wait_for_otp":
      return s.waitForOtp({
        ...(typeof b.fromContains === "string" ? { fromContains: b.fromContains } : {}),
        ...(typeof b.bodyContains === "string" ? { bodyContains: b.bodyContains } : {}),
        ...(typeof b.digits === "number" ? { digits: b.digits } : {}),
        ...(typeof b.timeoutMs === "number" ? { timeoutMs: b.timeoutMs } : {}),
      });
    default:
      throw new HarnessError("bad_request", `unknown action "${name}"`);
  }
}
