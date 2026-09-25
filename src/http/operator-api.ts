import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { approvals } from "../core/approvals.js";
import { loadCeiling } from "../core/ceiling.js";
import {
  envOverrides, loadConfig, mask, newToken, updateConfigFile, type OperatorConfig,
} from "../core/config.js";
import { HarnessError } from "../core/errors.js";
import type { Harness } from "../core/harness.js";
import { annotateScreenshot } from "../core/image.js";
import { collectMessages, ImapSource, type Inbox } from "../core/messages/index.js";
import { configuredChannels, notifyOperator } from "../core/notify.js";
import { ensureDir, paths } from "../core/paths.js";
import { DEFAULT_POLICY, type PolicyMode } from "../core/policy.js";
import { secrets } from "../core/secrets.js";
import type { Direction, KeyName } from "../core/types.js";
import { VERSION } from "../version.js";
import { json, png } from "./util.js";

export interface OperatorContext {
  harness: Harness;
  inbox: Inbox;
  localUrl: string;
  publicUrl: () => string | undefined;
  /** Best base URL for links shown to the operator. */
  base: (req: IncomingMessage) => string;
  agentToken: () => string | undefined;
  rotateAgentToken: () => string;
  broadcast: (event: string, data: unknown) => void;
  mcpClients: () => number;
}

const SESSION_ID = /^[0-9a-f]{8}$/;
const SECRET_KEY = /^[a-z0-9_]{1,64}$/;

function operatorLog(entry: Record<string, unknown>): void {
  ensureDir(paths.home);
  appendFileSync(paths.operatorLog, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, { mode: 0o600 });
}

function readJsonl(file: string, limit = 2000): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit);
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Past and present sessions from disk, newest first. */
function pastSessions(limit = 50) {
  if (!existsSync(paths.sessions)) return [];
  return readdirSync(paths.sessions)
    .filter((d) => SESSION_ID.test(d))
    .map((d) => {
      const dir = join(paths.sessions, d);
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as Record<string, unknown>;
      } catch {
        /* partial session */
      }
      const trace = join(dir, "trace.jsonl");
      const mtime = existsSync(trace) ? statSync(trace).mtimeMs : statSync(dir).mtimeMs;
      return {
        sessionId: d,
        startedAt: meta.startedAt as number | undefined,
        device: (meta.device as { id?: string; name?: string } | undefined) ?? {},
        mode: (meta.policy as { mode?: string } | undefined)?.mode,
        lastActivity: mtime,
      };
    })
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, limit);
}

/** Serve a file only if it really lives under the sessions directory. */
function insideSessions(p: string): boolean {
  const root = resolve(paths.sessions) + sep;
  return resolve(p).startsWith(root);
}

function maskedConfig(c: OperatorConfig) {
  return {
    publicUrl: c.publicUrl,
    identity: c.identity,
    notify: {
      webhook: c.notify.webhook,
      ntfyUrl: c.notify.ntfyUrl,
      ntfyToken: mask(c.notify.ntfyToken),
      telegramBotToken: mask(c.notify.telegramBotToken),
      telegramChatId: c.notify.telegramChatId,
      slackWebhook: mask(c.notify.slackWebhook),
    },
    sources: {
      relayToken: mask(c.sources.relayToken),
      telnyxPublicKey: c.sources.telnyxPublicKey,
      twilioAuthToken: mask(c.sources.twilioAuthToken),
      imap: c.sources.imap,
    },
  };
}

/** Whitelisted fields the panel may set. An empty string clears a field. */
function applyPatch(c: OperatorConfig, patch: Record<string, unknown>): void {
  const setStr = (obj: Record<string, unknown>, key: string, v: unknown) => {
    if (v === undefined) return;
    if (v === "" || v === null) delete obj[key];
    else if (typeof v === "string") obj[key] = v.trim();
    else throw new HarnessError("bad_request", `${key} must be a string`);
  };
  if ("publicUrl" in patch) setStr(c as unknown as Record<string, unknown>, "publicUrl", patch.publicUrl);
  const id = (patch.identity ?? {}) as Record<string, unknown>;
  for (const k of ["phoneNumber", "email"]) setStr(c.identity as Record<string, unknown>, k, id[k]);
  const n = (patch.notify ?? {}) as Record<string, unknown>;
  for (const k of ["webhook", "ntfyUrl", "ntfyToken", "telegramBotToken", "telegramChatId", "slackWebhook"]) {
    setStr(c.notify as Record<string, unknown>, k, n[k]);
  }
  const s = (patch.sources ?? {}) as Record<string, unknown>;
  for (const k of ["telnyxPublicKey", "twilioAuthToken"]) setStr(c.sources as Record<string, unknown>, k, s[k]);
  if ("imap" in s) {
    const i = s.imap as Record<string, unknown> | null;
    if (!i || !i.host) delete c.sources.imap;
    else {
      if (typeof i.host !== "string" || typeof i.user !== "string") {
        throw new HarnessError("bad_request", "imap needs host and user");
      }
      c.sources.imap = {
        host: i.host.trim(),
        user: i.user.trim(),
        ...(i.port ? { port: Number(i.port) } : {}),
        ...(typeof i.mailbox === "string" && i.mailbox ? { mailbox: i.mailbox } : {}),
        ...(typeof i.fromContains === "string" && i.fromContains ? { fromContains: i.fromContains } : {}),
        passwordSecret: typeof i.passwordSecret === "string" && i.passwordSecret ? i.passwordSecret : "imap_password",
      };
    }
  }
}

const shotCache = new Map<string, { at: number; data: Buffer; w: number; h: number }>();

export async function operatorRoutes(
  ctx: OperatorContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/operator/")) return false;
  const seg = url.pathname.split("/").filter(Boolean).slice(2); // after api/operator
  const M = req.method ?? "GET";
  const { harness } = ctx;

  // ------------------------------------------------------------- overview
  if (seg[0] === "overview" && M === "GET") {
    const cfg = loadConfig();
    const base = ctx.base(req);
    json(res, 200, {
      version: VERSION,
      localUrl: ctx.localUrl,
      publicUrl: ctx.publicUrl(),
      base,
      devices: await harness.deviceStatus(),
      sessions: harness.list(),
      mcpClients: ctx.mcpClients(),
      approvals: approvals.list().slice(0, 30),
      config: maskedConfig(cfg),
      channels: configuredChannels(cfg.notify),
      envOverrides: envOverrides(),
      secrets: secrets.describe(),
      policy: loadCeiling(),
      policyFile: paths.policy,
      hooks: {
        telnyx: `${base}/hooks/sms/telnyx`,
        twilio: `${base}/hooks/sms/twilio`,
        relay: `${base}/hooks/sms/relay`,
      },
    });
    return true;
  }

  // ------------------------------------------------------------- connection details
  if (seg[0] === "connection" && M === "GET") {
    const base = ctx.base(req);
    const token = ctx.agentToken();
    json(res, 200, {
      mcpUrl: `${base}/mcp`,
      restUrl: base,
      agentMd: `${base}/agent.md`,
      agentToken: token,
      relayToken: loadConfig().sources.relayToken,
      prompt:
        `You have an Android phone you can control. Its API is at ${base} and your token is ${token}. ` +
        `Before using it, fetch ${base}/agent.md and follow those instructions. Send the token as ` +
        "`Authorization: Bearer <token>` on every request.",
    });
    return true;
  }
  if (seg[0] === "tokens" && seg[1] === "agent" && M === "POST") {
    const t = ctx.rotateAgentToken();
    operatorLog({ action: "rotate_agent_token" });
    json(res, 200, { agentToken: t });
    return true;
  }
  if (seg[0] === "tokens" && seg[1] === "relay" && M === "POST") {
    const t = newToken("rly");
    updateConfigFile((c) => (c.sources.relayToken = t));
    operatorLog({ action: "rotate_relay_token" });
    json(res, 200, { relayToken: t });
    return true;
  }

  // ------------------------------------------------------------- devices: live view + takeover
  if (seg[0] === "devices" && seg[1]) {
    const deviceId = decodeURIComponent(seg[1]);
    if (seg[2] === "screen.png" && M === "GET") {
      const max = Math.min(Number(url.searchParams.get("max") ?? 480) || 480, 1400);
      const key = `${deviceId}@${max}`;
      const hit = shotCache.get(key);
      let shot = hit && Date.now() - hit.at < 400 ? hit : undefined;
      if (!shot) {
        const d = await harness.operatorDevice(deviceId);
        const raw = await d.screenshot();
        const out = annotateScreenshot(raw.data, { maxSize: max });
        const size = d.info.screen ?? { width: raw.width, height: raw.height };
        shot = { at: Date.now(), data: out.data, w: size.width, h: size.height };
        shotCache.set(key, shot);
      }
      png(res, shot.data, { "x-device-width": String(shot.w), "x-device-height": String(shot.h) });
      return true;
    }
    if (seg[2] === "control" && M === "POST") {
      if (body.action === "take") {
        const state = harness.takeControl(deviceId, "operator");
        operatorLog({ action: "take_control", deviceId });
        ctx.broadcast("control", { deviceId, ...state });
        json(res, 200, { ok: true, control: state });
      } else {
        harness.releaseControl(deviceId);
        operatorLog({ action: "release_control", deviceId });
        ctx.broadcast("control", { deviceId, released: true });
        json(res, 200, { ok: true });
      }
      return true;
    }
    if (seg[2] === "input" && M === "POST") {
      if (!harness.controlOf(deviceId)) {
        throw new HarnessError("device_busy", "Take control of the phone first", {
          hint: "The agent may be mid-action; taking control pauses it.",
        });
      }
      const d = await harness.operatorDevice(deviceId);
      const n = (v: unknown) => Math.round(Number(v));
      switch (body.type) {
        case "tap":
          await d.tap(n(body.x), n(body.y), typeof body.durationMs === "number" ? body.durationMs : undefined);
          break;
        case "swipe":
          await d.swipe([n(body.fromX), n(body.fromY)], [n(body.toX), n(body.toY)], n(body.durationMs ?? 300));
          break;
        case "text":
          await d.typeText(String(body.text ?? ""), { submit: Boolean(body.submit) });
          break;
        case "key":
          await d.pressKey(String(body.key) as KeyName);
          break;
        case "scroll": {
          const s = d.info.screen ?? { width: 1080, height: 2340 };
          const dir = String(body.direction ?? "down") as Direction;
          const cx = s.width / 2, cy = s.height / 2, dy = s.height * 0.3;
          await d.swipe([cx, dir === "down" ? cy + dy : cy - dy], [cx, dir === "down" ? cy - dy : cy + dy], 300);
          break;
        }
        case "open_app":
          await d.launchApp(String(body.appId ?? ""));
          break;
        case "open_url":
          await d.openUrl(String(body.url ?? ""));
          break;
        default:
          throw new HarnessError("bad_request", `unknown input type ${String(body.type)}`);
      }
      shotCache.clear();
      // Never record what the operator typed — it is often a password.
      operatorLog({
        action: "input",
        deviceId,
        type: body.type,
        ...(body.type === "text" ? { length: String(body.text ?? "").length } : {}),
        ...(body.type === "key" ? { key: body.key } : {}),
      });
      json(res, 200, { ok: true });
      return true;
    }
  }

  // ------------------------------------------------------------- sessions + traces
  if (seg[0] === "sessions") {
    if (seg.length === 1 && M === "GET") {
      json(res, 200, { live: harness.list(), past: pastSessions() });
      return true;
    }
    const id = seg[1] ?? "";
    if (!SESSION_ID.test(id)) throw new HarnessError("bad_request", "bad session id");
    if (seg.length === 2 && M === "DELETE") {
      await harness.close(id);
      operatorLog({ action: "end_session", sessionId: id });
      json(res, 200, { ok: true });
      return true;
    }
    if (seg[2] === "trace" && M === "GET") {
      json(res, 200, { events: readJsonl(join(paths.sessions, id, "trace.jsonl")) });
      return true;
    }
    if (seg[2] === "screens" && seg[3] && M === "GET") {
      if (!/^[\w.-]+\.png$/.test(seg[3])) throw new HarnessError("bad_request", "bad file name");
      const f = join(paths.sessions, id, "screens", seg[3]);
      if (!insideSessions(f) || !existsSync(f)) throw new HarnessError("session_not_found", "no such screen");
      png(res, readFileSync(f));
      return true;
    }
  }

  // ------------------------------------------------------------- approvals + handoffs
  if (seg[0] === "approvals") {
    if (seg.length === 1 && M === "GET") {
      json(res, 200, { approvals: approvals.list({ pendingOnly: url.searchParams.get("pending") === "1" }) });
      return true;
    }
    const id = seg[1] ?? "";
    const a = approvals.get(id);
    if (!a) throw new HarnessError("bad_request", `no approval ${id}`);
    if (seg.length === 2 && M === "GET") {
      json(res, 200, { approval: a });
      return true;
    }
    if (seg[2] === "evidence.png" && M === "GET") {
      if (!a.evidence || !insideSessions(a.evidence) || !existsSync(a.evidence)) {
        throw new HarnessError("session_not_found", "no evidence screenshot");
      }
      png(res, readFileSync(a.evidence));
      return true;
    }
    if ((seg[2] === "approve" || seg[2] === "deny") && M === "POST") {
      const decided = approvals.decide(id, seg[2] === "approve", "panel", typeof body.note === "string" ? body.note : undefined);
      operatorLog({ action: seg[2], approvalId: id });
      ctx.broadcast("approval_decided", decided);
      json(res, 200, { ok: true, approval: decided });
      return true;
    }
  }

  // ------------------------------------------------------------- secrets (write-only)
  if (seg[0] === "secrets") {
    if (seg.length === 1 && M === "GET") {
      json(res, 200, { secrets: secrets.describe() });
      return true;
    }
    const key = (seg[1] ?? "").toLowerCase();
    if (!SECRET_KEY.test(key)) throw new HarnessError("bad_request", "secret names are lowercase letters, digits and _");
    if (M === "PUT") {
      if (typeof body.value !== "string" || !body.value) throw new HarnessError("bad_request", "value required");
      secrets.set(key, body.value);
      operatorLog({ action: "set_secret", key });
      json(res, 200, { ok: true });
      return true;
    }
    if (M === "DELETE") {
      const ok = secrets.delete(key);
      operatorLog({ action: "delete_secret", key });
      json(res, ok ? 200 : 404, { ok });
      return true;
    }
  }

  // ------------------------------------------------------------- messages
  if (seg[0] === "messages") {
    if (seg.length === 1 && M === "GET") {
      json(res, 200, { messages: ctx.inbox.list({ limit: 50 }) });
      return true;
    }
    if (seg[1] === "test" && M === "POST") {
      const m = ctx.inbox.add({
        id: `test-${Date.now()}`,
        origin: "test",
        from: typeof body.from === "string" && body.from ? body.from : "Test",
        body: typeof body.body === "string" && body.body ? body.body : `Your verification code is ${Math.floor(100000 + Math.random() * 900000)}`,
        timestamp: Date.now(),
      });
      json(res, 200, { ok: true, message: m });
      return true;
    }
    if (seg[1] === "imap-test" && M === "POST") {
      const imap = loadConfig().sources.imap;
      if (!imap) throw new HarnessError("bad_request", "IMAP is not configured");
      const src = new ImapSource(imap, () => secrets.get(imap.passwordSecret ?? "imap_password"), { minIntervalMs: 0 });
      const r = await collectMessages([src], { sinceMs: Date.now() - 3 * 86_400_000, limit: 5 });
      json(res, 200, {
        ok: !r.errors.length,
        error: r.errors[0]?.error,
        recent: r.messages.map((m) => ({ from: m.from, subject: m.subject, receivedAt: m.receivedAt })),
      });
      return true;
    }
  }

  // ------------------------------------------------------------- config
  if (seg[0] === "config") {
    if (M === "GET") {
      json(res, 200, { config: maskedConfig(loadConfig()), envOverrides: envOverrides() });
      return true;
    }
    if (M === "PATCH") {
      updateConfigFile((c) => applyPatch(c, body));
      operatorLog({ action: "update_config", fields: Object.keys(body) });
      json(res, 200, { config: maskedConfig(loadConfig()), envOverrides: envOverrides() });
      return true;
    }
  }

  if (seg[0] === "notify" && seg[1] === "test" && M === "POST") {
    const results = await notifyOperator({
      kind: "test",
      title: "agent-phone test",
      body: "Notifications from your phone harness are working.",
      path: "/panel/",
    });
    json(res, 200, { results });
    return true;
  }

  // ------------------------------------------------------------- policy ceiling
  if (seg[0] === "policy") {
    if (M === "GET") {
      json(res, 200, { policy: loadCeiling(), file: paths.policy, defaults: DEFAULT_POLICY });
      return true;
    }
    if (M === "PUT") {
      let current: Record<string, unknown> = {};
      if (existsSync(paths.policy)) {
        try {
          current = JSON.parse(readFileSync(paths.policy, "utf8")) as Record<string, unknown>;
        } catch {
          current = {};
        }
      }
      const modes: PolicyMode[] = ["observe", "guarded", "autonomous"];
      if (body.mode !== undefined && !modes.includes(body.mode as PolicyMode)) {
        throw new HarnessError("bad_request", "mode must be observe, guarded or autonomous");
      }
      for (const k of ["mode", "allowShell", "allowInstall", "allowClearAppData", "maxActionsPerSession", "maxSessionMinutes"]) {
        if (body[k] !== undefined) current[k] = body[k];
      }
      for (const k of ["allowedApps", "blockedApps"]) {
        if (Array.isArray(body[k])) current[k] = (body[k] as unknown[]).map(String).map((x) => x.trim()).filter(Boolean);
      }
      ensureDir(dirname(paths.policy));
      writeFileSync(paths.policy, JSON.stringify(current, null, 2), { mode: 0o600 });
      operatorLog({ action: "update_policy", fields: Object.keys(body) });
      json(res, 200, { policy: loadCeiling() });
      return true;
    }
  }

  if (seg[0] === "log" && M === "GET") {
    json(res, 200, { entries: readJsonl(paths.operatorLog, 200).reverse() });
    return true;
  }

  json(res, 404, { ok: false, error: `no operator route ${M} ${url.pathname}` });
  return true;
}

