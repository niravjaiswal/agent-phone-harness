import { randomUUID } from "node:crypto";
import { AuditLog } from "./audit.js";
import { approvals, type ApprovalStore } from "./approvals.js";
import { err, HarnessError } from "./errors.js";
import { sleep } from "./exec.js";
import { annotateScreenshot } from "./image.js";
import { logger } from "./logger.js";
import { Policy, type ActionDescriptor, type PolicyConfig } from "./policy.js";
import { secrets, type SecretStore } from "./secrets.js";
import {
  diffSnapshots, hashElements, pruneElements, renderElements, resolveSelector,
  type RenderOptions,
} from "./elements.js";
import type {
  Device, Direction, KeyName, Message, NotificationItem, Selector,
  Snapshot, Target, UiElement,
} from "./types.js";

const log = logger("session");

export interface SessionOptions {
  policy?: Partial<PolicyConfig>;
  /**
   * How long to block waiting for a human approval before handing the id back.
   * Default 45s — comfortably under the 60s request timeout most MCP clients
   * use, so the agent sees a clean retryable error rather than a dead transport.
   */
  approvalWaitMs?: number;
  /** Attach a screenshot artifact to every action's trace entry. Default false. */
  traceScreenshots?: boolean;
  secretStore?: SecretStore;
  approvalStore?: ApprovalStore;
  render?: RenderOptions;
}

export interface ScreenView {
  snapshotId: string;
  app?: string;
  activity?: string;
  size: { width: number; height: number };
  /** Rendered element tree for the model. */
  elements: string;
  elementCount: number;
  truncated: boolean;
}

export interface ActionResult {
  ok: true;
  action: string;
  /** Human-readable description of what was touched. */
  target?: string;
  note?: string;
  /** Did the UI stop changing before the deadline? */
  settled: boolean;
  changed: boolean;
  change: string;
  screen: ScreenView;
  data?: unknown;
  screenshotPath?: string;
}

export interface ObserveOptions {
  /** Force a fresh dump even if a recent snapshot exists. Default true. */
  fresh?: boolean;
  maxChars?: number;
  bounds?: boolean;
}

export interface SettleOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Consecutive identical dumps required. Default 2. */
  stableCount?: number;
}

const READ_ONLY_KINDS = new Set<string>(["observe", "screenshot", "read_sms", "read_notifications", "clipboard_get"]);

const IDENT = (e: UiElement) => `${e.role}|${e.text ?? ""}|${e.label ?? ""}|${e.id ?? ""}`;

/**
 * One agent ↔ one device, for one task.
 *
 * Owns the action pipeline: classify → policy → (approval) → execute → settle →
 * diff → audit. Every mutating call returns the *resulting* screen, so an agent
 * never needs a separate observe round-trip.
 */
export class Session {
  readonly id: string;
  readonly policy: Policy;
  readonly audit: AuditLog;
  readonly startedAt = Date.now();

  private snapshot?: Snapshot;
  private actionCount = 0;
  private closed = false;
  private readonly approvalWaitMs: number;
  private readonly secretStore: SecretStore;
  private readonly approvalStore: ApprovalStore;
  private readonly renderOpts: RenderOptions;
  private readonly traceScreenshots: boolean;

  constructor(readonly device: Device, opts: SessionOptions = {}) {
    this.id = randomUUID().slice(0, 8);
    this.policy = new Policy(opts.policy);
    this.audit = new AuditLog(this.id);
    this.approvalWaitMs = opts.approvalWaitMs ?? 45_000;
    this.secretStore = opts.secretStore ?? secrets;
    this.approvalStore = opts.approvalStore ?? approvals;
    this.renderOpts = opts.render ?? {};
    this.traceScreenshots = opts.traceScreenshots ?? false;
    this.audit.meta({
      sessionId: this.id,
      device: device.info,
      policy: this.policy.config,
      startedAt: this.startedAt,
    });
    log.info(`session ${this.id} on ${device.info.id} (${this.policy.config.mode})`);
  }

  // ---------------------------------------------------------------- perception

  async observe(opts: ObserveOptions = {}): Promise<Snapshot> {
    if (opts.fresh === false && this.snapshot) return this.snapshot;
    const { elements, screen, prunedCount } = await this.device.dumpUi();
    const { kept, prunedCount: extraPruned } = pruneElements(elements, screen);
    const snap: Snapshot = {
      snapshotId: randomUUID().slice(0, 8),
      deviceId: this.device.info.id,
      takenAt: Date.now(),
      screen,
      elements: kept,
      prunedCount: prunedCount + extraPruned,
      truncated: false,
      hash: hashElements(kept, screen),
    };
    this.snapshot = snap;
    return snap;
  }

  view(snap: Snapshot, opts: ObserveOptions = {}): ScreenView {
    const rendered = renderElements(snap.elements, snap.screen, {
      ...this.renderOpts,
      ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      ...(opts.bounds !== undefined ? { bounds: opts.bounds } : {}),
    });
    return {
      snapshotId: snap.snapshotId,
      app: snap.screen.app,
      activity: snap.screen.activity,
      size: { width: snap.screen.width, height: snap.screen.height },
      elements: rendered.text,
      elementCount: snap.elements.length,
      truncated: rendered.truncated,
    };
  }

  /**
   * Screenshot with password redaction and optional set-of-marks numbering.
   *
   * Redaction needs the accessibility tree to know *where* the password fields
   * are. If the tree is unavailable (iOS with no WebDriverAgent, a FLAG_SECURE
   * window) the harness refuses rather than quietly handing back an unredacted
   * capture — unless the session has explicitly turned redaction off.
   */
  async screenshot(opts: { marks?: boolean; maxSize?: number } = {}): Promise<{
    data: Buffer; width: number; height: number; snapshotId: string; redacted: boolean;
  }> {
    this.policy.assertAllowed({ kind: "screenshot" });

    let snap: Snapshot | undefined;
    let dumpError: unknown;
    try {
      snap = await this.observe();
    } catch (e) {
      dumpError = e;
    }

    if (!snap) {
      if (this.policy.config.redactPasswordFields) {
        throw err(
          "unsupported",
          "Cannot capture safely: the accessibility tree is unavailable, so password fields cannot be located and blacked out",
          {
            hint:
              "Start WebDriverAgent (iOS), wake the device, or set redactPasswordFields:false on the session " +
              "to accept unredacted captures.",
            cause: dumpError,
          },
        );
      }
      const raw = await this.device.screenshot();
      const out = annotateScreenshot(raw.data, { maxSize: opts.maxSize ?? 1000 });
      return { data: out.data, width: out.width, height: out.height, snapshotId: "none", redacted: false };
    }

    const raw = await this.device.screenshot();
    const redact = this.policy.config.redactPasswordFields
      ? snap.elements.filter((e) => e.password)
      : [];
    const marks = opts.marks ? snap.elements.filter((e) => e.clickable || e.scrollable) : [];
    const out = annotateScreenshot(raw.data, {
      deviceSize: { width: snap.screen.width, height: snap.screen.height },
      redact,
      marks,
      maxSize: opts.maxSize ?? 1000,
    });
    return {
      data: out.data,
      width: out.width,
      height: out.height,
      snapshotId: snap.snapshotId,
      redacted: this.policy.config.redactPasswordFields,
    };
  }

  // ---------------------------------------------------------------- targeting

  /**
   * Resolve a target against a *fresh* dump.
   *
   * Refs are revalidated by identity, not position: if `e7` now points at a
   * different element the harness re-finds the original by role/text/label/id,
   * and refuses rather than tapping the wrong thing.
   */
  async resolveTarget(target: Target): Promise<{ element?: UiElement; point: [number, number]; label: string }> {
    try {
      return await this.resolveTargetInner(target);
    } catch (e) {
      this.audit.record({
        kind: "resolve_failed",
        ok: false,
        args: { target: JSON.stringify(target) },
        error: e instanceof Error ? e.message : String(e),
        screenHash: this.snapshot?.hash,
      });
      throw e;
    }
  }

  private async resolveTargetInner(
    target: Target,
  ): Promise<{ element?: UiElement; point: [number, number]; label: string }> {
    if ("point" in target) {
      return { point: target.point, label: `point ${target.point.join(",")}` };
    }

    const cached = this.snapshot;
    const fresh = await this.observe();

    if ("ref" in target) {
      const before = cached?.elements.find((e) => e.ref === target.ref);
      const now = fresh.elements.find((e) => e.ref === target.ref);
      if (before && now && IDENT(before) === IDENT(now)) {
        return { element: now, point: now.center, label: describe(now) };
      }
      if (before) {
        const same = fresh.elements.filter((e) => IDENT(e) === IDENT(before));
        if (same.length === 1) {
          return { element: same[0]!, point: same[0]!.center, label: describe(same[0]!) };
        }
      }
      if (!before && now) {
        return { element: now, point: now.center, label: describe(now) };
      }
      throw err("stale_ref", `Ref ${target.ref} no longer matches the current screen`, {
        hint: "Call phone_observe to get fresh refs, or target by selector (text/id) which re-resolves automatically.",
      });
    }

    const res = resolveSelector(fresh.elements, target.selector);
    if (res.element) return { element: res.element, point: res.element.center, label: describe(res.element) };
    if (res.reason === "ambiguous") {
      throw err("ambiguous", `Selector matched ${res.matches.length} elements`, {
        hint: "Add `index`, or narrow with role/id.",
        details: { matches: res.matches.slice(0, 10).map(describe) },
      });
    }
    throw err("no_match", `No element matched ${JSON.stringify(target.selector)}`, {
      hint: "Call phone_observe to see what is on screen; the element may need scrolling into view.",
      details: { onScreen: fresh.elements.slice(0, 25).map(describe) },
    });
  }

  // ---------------------------------------------------------------- actions

  async tap(target: Target, opts: { durationMs?: number; approvalId?: string } = {}): Promise<ActionResult> {
    const { element, point, label } = await this.resolveTarget(target);
    if (element && !element.enabled) {
      throw err("bad_request", `${label} is disabled`, {
        hint: "Something earlier in the form is probably incomplete.",
      });
    }
    return this.perform(
      opts.durationMs && opts.durationMs > 500 ? "long_press" : "tap",
      {
        kind: opts.durationMs && opts.durationMs > 500 ? "long_press" : "tap",
        targetText: element ? [element.text, element.label, element.id].filter(Boolean).join(" ") : undefined,
        appId: this.snapshot?.screen.app,
      },
      label,
      () => this.device.tap(point[0], point[1], opts.durationMs),
      opts.approvalId,
    );
  }

  async type(
    text: string,
    opts: { target?: Target; submit?: boolean; clear?: boolean; approvalId?: string } = {},
  ): Promise<ActionResult> {
    let label = "focused field";
    if (opts.target) {
      const t = await this.resolveTarget(opts.target);
      label = t.label;
      await this.device.tap(t.point[0], t.point[1]);
      await sleep(250);
    }
    return this.perform(
      "type",
      { kind: "type", text, targetText: label, appId: this.snapshot?.screen.app },
      `${label} ← ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}`,
      async () => {
        if (opts.clear) await this.device.clearText();
        await this.device.typeText(text, { submit: opts.submit });
      },
      opts.approvalId,
    );
  }

  /** Type a stored secret. The value never appears in results, traces or logs. */
  async typeSecret(
    key: string,
    opts: { target?: Target; submit?: boolean; clear?: boolean } = {},
  ): Promise<ActionResult> {
    const value = this.secretStore.get(key);
    let label = "focused field";
    if (opts.target) {
      const t = await this.resolveTarget(opts.target);
      label = t.label;
      await this.device.tap(t.point[0], t.point[1]);
      await sleep(250);
    }
    return this.perform(
      "type_secret",
      { kind: "type_secret", targetText: label, appId: this.snapshot?.screen.app },
      `${label} ← «secret:${key}»`,
      async () => {
        if (opts.clear) await this.device.clearText();
        await this.device.typeText(value, { submit: opts.submit });
      },
    );
  }

  async pressKey(key: KeyName): Promise<ActionResult> {
    return this.perform("key", { kind: "key", targetText: key }, key, () => this.device.pressKey(key));
  }

  async clearText(target?: Target): Promise<ActionResult> {
    if (target) {
      const t = await this.resolveTarget(target);
      await this.device.tap(t.point[0], t.point[1]);
      await sleep(200);
    }
    return this.perform("clear_text", { kind: "clear_text" }, "field", () => this.device.clearText());
  }

  async swipe(from: [number, number], to: [number, number], durationMs = 300): Promise<ActionResult> {
    return this.perform(
      "swipe",
      { kind: "swipe" },
      `${from.join(",")} → ${to.join(",")}`,
      () => this.device.swipe(from, to, durationMs),
    );
  }

  /** Scroll inside a scrollable element if given one, else the whole screen. */
  async scroll(direction: Direction, opts: { target?: Target; amount?: number } = {}): Promise<ActionResult> {
    const snap = await this.observe();
    let box = { x: 0, y: 0, width: snap.screen.width, height: snap.screen.height };
    let label = "screen";
    if (opts.target) {
      const t = await this.resolveTarget(opts.target);
      if (t.element) {
        box = t.element.bounds;
        label = t.label;
      }
    } else {
      const scroller = snap.elements.find((e) => e.scrollable);
      if (scroller) {
        box = scroller.bounds;
        label = describe(scroller);
      }
    }
    const amount = Math.min(Math.max(opts.amount ?? 0.6, 0.1), 0.9);
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    const dx = Math.round((box.width * amount) / 2);
    const dy = Math.round((box.height * amount) / 2);
    // Content moves opposite to the finger: to scroll *down* you drag *up*.
    const map: Record<Direction, [[number, number], [number, number]]> = {
      down: [[cx, cy + dy], [cx, cy - dy]],
      up: [[cx, cy - dy], [cx, cy + dy]],
      right: [[cx + dx, cy], [cx - dx, cy]],
      left: [[cx - dx, cy], [cx + dx, cy]],
    };
    const [from, to] = map[direction];
    return this.perform(
      "scroll",
      { kind: "scroll", appId: snap.screen.app },
      `${direction} in ${label}`,
      () => this.device.swipe(from, to, 300),
    );
  }

  async openApp(appId: string, opts: { approvalId?: string } = {}): Promise<ActionResult> {
    return this.perform(
      "open_app",
      { kind: "open_app", appId, targetText: appId },
      appId,
      () => this.device.launchApp(appId),
      opts.approvalId,
    );
  }

  async stopApp(appId: string): Promise<ActionResult> {
    return this.perform("stop_app", { kind: "stop_app", appId }, appId, () => this.device.stopApp(appId));
  }

  async clearAppData(appId: string, opts: { approvalId?: string } = {}): Promise<ActionResult> {
    // Policy first: "denied by policy" is the accurate answer even on a device
    // that happens not to support the capability.
    this.policy.assertAllowed({ kind: "clear_app_data", appId, targetText: `clear data for ${appId}` });
    if (!this.device.clearAppData) throw err("unsupported", "provider cannot clear app data");
    return this.perform(
      "clear_app_data",
      { kind: "clear_app_data", appId, targetText: `clear data for ${appId}` },
      appId,
      () => this.device.clearAppData!(appId),
      opts.approvalId,
    );
  }

  async installApp(path: string, opts: { approvalId?: string } = {}): Promise<ActionResult> {
    this.policy.assertAllowed({ kind: "install_app", targetText: `install ${path}` });
    if (!this.device.installApp) throw err("unsupported", "provider cannot install apps");
    return this.perform(
      "install_app",
      { kind: "install_app", targetText: `install ${path}` },
      path,
      () => this.device.installApp!(path),
      opts.approvalId,
    );
  }

  /** Deep links skip whole navigation trees — usually the fastest route to a screen. */
  async openUrl(url: string, opts: { approvalId?: string } = {}): Promise<ActionResult> {
    return this.perform(
      "open_url",
      { kind: "open_url", url, targetText: url },
      url,
      () => this.device.openUrl(url),
      opts.approvalId,
    );
  }

  async shell(command: string, opts: { approvalId?: string } = {}): Promise<ActionResult> {
    this.policy.assertAllowed({ kind: "shell", command, targetText: command });
    if (!this.device.shell) throw err("unsupported", "provider has no shell");
    let output = "";
    const res = await this.perform(
      "shell",
      { kind: "shell", command, targetText: command },
      command,
      async () => {
        output = await this.device.shell!(command);
      },
      opts.approvalId,
      { settle: false },
    );
    return { ...res, data: { output: this.secretStore.redact(output) } };
  }

  // ---------------------------------------------------------------- side channels

  async readSms(opts: { limit?: number; sinceMs?: number } = {}): Promise<Message[]> {
    this.policy.assertAllowed({ kind: "read_sms" });
    if (!this.device.readSms) throw err("unsupported", "provider cannot read SMS");
    const msgs = await this.device.readSms(opts);
    this.audit.record({ kind: "read_sms", ok: true, result: { count: msgs.length } });
    return msgs;
  }

  async readNotifications(opts: { limit?: number } = {}): Promise<NotificationItem[]> {
    this.policy.assertAllowed({ kind: "read_notifications" });
    if (!this.device.readNotifications) throw err("unsupported", "provider cannot read notifications");
    const n = await this.device.readNotifications(opts);
    this.audit.record({ kind: "read_notifications", ok: true, result: { count: n.length } });
    return n;
  }

  /**
   * Poll SMS + notifications for a one-time code.
   *
   * This is the single feature that turns "agent gets stuck at 2FA" into
   * "agent finishes the signup".
   */
  async waitForOtp(
    opts: { fromContains?: string; bodyContains?: string; digits?: number; timeoutMs?: number; sinceMs?: number } = {},
  ): Promise<{ code: string; message: Message | NotificationItem }> {
    const digits = opts.digits ?? 6;
    const since = opts.sinceMs ?? Date.now() - 60_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    const re = new RegExp(`(?<!\\d)(\\d{${digits}})(?!\\d)`);

    while (Date.now() < deadline) {
      const candidates: { from: string; body: string; raw: Message | NotificationItem }[] = [];
      if (this.device.readSms) {
        for (const m of await this.device.readSms({ limit: 15, sinceMs: since })) {
          candidates.push({ from: m.from, body: m.body, raw: m });
        }
      }
      if (this.device.readNotifications) {
        for (const n of await this.device.readNotifications({ limit: 15 })) {
          if (n.timestamp && n.timestamp < since) continue;
          candidates.push({ from: n.title ?? n.pkg, body: `${n.title ?? ""} ${n.text ?? ""}`, raw: n });
        }
      }
      for (const c of candidates) {
        if (opts.fromContains && !c.from.toLowerCase().includes(opts.fromContains.toLowerCase())) continue;
        if (opts.bodyContains && !c.body.toLowerCase().includes(opts.bodyContains.toLowerCase())) continue;
        const m = re.exec(c.body);
        if (m?.[1]) {
          this.audit.record({ kind: "wait_for_otp", ok: true, result: { from: c.from, digits } });
          return { code: m[1], message: c.raw };
        }
      }
      await sleep(2000);
    }
    throw err("timeout", `No ${digits}-digit code arrived within the timeout`, {
      hint: "Check the device has signal / the code was actually sent; widen `digits` or drop `fromContains`.",
    });
  }

  // ---------------------------------------------------------------- waiting

  async waitFor(
    cond: { selector?: Selector; textContains?: string; gone?: boolean },
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<ActionResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    const selector: Selector = cond.selector ?? { textContains: cond.textContains ?? "" };
    for (;;) {
      const snap = await this.observe();
      const res = resolveSelector(snap.elements, selector);
      const present = res.matches.length > 0;
      if (present !== Boolean(cond.gone)) {
        return this.result("wait_for", JSON.stringify(selector), true, snap, undefined, {
          matched: res.matches.slice(0, 5).map(describe),
        });
      }
      if (Date.now() > deadline) {
        throw err("timeout", `Timed out waiting for ${cond.gone ? "absence of " : ""}${JSON.stringify(selector)}`, {
          hint: "Call phone_observe to see the current screen.",
          details: { onScreen: snap.elements.slice(0, 20).map(describe) },
        });
      }
      await sleep(opts.intervalMs ?? 500);
    }
  }

  /** Poll until the UI stops changing. Keeps agents from acting on half-drawn screens. */
  async waitForSettle(opts: SettleOptions = {}): Promise<{ settled: boolean; snapshot: Snapshot }> {
    const timeoutMs = opts.timeoutMs ?? 4000;
    const intervalMs = opts.intervalMs ?? 250;
    const need = opts.stableCount ?? 2;
    const deadline = Date.now() + timeoutMs;
    let last = "";
    let stable = 0;
    let snap = await this.observe();
    for (;;) {
      if (snap.hash === last) stable++;
      else stable = 1;
      last = snap.hash;
      if (stable >= need) return { settled: true, snapshot: snap };
      if (Date.now() > deadline) return { settled: false, snapshot: snap };
      await sleep(intervalMs);
      snap = await this.observe();
    }
  }

  // ---------------------------------------------------------------- pipeline

  private async perform(
    name: string,
    descriptor: ActionDescriptor,
    label: string,
    run: () => Promise<void>,
    approvalId?: string,
    opts: { settle?: boolean } = {},
  ): Promise<ActionResult> {
    this.assertOpen();
    this.assertBudget();

    // Without a baseline the first action reports "initial screen" and, worse,
    // app scoping has no current app to check against. Perception can legitimately
    // be unavailable (iOS with no WebDriverAgent), so this must not be fatal on
    // its own — but it does mean app scoping cannot be verified.
    let before = this.snapshot;
    if (!before) {
      try {
        before = await this.observe();
      } catch (e) {
        log.warn(`baseline observe failed before ${name}`, (e as Error).message);
      }
    }
    if (descriptor.appId === undefined) descriptor.appId = before?.screen.app;

    if (descriptor.appId === undefined && this.policy.config.allowedApps.length && !READ_ONLY_KINDS.has(descriptor.kind)) {
      throw err("policy_denied", `Cannot verify which app is in the foreground, and this session is scoped to ${this.policy.config.allowedApps.join(", ")}`, {
        hint: "Restore perception (start WebDriverAgent / wake the device), or drop allowedApps for this session.",
      });
    }

    const decision = this.policy.evaluate(descriptor);

    if (decision.risk === "deny") {
      const e = err("policy_denied", `Action "${name}" on ${label} denied: ${decision.reason}`, {
        hint: "A human must do this step, or the session policy must be widened deliberately.",
        details: { reason: decision.reason },
      });
      this.audit.record({ kind: name, ok: false, args: { label }, error: e.message });
      throw e;
    }

    if (decision.risk === "confirm") {
      await this.gate(name, descriptor, label, decision.reason, approvalId);
    }

    const started = Date.now();
    this.actionCount++;
    try {
      await run();
    } catch (e) {
      const msg = this.secretStore.redact(e instanceof Error ? e.message : String(e));
      this.audit.record({ kind: name, ok: false, args: { label }, error: msg, durationMs: Date.now() - started });
      throw e;
    }

    // The side effect has now happened. From here on, failing to *read* the
    // result must never be reported as the action having failed — an agent that
    // retries a completed payment is worse than an agent with a blind spot.
    let settled = true;
    let snapshot: Snapshot | undefined;
    let observeError: string | undefined;
    try {
      if (opts.settle === false) {
        snapshot = await this.observe();
      } else {
        const r = await this.waitForSettle();
        settled = r.settled;
        snapshot = r.snapshot;
      }
    } catch (e) {
      observeError = e instanceof Error ? e.message : String(e);
      settled = false;
      this.snapshot = undefined;
      log.warn(`${name} succeeded but the screen could not be read`, observeError);
    }

    const result = snapshot
      ? this.result(name, label, settled, snapshot, before)
      : this.blindResult(name, label, observeError ?? "unknown");

    let shotPath: string | undefined;
    if (this.traceScreenshots) {
      try {
        const s = await this.screenshot();
        shotPath = this.audit.saveScreen(s.data, name);
      } catch {
        /* screenshots are best-effort evidence, never a reason to fail an action */
      }
    }

    this.audit.record({
      kind: name,
      ok: true,
      args: { label: this.secretStore.redact(label) },
      result: { changed: result.changed, change: result.change, app: snapshot?.screen.app, observeError },
      durationMs: Date.now() - started,
      screenHash: snapshot?.hash,
      screenshot: shotPath,
    });

    return shotPath ? { ...result, screenshotPath: shotPath } : result;
  }

  /**
   * Route a risky action to a human.
   *
   * The approval is created in a shared store and decided by an operator via
   * CLI/HTTP/webhook. No agent-callable path reaches `decide`.
   */
  private async gate(
    name: string,
    descriptor: ActionDescriptor,
    label: string,
    reason: string,
    approvalId?: string,
  ): Promise<void> {
    if (approvalId) {
      const existing = this.approvalStore.get(approvalId);
      if (!existing) throw err("bad_request", `No approval ${approvalId}`);
      if (existing.sessionId !== this.id) throw err("policy_denied", `Approval ${approvalId} belongs to another session`);
      if (existing.action.kind !== descriptor.kind) {
        throw err("policy_denied", `Approval ${approvalId} was for ${existing.action.kind}, not ${descriptor.kind}`);
      }
      if (existing.status === "approved") return;
      throw err("policy_denied", `Approval ${approvalId} is ${existing.status}`);
    }

    let evidence: string | undefined;
    try {
      const s = await this.screenshot();
      evidence = this.audit.saveScreen(s.data, `approval-${name}`);
    } catch {
      /* evidence is best effort */
    }

    const req = this.approvalStore.create({
      sessionId: this.id,
      action: descriptor,
      summary: `${name}: ${label}`,
      reason,
      ...(evidence ? { evidence } : {}),
    });
    this.audit.record({ kind: "approval_requested", ok: true, args: { label, reason }, result: { id: req.id } });

    const decided = await this.approvalStore.waitFor(req.id, this.approvalWaitMs);
    if (decided.status === "approved") {
      this.audit.record({ kind: "approval_granted", ok: true, result: { id: req.id, by: decided.decidedBy } });
      return;
    }
    this.audit.record({ kind: "approval_refused", ok: false, result: { id: req.id, status: decided.status } });
    throw err(
      decided.status === "denied" ? "policy_denied" : "awaiting_approval",
      decided.status === "denied"
        ? `A human denied this action (${req.id})${decided.note ? `: ${decided.note}` : ""}`
        : `Action "${name}" needs human approval (id ${req.id}); still pending.`,
      {
        hint:
          decided.status === "denied"
            ? "Do not retry. Report the refusal and stop."
            : `Wait, then retry this call passing approvalId="${req.id}". An operator approves with \`phone approve ${req.id}\`.`,
        details: { approvalId: req.id, status: decided.status, summary: req.summary, evidence },
      },
    );
  }

  /** The action happened; the screen did not come back. Say so loudly. */
  private blindResult(action: string, target: string, reason: string): ActionResult {
    const size = this.device.info.screen ?? { width: 0, height: 0 };
    return {
      ok: true,
      action,
      target,
      settled: false,
      changed: false,
      change: "action completed, but the resulting screen could not be read",
      note:
        `The action WAS performed — do not retry it. The screen could not be read afterwards: ${reason}`,
      screen: {
        snapshotId: "none",
        size,
        elements: `(screen unavailable: ${reason})`,
        elementCount: 0,
        truncated: false,
      },
    };
  }

  private result(
    action: string,
    target: string,
    settled: boolean,
    snapshot: Snapshot,
    before?: Snapshot,
    data?: unknown,
  ): ActionResult {
    const diff = diffSnapshots(before, snapshot);
    return {
      ok: true,
      action,
      target,
      settled,
      changed: diff.changed,
      change: diff.summary,
      screen: this.view(snapshot),
      ...(data !== undefined ? { data } : {}),
      ...(settled ? {} : { note: "UI was still changing when the settle timeout elapsed" }),
    };
  }

  private assertOpen() {
    if (this.closed) throw err("session_not_found", `Session ${this.id} is closed`);
  }

  private assertBudget() {
    const c = this.policy.config;
    if (this.actionCount >= c.maxActionsPerSession) {
      throw err("budget_exceeded", `Session hit its ${c.maxActionsPerSession}-action budget`, {
        hint: "Start a new session, or raise maxActionsPerSession if this is expected.",
      });
    }
    const minutes = (Date.now() - this.startedAt) / 60_000;
    if (minutes > c.maxSessionMinutes) {
      throw err("budget_exceeded", `Session exceeded its ${c.maxSessionMinutes}-minute limit`);
    }
  }

  stats() {
    return {
      sessionId: this.id,
      device: this.device.info,
      mode: this.policy.config.mode,
      actions: this.actionCount,
      actionBudget: this.policy.config.maxActionsPerSession,
      uptimeMs: Date.now() - this.startedAt,
      tracePath: this.audit.tracePath,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.audit.record({ kind: "session_end", ok: true, result: this.stats() as unknown as Record<string, unknown> });
    await this.device.dispose();
    log.info(`session ${this.id} closed after ${this.actionCount} actions`);
  }
}

export function describe(e: UiElement): string {
  const bits = [e.ref, e.role];
  if (e.text) bits.push(JSON.stringify(e.text));
  else if (e.label) bits.push(`label=${JSON.stringify(e.label)}`);
  else if (e.id) bits.push(`id=${e.id}`);
  if (!e.enabled) bits.push("[disabled]");
  return bits.join(" ");
}

export { HarnessError };
