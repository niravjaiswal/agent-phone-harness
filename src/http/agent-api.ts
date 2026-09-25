import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessError } from "../core/errors.js";
import type { Harness } from "../core/harness.js";
import type { ActionResult, BatchResult, ScreenView } from "../core/session.js";
import type { Direction, KeyName, Selector, Target } from "../core/types.js";
import { identityBlock, renderAction, renderBatch, renderError, renderHandoff, renderScreen, scrub } from "../mcp/render.js";
import { json, png, statusFor, text } from "./util.js";

/** Sessions opened over REST share one owner; MCP connections each get their own. */
export const REST_OWNER = "rest";

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

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const defined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** REST action dispatch — mirrors the MCP tool set one-for-one. */
async function action(harness: Harness, sessionId: string, name: string, b: Record<string, unknown>): Promise<unknown> {
  const s = harness.get(sessionId, REST_OWNER);
  const approval = defined({ approvalId: str(b.approvalId) });
  const target = optionalTarget(b);
  switch (name) {
    case "observe":
      return s.view(await s.observe(), defined({ maxChars: num(b.maxChars) }));
    case "tap":
      return s.tap(toTarget(b), defined({ durationMs: num(b.durationMs), ...approval }));
    case "type":
      return s.type(String(b.text ?? ""), defined({ target, submit: bool(b.submit), clear: bool(b.clear) }));
    case "type_secret":
      return s.typeSecret(String(b.key ?? ""), defined({ target, submit: bool(b.submit), clear: bool(b.clear) }));
    case "key":
      return s.pressKey(b.key as KeyName);
    case "swipe":
      return s.swipe([Number(b.fromX), Number(b.fromY)], [Number(b.toX), Number(b.toY)], Number(b.durationMs ?? 300));
    case "scroll":
      return s.scroll((b.direction as Direction) ?? "down", defined({ target, amount: num(b.amount) }));
    case "clear_text":
      return s.clearText(target);
    case "wait_for":
      return s.waitFor(
        defined({ selector: b.selector as Selector | undefined, textContains: str(b.textContains), gone: bool(b.gone) }),
        defined({ timeoutMs: num(b.timeoutMs) }),
      );
    case "open_app":
      return s.openApp(String(b.appId ?? ""), approval);
    case "stop_app":
      return s.stopApp(String(b.appId ?? ""));
    case "open_url":
      return s.openUrl(String(b.url ?? ""), approval);
    case "install_app":
      return s.installApp(String(b.path ?? ""), approval);
    case "clear_app_data":
      return s.clearAppData(String(b.appId ?? ""), approval);
    case "shell":
      return s.shell(String(b.command ?? ""), approval);
    case "batch":
      return s.batch((b.steps ?? []) as never, defined({ stopOnError: bool(b.stopOnError) }));
    case "deep_links":
      return { links: await s.deepLinks(str(b.appId)) };
    case "list_apps":
      return { apps: await s.device.listApps() };
    case "read_sms":
    case "read_messages":
      return s.readMessages(defined({ limit: num(b.limit), sinceMs: num(b.sinceMinutes) ? Date.now() - num(b.sinceMinutes)! * 60_000 : undefined }));
    case "read_notifications":
      return { notifications: await s.readNotifications(defined({ limit: num(b.limit) })) };
    case "wait_for_otp":
      return s.waitForOtp(
        defined({
          fromContains: str(b.fromContains),
          bodyContains: str(b.bodyContains),
          digits: num(b.digits),
          timeoutMs: num(b.timeoutMs),
          enter: bool(b.enter),
          target,
          submit: bool(b.submit),
        }),
      );
    case "request_human":
      return s.requestHuman(String(b.reason ?? ""), defined({ handoffId: str(b.handoffId), waitMs: num(b.waitSeconds) ? num(b.waitSeconds)! * 1000 : undefined }));
    case "clipboard":
      return { result: await s.clipboard(b.action === "set" ? "set" : "get", String(b.text ?? "")) };
    default:
      throw new HarnessError("bad_request", `unknown action "${name}"`, {
        hint: "See /agent.md for the list of actions.",
      });
  }
}

const isAction = (v: unknown): v is ActionResult =>
  Boolean(v && typeof v === "object" && "action" in v && "screen" in v && "settled" in v);
const isBatch = (v: unknown): v is BatchResult => Boolean(v && typeof v === "object" && "steps" in v && "screen" in v);
const isView = (v: unknown): v is ScreenView => Boolean(v && typeof v === "object" && "snapshotId" in v && "elements" in v);

/**
 * The compact rendering an MCP agent gets. A script-driven agent parsing JSON
 * with `\n`-escaped trees pays for every escape in tokens.
 */
function asText(v: unknown): string {
  if (isAction(v)) return renderAction(v);
  if (isBatch(v)) return renderBatch(v);
  if (isView(v)) return scrub(renderScreen(v));
  if (v && typeof v === "object" && "status" in v && "id" in v && ["done", "declined", "pending"].includes(String((v as { status: unknown }).status))) {
    return renderHandoff(v as Parameters<typeof renderHandoff>[0]);
  }
  if (v && typeof v === "object" && "entered" in v) {
    const o = v as { entered: boolean; code?: string; message: { from: string; origin: string }; result?: ActionResult };
    return o.entered && o.result
      ? `code from ${o.message.from} (${o.message.origin}) entered\n${renderAction(o.result)}`
      : `code: ${o.code}\nfrom ${o.message.from} via ${o.message.origin}`;
  }
  return scrub(JSON.stringify(v, null, 2));
}

export function wantsText(req: IncomingMessage, url: URL): boolean {
  return url.searchParams.get("format") === "text" || (req.headers.accept ?? "").startsWith("text/plain");
}

export function sendError(req: IncomingMessage, res: ServerResponse, url: URL, e: unknown): void {
  const status = e instanceof HarnessError ? statusFor(e) : 500;
  if (wantsText(req, url)) return text(res, status, renderError(e));
  if (e instanceof HarnessError) return json(res, status, JSON.parse(scrub(JSON.stringify(e.toJSON()))));
  json(res, 500, { ok: false, error: scrub(e instanceof Error ? e.message : String(e)) });
}

/** Routes an agent may call with the agent token. Returns false if the path is not ours. */
export async function agentRoutes(
  harness: Harness,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Record<string, unknown>,
): Promise<boolean> {
  const seg = url.pathname.split("/").filter(Boolean);
  const reply = (status: number, v: unknown) =>
    wantsText(req, url) ? text(res, status, asText(v)) : json(res, status, JSON.parse(scrub(JSON.stringify(v))));

  if (seg[0] === "devices" && seg.length === 1 && req.method === "GET") {
    reply(200, { devices: await harness.deviceStatus() });
    return true;
  }
  if (seg[0] === "doctor" && seg.length === 1 && req.method === "GET") {
    reply(200, { reports: await harness.doctor() });
    return true;
  }
  if (seg[0] !== "sessions") return false;

  if (seg.length === 1 && req.method === "POST") {
    const session = await harness.createSession({
      owner: REST_OWNER,
      ...(typeof body.deviceId === "string" ? { deviceId: body.deviceId } : {}),
      ...(body.policy && typeof body.policy === "object" ? { policy: body.policy } : {}),
    });
    const snap = await session.observe();
    const view = session.view(snap);
    if (wantsText(req, url)) {
      text(
        res,
        201,
        scrub(
          `session ${session.id} on ${session.device.info.name} (${session.device.info.id}), mode=${session.policy.config.mode}` +
            `${session.notes.length ? `\nnote: ${session.notes.join("\nnote: ")}` : ""}\n${identityBlock(session)}\n\n${view.elements}`,
        ),
      );
    } else {
      json(res, 201, {
        sessionId: session.id,
        device: session.device.info,
        notes: session.notes,
        identity: identityBlock(session),
        screen: view,
      });
    }
    return true;
  }
  if (seg.length === 1 && req.method === "GET") {
    reply(200, { sessions: harness.list(REST_OWNER) });
    return true;
  }

  const id = seg[1]!;
  if (seg.length === 2 && req.method === "GET") {
    reply(200, harness.get(id, REST_OWNER).stats());
    return true;
  }
  if (seg.length === 2 && req.method === "DELETE") {
    harness.get(id, REST_OWNER);
    await harness.close(id);
    reply(200, { ok: true });
    return true;
  }
  if (seg[2] === "screenshot" && req.method === "GET") {
    const shot = await harness.get(id, REST_OWNER).screenshot({
      marks: url.searchParams.get("marks") === "1",
      ...(url.searchParams.get("maxSize") ? { maxSize: Number(url.searchParams.get("maxSize")) } : {}),
    });
    png(res, shot.data);
    return true;
  }
  if (seg[2] && seg.length === 3 && req.method === "POST") {
    reply(200, await action(harness, id, seg[2], body));
    return true;
  }
  return false;
}
