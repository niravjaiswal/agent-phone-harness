import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HarnessError } from "../core/errors.js";
import type { Harness, Owner } from "../core/harness.js";
import type { BatchStep, Session } from "../core/session.js";
import type { Direction, KeyName, Selector, Target } from "../core/types.js";
import { identityBlock, renderAction, renderBatch, renderError, renderHandoff, renderScreen, scrub } from "./render.js";

/**
 * The agent-facing tool surface.
 *
 * Design rules:
 *  - flat, verb-first names; agents pattern-match on the `phone_` prefix
 *  - every mutating tool returns the *resulting* screen, so there is never a
 *    reason to call observe twice
 *  - `sessionId` is optional whenever exactly one session is open
 *  - nothing here can approve a gated action; that path is operator-only
 */

const selectorSchema = z
  .object({
    text: z.string().optional().describe("exact visible text (case-insensitive)"),
    textContains: z.string().optional(),
    label: z.string().optional().describe("accessibility label / content-description"),
    labelContains: z.string().optional(),
    id: z.string().optional().describe("resource-id (Android) or identifier (iOS); short form accepted"),
    idContains: z.string().optional(),
    role: z.string().optional().describe("Button, TextField, Text, Switch, Cell, List, Image..."),
    value: z.string().optional(),
    clickable: z.boolean().optional(),
    enabled: z.boolean().optional(),
    index: z.number().int().optional().describe("which match to take when several qualify; negative counts from the end"),
  })
  .describe("Re-resolved at action time, so it survives re-renders. Prefer this over ref after a screen change.");

const targetShape = {
  ref: z.string().optional().describe('element ref from the last observe, e.g. "e7"'),
  selector: selectorSchema.optional(),
  x: z.number().optional().describe("raw x coordinate; last resort, prefer ref/selector"),
  y: z.number().optional(),
};

const sessionShape = {
  sessionId: z.string().optional().describe("omit when exactly one session is open"),
};

function toTarget(a: { ref?: string; selector?: Selector; x?: number; y?: number }): Target {
  if (a.ref) return { ref: a.ref };
  if (a.selector && Object.keys(a.selector).length) return { selector: a.selector };
  if (a.x !== undefined && a.y !== undefined) return { point: [a.x, a.y] };
  throw new HarnessError("bad_request", "Give a ref, a selector, or x+y", {
    hint: 'e.g. {"selector":{"text":"Continue"}} or {"ref":"e7"}',
  });
}

function optionalTarget(a: { ref?: string; selector?: Selector; x?: number; y?: number }): Target | undefined {
  if (a.ref || (a.selector && Object.keys(a.selector).length) || (a.x !== undefined && a.y !== undefined)) {
    return toTarget(a);
  }
  return undefined;
}

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: scrub(s) }] });

const fail = (e: unknown): CallToolResult => ({ content: [{ type: "text", text: renderError(e) }], isError: true });

const guard = (fn: () => Promise<CallToolResult>) => fn().catch(fail);

export interface ToolOptions {
  /**
   * Sessions opened through this server belong to this owner, and implicit
   * session resolution only sees them. One per MCP connection.
   */
  owner?: Owner;
}

export function registerPhoneTools(server: McpServer, harness: Harness, opts: ToolOptions = {}): void {
  const S = (id?: string): Session => harness.resolve(id, opts.owner);

  // ------------------------------------------------------------- devices

  server.registerTool(
    "phone_list_devices",
    {
      description:
        "List phones the harness can reach: physical Android over adb (USB or TCP), iOS simulators and devices, " +
        "and the built-in mock phone. Call this first if you do not know what hardware is attached.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const devices = await harness.deviceStatus();
        if (!devices.length) return text("No devices found. Run `agent-phone doctor` on the host for a diagnosis.");
        return text(
          devices
            .map(
              (d) =>
                `${d.id}  ${d.name}  [${d.platform}/${d.transport}]  ${d.state}` +
                (d.osVersion ? `  os=${d.osVersion}` : "") +
                (d.screen ? `  ${d.screen.width}x${d.screen.height}` : "") +
                (d.leasedBy ? `  (in use by session ${d.leasedBy})` : "") +
                (d.control ? "  (a human has control)" : ""),
            )
            .join("\n"),
        );
      }),
  );

  // ------------------------------------------------------------- session

  server.registerTool(
    "phone_session_start",
    {
      description:
        "Open a phone session. Returns the session id and the current screen. A session scopes policy, " +
        "budgets and the audit trail for one task. Pick the narrowest policy that lets the task finish: " +
        "set allowedApps to the app you actually need.",
      inputSchema: {
        deviceId: z.string().optional().describe('e.g. "android:R5CT30XXXX", "ios:<udid>", "mock:demo". Omit to auto-pick.'),
        platform: z.enum(["android", "ios", "mock"]).optional(),
        mode: z
          .enum(["observe", "guarded", "autonomous"])
          .optional()
          .describe(
            "observe = read-only; guarded (default) = risky actions need human approval; autonomous = log only. " +
              "Capped by the operator's policy — asking for more than it allows is reported, not granted.",
          ),
        allowedApps: z.array(z.string()).optional().describe('package/bundle ids this session may drive; "com.foo.*" globs allowed'),
        allowShell: z.boolean().optional(),
        allowInstall: z.boolean().optional(),
        maxActions: z.number().int().positive().optional(),
        approvalWaitMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("how long a gated action blocks waiting for a human before returning an approvalId (default 45000)"),
      },
    },
    async (a) =>
      guard(async () => {
        const session = await harness.createSession({
          ...(opts.owner ? { owner: opts.owner } : {}),
          ...(a.deviceId ? { deviceId: a.deviceId } : {}),
          ...(a.platform ? { platform: a.platform } : {}),
          ...(a.approvalWaitMs ? { approvalWaitMs: a.approvalWaitMs } : {}),
          policy: {
            ...(a.mode ? { mode: a.mode } : {}),
            ...(a.allowedApps ? { allowedApps: a.allowedApps } : {}),
            ...(a.allowShell !== undefined ? { allowShell: a.allowShell } : {}),
            ...(a.allowInstall !== undefined ? { allowInstall: a.allowInstall } : {}),
            ...(a.maxActions ? { maxActionsPerSession: a.maxActions } : {}),
          },
        });
        const snap = await session.observe();
        const view = session.view(snap);
        const notes = session.notes.length ? `\nnote: ${session.notes.join("\nnote: ")}` : "";
        return text(
          `session ${session.id} on ${session.device.info.name} (${session.device.info.id}), mode=${session.policy.config.mode}` +
            `${notes}\n${identityBlock(session)}\n\n${view.elements}`,
        );
      }),
  );

  server.registerTool(
    "phone_session_status",
    { description: "Session stats: device, mode, actions used, budget, trace path.", inputSchema: { ...sessionShape } },
    async (a) =>
      guard(async () => {
        const s = S(a.sessionId);
        return text(`${JSON.stringify(s.stats(), null, 2)}\n${identityBlock(s)}`);
      }),
  );

  server.registerTool(
    "phone_session_end",
    { description: "Close a session and release the device.", inputSchema: { ...sessionShape } },
    async (a) =>
      guard(async () => {
        const s = S(a.sessionId);
        const stats = s.stats();
        await harness.close(s.id);
        return text(`closed session ${s.id} after ${stats.actions} actions. Trace: ${stats.tracePath}`);
      }),
  );

  // ------------------------------------------------------------- perception

  server.registerTool(
    "phone_observe",
    {
      description:
        "Read the current screen as an element tree with refs. This is the cheap, precise way to see the phone — " +
        "prefer it over screenshots. Refs (e1, e2...) are valid until the screen changes; selectors are safer across changes.",
      inputSchema: {
        ...sessionShape,
        maxChars: z.number().int().positive().optional().describe("budget for the rendered tree (default 6000)"),
        bounds: z.boolean().optional().describe("include full bounds instead of tap centers"),
        screenshotOnBarren: z
          .boolean()
          .optional()
          .describe("attach a screenshot automatically when the accessibility tree is empty (default true)"),
      },
    },
    async (a) =>
      guard(async () => {
        const s = S(a.sessionId);
        const snap = await s.observe();
        const view = s.view(snap, {
          ...(a.maxChars !== undefined ? { maxChars: a.maxChars } : {}),
          ...(a.bounds !== undefined ? { bounds: a.bounds } : {}),
        });
        const body =
          `${renderScreen(view)}\n\n(${view.elementCount} elements shown, ${snap.prunedCount} non-informative pruned` +
          `${view.truncated ? ", output truncated" : ""})`;

        // A barren tree means selectors are useless, so hand over pixels rather
        // than letting the agent stare at an empty screen.
        if (snap.barren && a.screenshotOnBarren !== false) {
          try {
            const shot = await s.screenshot({ maxSize: 1000 });
            return {
              content: [
                { type: "text", text: body },
                { type: "image", data: shot.data.toString("base64"), mimeType: "image/png" },
              ],
            };
          } catch {
            /* fall through to text-only */
          }
        }
        return text(body);
      }),
  );

  server.registerTool(
    "phone_screenshot",
    {
      description:
        "Capture the screen as an image. Use when layout, imagery or custom-drawn UI matters — otherwise phone_observe " +
        "is cheaper and more precise. Password fields are blacked out automatically.",
      inputSchema: {
        ...sessionShape,
        marks: z.boolean().optional().describe("draw numbered boxes matching element refs (set-of-marks)"),
        maxSize: z.number().int().positive().optional().describe("longest edge in pixels (default 1000)"),
      },
    },
    async (a) =>
      guard(async () => {
        const s = S(a.sessionId);
        const shot = await s.screenshot({
          ...(a.marks !== undefined ? { marks: a.marks } : {}),
          ...(a.maxSize !== undefined ? { maxSize: a.maxSize } : {}),
        });
        return {
          content: [
            { type: "image", data: shot.data.toString("base64"), mimeType: "image/png" },
            {
              type: "text",
              text:
                `${shot.width}x${shot.height} png, snapshot ${shot.snapshotId}` +
                (shot.redacted ? "" : " — WARNING: password fields were NOT redacted (no accessibility tree)"),
            },
          ],
        };
      }),
  );

  // ------------------------------------------------------------- input

  server.registerTool(
    "phone_tap",
    {
      description:
        "Tap an element. Target by selector (survives re-renders) or ref. Set durationMs > 500 for a long press. " +
        "Risky targets (pay/send/delete/confirm...) are gated on human approval in guarded mode; if that happens you get " +
        "an approvalId to retry with once a human has approved.",
      inputSchema: {
        ...sessionShape,
        ...targetShape,
        durationMs: z.number().int().positive().optional(),
        approvalId: z.string().optional().describe("pass the id from a previous awaiting_approval error"),
      },
    },
    async (a) =>
      guard(async () =>
        text(
          renderAction(
            await S(a.sessionId).tap(toTarget(a), {
              ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
              ...(a.approvalId ? { approvalId: a.approvalId } : {}),
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "phone_type",
    {
      description:
        "Type text. Give a target to focus a field first, otherwise types into whatever is focused. " +
        "Never put passwords, OTPs, card numbers or ID numbers here — use phone_type_secret.",
      inputSchema: {
        ...sessionShape,
        ...targetShape,
        text: z.string(),
        submit: z.boolean().optional().describe("press enter afterwards"),
        clear: z.boolean().optional().describe("clear the field first"),
      },
    },
    async (a) =>
      guard(async () => {
        const target = optionalTarget(a);
        return text(
          renderAction(
            await S(a.sessionId).type(a.text, {
              ...(target ? { target } : {}),
              ...(a.submit !== undefined ? { submit: a.submit } : {}),
              ...(a.clear !== undefined ? { clear: a.clear } : {}),
            }),
          ),
        );
      }),
  );

  server.registerTool(
    "phone_type_secret",
    {
      description:
        "Type a stored secret by name. The value is never shown to you and never enters the trace or logs. " +
        "Use phone_list_secrets to see the available keys.",
      inputSchema: {
        ...sessionShape,
        ...targetShape,
        key: z.string().describe("secret name, e.g. bank_password"),
        submit: z.boolean().optional(),
        clear: z.boolean().optional(),
      },
    },
    async (a) =>
      guard(async () => {
        const target = optionalTarget(a);
        return text(
          renderAction(
            await S(a.sessionId).typeSecret(a.key, {
              ...(target ? { target } : {}),
              ...(a.submit !== undefined ? { submit: a.submit } : {}),
              ...(a.clear !== undefined ? { clear: a.clear } : {}),
            }),
          ),
        );
      }),
  );

  server.registerTool(
    "phone_list_secrets",
    { description: "Names of secrets available to phone_type_secret. Values are never returned.", inputSchema: {} },
    async () =>
      guard(async () => {
        const { secrets } = await import("../core/secrets.js");
        const keys = secrets.keys();
        return text(keys.length ? keys.join("\n") : "No secrets configured (`agent-phone secret set <key>` on the host).");
      }),
  );

  server.registerTool(
    "phone_key",
    {
      description: "Press a hardware/system key. iOS has no global back key — tap the nav bar button instead.",
      inputSchema: {
        ...sessionShape,
        key: z.enum([
          "back", "home", "recents", "enter", "delete", "tab", "escape",
          "volume_up", "volume_down", "power", "search", "menu",
        ]),
      },
    },
    async (a) => guard(async () => text(renderAction(await S(a.sessionId).pressKey(a.key as KeyName)))),
  );

  server.registerTool(
    "phone_swipe",
    {
      description: "Swipe between two raw points. For list scrolling prefer phone_scroll.",
      inputSchema: {
        ...sessionShape,
        fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(),
        durationMs: z.number().int().positive().optional(),
      },
    },
    async (a) =>
      guard(async () =>
        text(renderAction(await S(a.sessionId).swipe([a.fromX, a.fromY], [a.toX, a.toY], a.durationMs ?? 300))),
      ),
  );

  server.registerTool(
    "phone_scroll",
    {
      description:
        "Scroll the screen or a specific scrollable element. `down` reveals content further down the page.",
      inputSchema: {
        ...sessionShape,
        ...targetShape,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().min(0.1).max(0.9).optional().describe("fraction of the container to travel (default 0.6)"),
      },
    },
    async (a) =>
      guard(async () => {
        const target = optionalTarget(a);
        return text(
          renderAction(
            await S(a.sessionId).scroll(a.direction as Direction, {
              ...(target ? { target } : {}),
              ...(a.amount !== undefined ? { amount: a.amount } : {}),
            }),
          ),
        );
      }),
  );

  server.registerTool(
    "phone_clear_text",
    {
      description: "Clear a text field. Give a target to focus it first.",
      inputSchema: { ...sessionShape, ...targetShape },
    },
    async (a) => guard(async () => text(renderAction(await S(a.sessionId).clearText(optionalTarget(a))))),
  );

  // ------------------------------------------------------------- waiting

  server.registerTool(
    "phone_wait_for",
    {
      description:
        "Block until something appears (or disappears) on screen. Use after actions that trigger network work, " +
        "instead of polling phone_observe.",
      inputSchema: {
        ...sessionShape,
        textContains: z.string().optional(),
        selector: selectorSchema.optional(),
        gone: z.boolean().optional().describe("wait for absence instead of presence"),
        timeoutMs: z.number().int().positive().optional().describe("default 15000"),
      },
    },
    async (a) =>
      guard(async () =>
        text(
          renderAction(
            await S(a.sessionId).waitFor(
              {
                ...(a.selector ? { selector: a.selector } : {}),
                ...(a.textContains ? { textContains: a.textContains } : {}),
                ...(a.gone !== undefined ? { gone: a.gone } : {}),
              },
              { ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}) },
            ),
          ),
        ),
      ),
  );

  // ------------------------------------------------------------- apps

  server.registerTool(
    "phone_list_apps",
    {
      description: "Installed apps (package ids on Android, bundle ids on iOS).",
      inputSchema: { ...sessionShape, thirdPartyOnly: z.boolean().optional() },
    },
    async (a) =>
      guard(async () => {
        const apps = await S(a.sessionId).device.listApps();
        const filtered = a.thirdPartyOnly ? apps.filter((x) => !x.system) : apps;
        return text(filtered.map((x) => `${x.id}${x.name ? `  (${x.name})` : ""}${x.system ? "  [system]" : ""}`).join("\n"));
      }),
  );

  server.registerTool(
    "phone_open_app",
    { description: "Launch an app by package/bundle id and return its first screen.", inputSchema: { ...sessionShape, appId: z.string(), approvalId: z.string().optional() } },
    async (a) =>
      guard(async () =>
        text(renderAction(await S(a.sessionId).openApp(a.appId, { ...(a.approvalId ? { approvalId: a.approvalId } : {}) }))),
      ),
  );

  server.registerTool(
    "phone_stop_app",
    { description: "Force-stop an app.", inputSchema: { ...sessionShape, appId: z.string() } },
    async (a) => guard(async () => text(renderAction(await S(a.sessionId).stopApp(a.appId)))),
  );

  server.registerTool(
    "phone_open_url",
    {
      description:
        "Open a URL or deep link. Deep links usually skip many taps of navigation — reach for this before " +
        "driving the UI by hand.",
      inputSchema: { ...sessionShape, url: z.string(), approvalId: z.string().optional() },
    },
    async (a) =>
      guard(async () =>
        text(renderAction(await S(a.sessionId).openUrl(a.url, { ...(a.approvalId ? { approvalId: a.approvalId } : {}) }))),
      ),
  );

  server.registerTool(
    "phone_clear_app_data",
    {
      description: "Wipe an app's local data (destructive; needs policy + human approval).",
      inputSchema: { ...sessionShape, appId: z.string(), approvalId: z.string().optional() },
    },
    async (a) =>
      guard(async () =>
        text(renderAction(await S(a.sessionId).clearAppData(a.appId, { ...(a.approvalId ? { approvalId: a.approvalId } : {}) }))),
      ),
  );

  server.registerTool(
    "phone_install_app",
    {
      description: "Install an APK/.app from a path on the host (needs policy + human approval).",
      inputSchema: { ...sessionShape, path: z.string(), approvalId: z.string().optional() },
    },
    async (a) =>
      guard(async () =>
        text(renderAction(await S(a.sessionId).installApp(a.path, { ...(a.approvalId ? { approvalId: a.approvalId } : {}) }))),
      ),
  );

  server.registerTool(
    "phone_shell",
    {
      description: "Run a shell command on the device (Android only; disabled unless the policy allows it).",
      inputSchema: { ...sessionShape, command: z.string(), approvalId: z.string().optional() },
    },
    async (a) =>
      guard(async () =>
        text(renderAction(await S(a.sessionId).shell(a.command, { ...(a.approvalId ? { approvalId: a.approvalId } : {}) }))),
      ),
  );

  server.registerTool(
    "phone_batch",
    {
      description:
        "Run several actions in one call. Use this whenever you can predict two or more steps ahead — " +
        "filling a login form, stepping through a wizard, entering an OTP then submitting. It is the single " +
        "biggest saving available to you: five separate tool calls become one.\n\n" +
        "Each step re-resolves its own selector against a fresh screen, so a batch never acts on stale " +
        "coordinates. Execution stops at the first failure and you get back exactly which steps ran, what " +
        "failed and why, plus the full screen where it stopped. If a step needs human approval the batch " +
        "halts there and hands you the approvalId.\n\n" +
        "Do not batch steps you cannot predict — if you need to see a screen before deciding, stop the batch there.",
      inputSchema: {
        ...sessionShape,
        steps: z
          .array(
            z.object({
              action: z.enum([
                "tap", "type", "type_secret", "key", "clear_text",
                "swipe", "scroll", "wait_for", "open_app", "open_url",
              ]),
              ref: z.string().optional(),
              selector: selectorSchema.optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              text: z.string().optional().describe("for type"),
              key: z.string().optional().describe("secret name for type_secret, or key name for key"),
              submit: z.boolean().optional(),
              clear: z.boolean().optional(),
              durationMs: z.number().optional(),
              direction: z.enum(["up", "down", "left", "right"]).optional().describe("for scroll"),
              amount: z.number().optional(),
              fromX: z.number().optional(), fromY: z.number().optional(),
              toX: z.number().optional(), toY: z.number().optional(),
              textContains: z.string().optional().describe("for wait_for"),
              gone: z.boolean().optional(),
              timeoutMs: z.number().optional(),
              appId: z.string().optional().describe("for open_app"),
              url: z.string().optional().describe("for open_url"),
              approvalId: z.string().optional(),
            }),
          )
          .min(1)
          .max(20),
        stopOnError: z.boolean().optional().describe("default true; false runs every step regardless"),
      },
    },
    async (a) =>
      guard(async () => {
        const steps = a.steps.map((raw) => {
          const step = { ...raw } as Record<string, unknown>;
          // `key` carries a secret name for type_secret and a key name for key.
          if (raw.action === "key") step.key = raw.key;
          return step;
        }) as unknown as BatchStep[];

        const r = await S(a.sessionId).batch(steps, {
          ...(a.stopOnError !== undefined ? { stopOnError: a.stopOnError } : {}),
        });

        return text(renderBatch(r));
      }),
  );

  server.registerTool(
    "phone_list_deep_links",
    {
      description:
        "List the URLs an app declares as entry points. Opening one with phone_open_url usually replaces a " +
        "whole sequence of taps, so check here before navigating by hand. Android only. " +
        "Paths may need a real id substituted; if a link does not land where you expect, fall back to tapping.",
      inputSchema: { ...sessionShape, appId: z.string().optional().describe("defaults to the foreground app") },
    },
    async (a) =>
      guard(async () => {
        const links = await S(a.sessionId).deepLinks(a.appId);
        if (!links.length) return text("This app declares no externally launchable deep links.");
        return text(
          links
            .map((l) => `${l.example}${l.activity ? `    → ${l.activity}` : ""}`)
            .join("\n"),
        );
      }),
  );

  // ------------------------------------------------------------- side channels

  server.registerTool(
    "phone_read_sms",
    {
      description:
        "Read recent text messages from every source the operator connected: SMS on the device, a rented " +
        "number, a relay phone, a mailbox. For a one-time code use phone_wait_for_otp instead.",
      inputSchema: {
        ...sessionShape,
        limit: z.number().int().positive().optional(),
        sinceMinutes: z.number().positive().optional().describe("only messages newer than this (default 24h)"),
      },
    },
    async (a) =>
      guard(async () => {
        const r = await S(a.sessionId).readMessages({
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
          ...(a.sinceMinutes !== undefined ? { sinceMs: Date.now() - a.sinceMinutes * 60_000 } : {}),
        });
        const lines = r.messages.map(
          (m) => `[${new Date(m.receivedAt).toISOString()}] (${m.origin}) ${m.from}: ${m.body.replace(/\s+/g, " ").slice(0, 400)}`,
        );
        const errs = r.errors.map((e) => `(could not read ${e.source}: ${e.error})`);
        return text([...(lines.length ? lines : ["no messages"]), ...errs].join("\n"));
      }),
  );

  server.registerTool(
    "phone_read_notifications",
    {
      description: "Read the notification shade. Works when SMS access is unavailable, and catches in-app push codes.",
      inputSchema: { ...sessionShape, limit: z.number().int().positive().optional() },
    },
    async (a) =>
      guard(async () => {
        const items = await S(a.sessionId).readNotifications({ ...(a.limit !== undefined ? { limit: a.limit } : {}) });
        if (!items.length) return text("no notifications");
        return text(items.map((n) => `${n.pkg}: ${[n.title, n.text].filter(Boolean).join(" — ")}`).join("\n"));
      }),
  );

  server.registerTool(
    "phone_wait_for_otp",
    {
      description:
        "Wait for a one-time code (SMS, the operator's connected number, email, or a notification) and either " +
        "return it or type it for you. This is how a 2FA step gets completed without a human.\n\n" +
        "Prefer enter:true with the code field as target — the code is typed directly and one call replaces " +
        "two. A code is never returned twice, so after a failed attempt this waits for the new one.",
      inputSchema: {
        ...sessionShape,
        ...targetShape,
        enter: z.boolean().optional().describe("type the code into the target (or the focused field) instead of returning it"),
        submit: z.boolean().optional().describe("with enter: press enter afterwards"),
        fromContains: z.string().optional().describe("filter by sender"),
        bodyContains: z.string().optional().describe("filter by message content, e.g. the brand name"),
        digits: z.number().int().min(4).max(8).optional().describe("exact code length, if known"),
        timeoutMs: z.number().int().positive().optional().describe("default 60000"),
      },
    },
    async (a) =>
      guard(async () => {
        const target = optionalTarget(a);
        const r = await S(a.sessionId).waitForOtp({
          ...(a.fromContains ? { fromContains: a.fromContains } : {}),
          ...(a.bodyContains ? { bodyContains: a.bodyContains } : {}),
          ...(a.digits !== undefined ? { digits: a.digits } : {}),
          ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
          ...(a.enter ? { enter: true } : {}),
          ...(target ? { target } : {}),
          ...(a.submit !== undefined ? { submit: a.submit } : {}),
        });
        if (r.entered && r.result) {
          return text(`code from ${r.message.from} (${r.message.origin}) entered\n${renderAction(r.result)}`);
        }
        return text(`code: ${r.code}\nfrom ${r.message.from} via ${r.message.origin}`);
      }),
  );

  server.registerTool(
    "phone_request_human",
    {
      description:
        "Ask the phone's owner to step in. Use it for anything you must not or cannot do yourself: a CAPTCHA, " +
        "a Google or Apple sign-in, a biometric prompt, a device-verification wall, an ambiguous decision. " +
        "The owner is notified, takes control of the phone, and hands it back.\n\n" +
        "Returns status done, declined, or pending. On pending, call again with the same handoffId to keep " +
        "waiting and do nothing else on the phone meanwhile. After done, observe before continuing — the " +
        "screen will have changed.",
      inputSchema: {
        ...sessionShape,
        reason: z.string().describe("what you need the human to do, in one sentence"),
        handoffId: z.string().optional().describe("continue waiting on an earlier request"),
        waitSeconds: z.number().int().min(1).max(55).optional().describe("how long to block this call (default 45)"),
      },
    },
    async (a) =>
      guard(async () => {
        const r = await S(a.sessionId).requestHuman(a.reason, {
          ...(a.handoffId ? { handoffId: a.handoffId } : {}),
          ...(a.waitSeconds ? { waitMs: a.waitSeconds * 1000 } : {}),
        });
        return text(renderHandoff(r).replace("Call request_human", "Call phone_request_human"));
      }),
  );

  server.registerTool(
    "phone_clipboard",
    {
      description: "Read or write the device clipboard. Useful for pasting long or non-ASCII text.",
      inputSchema: { ...sessionShape, action: z.enum(["get", "set"]), text: z.string().optional() },
    },
    async (a) => guard(async () => text(await S(a.sessionId).clipboard(a.action, a.text ?? ""))),
  );
}
