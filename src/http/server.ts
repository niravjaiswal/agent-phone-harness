import { randomUUID } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { approvals, type ApprovalStatus } from "../core/approvals.js";
import { ensureServerCredentials, loadConfig, newToken, updateConfigFile } from "../core/config.js";
import { HarnessError } from "../core/errors.js";
import { Harness, type HarnessOptions } from "../core/harness.js";
import { logger } from "../core/logger.js";
import { inbox as defaultInbox, type Inbox } from "../core/messages/index.js";
import { ensureDir, paths } from "../core/paths.js";
import { writeRuntime } from "../core/runtime.js";
import { AndroidProvider } from "../providers/android/index.js";
import { redeemLoginCode } from "../core/login-codes.js";
import { panelAsset } from "../panel/page.js";
import { VERSION } from "../version.js";
import { agentDoc } from "./agent-doc.js";
import { agentRoutes, sendError } from "./agent-api.js";
import { Auth, CSRF_HEADER, crossOrigin, loopbackHost } from "./auth.js";
import { hookRoutes } from "./hooks.js";
import { McpHub } from "./mcp.js";
import { operatorRoutes } from "./operator-api.js";
import { json, parseJson, readRaw, requestBase, text } from "./util.js";

const log = logger("http");

export interface ServeOptions extends HarnessOptions {
  port?: number;
  host?: string;
  /** Agent token. v0.1 name, kept for compatibility. */
  token?: string;
  agentToken?: string;
  operatorToken?: string;
  /**
   * false = no tokens at all, loopback only, Host-checked. For local development;
   * every other configuration authenticates, with tokens generated on first run.
   */
  auth?: boolean;
  /** Fixed public URL. Otherwise from config, or discovered from a tunnel. */
  publicUrl?: string;
  /** cloudflared metrics base (e.g. http://tunnel:2000) — its /quicktunnel reveals the public hostname. */
  tunnelMetrics?: string;
  /** Network phones to keep `adb connect`ed, e.g. ["redroid:5555"]. */
  adbConnect?: string[];
  inbox?: Inbox;
  /** Close agent sessions idle this long. Default 20 minutes. */
  idleTimeoutMs?: number;
}

export interface RunningServer {
  port: number;
  localUrl: string;
  harness: Harness;
  agentToken?: string;
  operatorToken?: string;
  /** Current best public URL (configured or discovered). */
  publicUrl: () => string | undefined;
  setPublicUrl: (url: string | undefined) => void;
  close: () => Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function landing(base: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-phone</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}
@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}a{color:#8ab4ff}}code{font-size:.9em}</style>
<h1>agent-phone-harness</h1>
<p>This server gives an AI agent its own phone.</p>
<ul><li><a href="/panel/">Operator panel</a> — for the human who owns this phone</li>
<li><a href="/agent.md">Agent instructions</a> — for the agent: <code>${base}/agent.md</code></li></ul>
<p><small>v${VERSION}</small></p>`;
}

export async function serve(opts: ServeOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? Number(process.env.PHONE_PORT ?? 8712);
  const host = opts.host ?? process.env.PHONE_HOST ?? "127.0.0.1";
  const noAuth = opts.auth === false;
  if (noAuth && !LOOPBACK.has(host)) {
    throw new Error(`Refusing to run without authentication on ${host}; no-auth mode is loopback only`);
  }

  const creds = noAuth
    ? undefined
    : ensureServerCredentials({
        ...((opts.agentToken ?? opts.token) ? { agentToken: opts.agentToken ?? opts.token } : {}),
        ...(opts.operatorToken ? { operatorToken: opts.operatorToken } : {}),
      });
  if (creds?.generated) {
    log.info(`generated server tokens in ${paths.config}; show them with \`agent-phone token\``);
  }
  const auth = new Auth({
    ...(creds ? { agentToken: creds.agentToken, operatorToken: creds.operatorToken } : {}),
    cookieSecret: creds?.cookieSecret ?? newToken("ck"),
  });
  let agentToken = creds?.agentToken;

  const inbox = opts.inbox ?? defaultInbox;
  const harness = new Harness({ ...opts, inbox, idleTimeoutMs: opts.idleTimeoutMs ?? 20 * 60_000 });
  const hub = new McpHub(harness);

  let discoveredUrl: string | undefined;
  const publicUrl = () => opts.publicUrl ?? loadConfig().publicUrl ?? discoveredUrl;
  let localUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const base = (req: IncomingMessage) => publicUrl() ?? requestBase(req);
  const persistRuntime = () => writeRuntime({ pid: process.pid, startedAt: Date.now(), localUrl, ...(publicUrl() ? { publicUrl: publicUrl()! } : {}) });

  // ------------------------------------------------------------- events for the panel
  const sse = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sse) c.write(payload);
  };
  const lastStatus = new Map<string, ApprovalStatus>();
  const watcher = setInterval(() => {
    for (const a of approvals.list()) {
      const prev = lastStatus.get(a.id);
      if (prev === a.status) continue;
      lastStatus.set(a.id, a.status);
      if (a.status === "pending") broadcast("approval_required", a);
      else if (prev === "pending") broadcast("approval_decided", a);
    }
    broadcast("heartbeat", { ts: Date.now() });
  }, 1500);
  watcher.unref();
  // Decided and expired requests are history; keep a week of it.
  const pruner = setInterval(() => approvals.prune(7 * 86_400_000), 3600_000);
  pruner.unref();
  approvals.prune(7 * 86_400_000);
  const unsubscribe = inbox.onMessage((m) => broadcast("message", m));

  // ------------------------------------------------------------- network phones + tunnel
  const adbTargets =
    opts.adbConnect ?? (process.env.PHONE_ADB_CONNECT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let adbTimer: NodeJS.Timeout | undefined;
  if (adbTargets.length) {
    const android = harness.providers.get("android") as AndroidProvider;
    const tick = () => void android.ensureConnected(adbTargets).catch((e: Error) => log.warn("adb keepalive", e.message));
    tick();
    adbTimer = setInterval(tick, 15_000);
    adbTimer.unref();
  }

  const metrics = opts.tunnelMetrics ?? process.env.PHONE_TUNNEL_METRICS;
  let tunnelTimer: NodeJS.Timeout | undefined;
  if (metrics) {
    const poll = async () => {
      try {
        const r = await fetch(`${metrics.replace(/\/$/, "")}/quicktunnel`, { signal: AbortSignal.timeout(3000) });
        const { hostname } = (await r.json()) as { hostname?: string };
        const next = hostname ? `https://${hostname}` : undefined;
        if (next && next !== discoveredUrl) {
          discoveredUrl = next;
          log.info(`public URL: ${next}`);
          persistRuntime();
        }
      } catch {
        /* tunnel not up yet */
      }
    };
    void poll();
    tunnelTimer = setInterval(() => void poll(), 5000);
    tunnelTimer.unref();
  }

  const rotateAgentToken = (): string => {
    if (process.env.PHONE_AGENT_TOKEN || process.env.PHONE_API_TOKEN) {
      throw new HarnessError("bad_request", "The agent token is pinned by an environment variable; change it there");
    }
    if (noAuth) throw new HarnessError("bad_request", "This server runs without authentication");
    const t = newToken("agt");
    updateConfigFile((c) => (c.agentToken = t));
    auth.setAgentToken(t);
    agentToken = t;
    return t;
  };

  // ------------------------------------------------------------- routing
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const M = req.method ?? "GET";

    if (path === "/health") return json(res, 200, { ok: true, version: VERSION });

    const isHook = path.startsWith("/hooks/");
    if (!isHook && crossOrigin(req)) return json(res, 403, { ok: false, error: "cross-origin request refused" });
    if (noAuth && !loopbackHost(req)) return json(res, 403, { ok: false, error: "unexpected Host header" });

    // APK upload: streamed to disk, so it cannot share the capped JSON body path.
    const install = /^\/api\/operator\/devices\/([^/]+)\/install$/.exec(path);
    if (install && M === "POST") {
      const who = noAuth ? { principal: "operator", via: "bearer" } : auth.identify(req);
      if (who.principal !== "operator") return json(res, 401, { ok: false, error: "operator authentication required" });
      if (who.via === "cookie" && req.headers[CSRF_HEADER] !== "1") {
        return json(res, 403, { ok: false, error: `missing ${CSRF_HEADER} header` });
      }
      return installUpload(req, res, decodeURIComponent(install[1]!));
    }

    const raw = ["POST", "PUT", "PATCH", "DELETE"].includes(M) ? await readRaw(req) : "";

    // ---- public
    if (isHook) {
      const handled = await hookRoutes(req, res, url, raw, {
        inbox,
        config: loadConfig,
        baseUrls: (r) => [...new Set([publicUrl(), requestBase(r), localUrl].filter((x): x is string => Boolean(x)))],
      });
      if (handled) return;
    }
    if (path === "/" && M === "GET") return text(res, 200, landing(base(req)), "text/html; charset=utf-8");
    if (path === "/agent.md" && M === "GET") {
      return text(res, 200, agentDoc(base(req), loadConfig().identity), "text/markdown; charset=utf-8");
    }
    if (path === "/panel" && M === "GET") {
      res.writeHead(308, { location: "/panel/" });
      return void res.end();
    }
    const asset = M === "GET" ? panelAsset(path) : undefined;
    if (asset) {
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        // No inline script at all: approval summaries and trace labels are
        // agent-influenced text, and script injected into the panel could
        // approve the agent's own actions.
        "content-security-policy":
          "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; " +
          "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      return void res.end(asset.body);
    }
    if (path === "/panel/login" && M === "POST") {
      if (noAuth) return json(res, 200, { ok: true, open: true });
      if (auth.throttled(req)) return json(res, 429, { ok: false, error: "too many attempts; wait a minute" });
      const body = parseJson(req, raw);
      const byCode = typeof body.code === "string" && redeemLoginCode(body.code.trim());
      if (!byCode && (typeof body.token !== "string" || !auth.checkOperatorToken(body.token.trim()))) {
        auth.recordFailure(req);
        const hint =
          typeof body.token === "string" && agentToken && body.token.trim() === agentToken
            ? "That is the agent token. The panel needs the operator token."
            : typeof body.code === "string"
              ? "That sign-in link has expired or was already used. Mint a new one with `agent-phone panel-link`."
              : "Wrong operator token.";
        return json(res, 401, { ok: false, error: hint });
      }
      // Secure only if this request really arrived over HTTPS; a Secure cookie
      // set on a plain-http visit (http://127.0.0.1 while a tunnel is up) is dropped.
      const secure = requestBase(req).startsWith("https://") || req.headers["cf-visitor"]?.includes("https") === true;
      res.setHeader("set-cookie", auth.cookieHeader(auth.issueCookie(), secure));
      return json(res, 200, { ok: true });
    }
    if (path === "/panel/logout" && M === "POST") {
      res.setHeader("set-cookie", auth.cookieHeader("", false, 0));
      return json(res, 200, { ok: true });
    }

    // ---- authenticated
    const who = noAuth ? { principal: "operator" as const, via: "bearer" as const } : auth.identify(req);

    const operatorPath = path.startsWith("/api/operator/") || path === "/events" || path.startsWith("/approvals");
    if (operatorPath) {
      if (who.principal !== "operator") {
        return json(res, who.principal === "agent" ? 403 : 401, {
          ok: false,
          error: who.principal === "agent" ? "agents cannot use operator routes" : "operator authentication required",
        });
      }
      if (who.via === "cookie" && M !== "GET" && req.headers[CSRF_HEADER] !== "1") {
        return json(res, 403, { ok: false, error: `missing ${CSRF_HEADER} header` });
      }
      if (path === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        for (const a of approvals.list({ pendingOnly: true })) res.write(`event: approval_required\ndata: ${JSON.stringify(a)}\n\n`);
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }
      const body = parseJson(req, raw);
      // v0.1 approval routes, now operator-only.
      if (path.startsWith("/approvals")) {
        url.pathname = `/api/operator${path}`;
      }
      await operatorRoutes(
        {
          harness,
          inbox,
          localUrl,
          publicUrl,
          base,
          agentToken: () => agentToken,
          rotateAgentToken,
          broadcast,
          mcpClients: () => hub.size,
        },
        req,
        res,
        url,
        body,
      );
      return;
    }

    if (who.principal !== "agent" && !noAuth) {
      if (who.principal === "operator" && who.via === "bearer") {
        return json(res, 403, {
          ok: false,
          error:
            "This is the operator token. Give the agent the agent token instead — an agent holding the " +
            "operator token could approve its own actions.",
        });
      }
      return json(res, 401, { ok: false, error: "agent authentication required (Authorization: Bearer <agent token>)" });
    }

    if (path === "/mcp") {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      await hub.handle(req, res, body);
      return;
    }

    const body = parseJson(req, raw);
    if (await agentRoutes(harness, req, res, url, body)) return;
    json(res, 404, { ok: false, error: `no route for ${M} ${path}`, hint: `See ${base(req)}/agent.md` });
  }

  /**
   * The operator installs an app by uploading its APK. Container phones have
   * no Play Store, so this is how a hosted user gets their app onto the phone.
   */
  async function installUpload(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const max = 1024 * 1024 * 1024;
    const dir = ensureDir(join(paths.home, "uploads"));
    const file = join(dir, `${randomUUID()}.apk`);
    let size = 0;
    try {
      await pipeline(
        req,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            cb(size > max ? new HarnessError("bad_request", "APK larger than 1 GB") : null, chunk);
          },
        }),
        createWriteStream(file, { mode: 0o600 }),
      );
      if (size < 4) throw new HarnessError("bad_request", "Upload the APK file as the request body");
      const d = await harness.operatorDevice(deviceId);
      if (!d.installApp) throw new HarnessError("unsupported", "This phone cannot install apps from the host");
      await d.installApp(file);
      log.info(`operator installed an app on ${deviceId} (${Math.round(size / 1024)} KB)`);
      json(res, 200, { ok: true, bytes: size });
    } finally {
      rmSync(file, { force: true });
    }
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    void handle(req, res, url).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof SyntaxError) return json(res, 400, { ok: false, error: "malformed JSON" });
      sendError(req, res, url, e);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const addr = httpServer.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  localUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host}:${boundPort}`;
  persistRuntime();
  log.info(`listening on ${localUrl}  (panel: /panel/, MCP: /mcp, agent docs: /agent.md)${noAuth ? "  [NO AUTH — loopback only]" : ""}`);

  return {
    port: boundPort,
    localUrl,
    harness,
    ...(creds ? { agentToken: creds.agentToken, operatorToken: creds.operatorToken } : {}),
    publicUrl,
    setPublicUrl: (u) => {
      discoveredUrl = u?.replace(/\/+$/, "");
      persistRuntime();
    },
    close: async () => {
      clearInterval(watcher);
      clearInterval(pruner);
      if (adbTimer) clearInterval(adbTimer);
      if (tunnelTimer) clearInterval(tunnelTimer);
      unsubscribe();
      for (const c of sse) c.end();
      await hub.closeAll();
      await harness.closeAll();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      rmSync(join(paths.home, "server.json"), { force: true });
    },
  };
}
