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
  collectMessages, defaultSources, findOtp, type InboundMessage, type MessageSource,
} from "./messages/index.js";
import {
  diffSnapshots, hashElements, pruneElements, renderElements, resolveSelector,
  type RenderOptions,
} from "./elements.js";
import type {
  DeepLink, Device, Direction, KeyName, Message, NotificationItem, Selector,
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
  /**
   * "auto" (default) suppresses re-sending a tree the agent already has.
   * "full" always re-renders — use it if an agent struggles to track state.
   */
  renderMode?: "auto" | "full";
  /** Where one-time codes can arrive. Defaults to device SMS + notifications + webhook inbox + IMAP. */
  messageSources?: (device: Device) => MessageSource[];
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
  /**
   * full      — the whole tree, because the screen is new or changed a lot
   * partial   — only what changed; the rest is identical to the previous render
   * unchanged — byte-identical to the previous render, so nothing is repeated
   */
  mode: "full" | "partial" | "unchanged";
  /** Accessibility tree was empty — use a screenshot and tap by coordinate. */
  barren?: boolean;
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
  /** Let a provider's cheap idle probe end the wait early. Default true. */
  useIdleProbe?: boolean;
}

/**
 * How hard to work at deciding the screen has stopped moving.
 *
 * Every dump is an expensive round trip, so paying for a two-dump stability
 * check after typing a character into an already-focused field is waste. The
 * profile is derived from what the action can plausibly do to the UI.
 */
export type SettleProfile = "none" | "fast" | "full";

const SETTLE_PROFILES: Record<SettleProfile, Required<Omit<SettleOptions, "useIdleProbe">>> = {
  none: { timeoutMs: 0, intervalMs: 0, stableCount: 1 },
  fast: { timeoutMs: 1500, intervalMs: 150, stableCount: 2 },
  full: { timeoutMs: 4000, intervalMs: 250, stableCount: 2 },
};

/** Text entry mutates a field in place; navigation can take seconds. */
const PROFILE_BY_ACTION: Record<string, SettleProfile> = {
  type: "none",
  type_secret: "none",
  clear_text: "none",
  tap: "fast",
  long_press: "fast",
  key: "fast",
  swipe: "fast",
  scroll: "fast",
  open_app: "full",
  open_url: "full",
  install_app: "full",
  clear_app_data: "full",
  stop_app: "full",
};


/** One step of a batch. Mirrors the single-action tools one-for-one. */
export type BatchStep =
  | { action: "tap"; ref?: string; selector?: Selector; x?: number; y?: number; durationMs?: number; approvalId?: string }
  | { action: "type"; text: string; ref?: string; selector?: Selector; submit?: boolean; clear?: boolean }
  | { action: "type_secret"; key: string; ref?: string; selector?: Selector; submit?: boolean; clear?: boolean }
  | { action: "key"; key: KeyName }
  | { action: "clear_text"; ref?: string; selector?: Selector }
  | { action: "swipe"; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
  | { action: "scroll"; direction: Direction; ref?: string; selector?: Selector; amount?: number }
  | { action: "wait_for"; textContains?: string; selector?: Selector; gone?: boolean; timeoutMs?: number }
  | { action: "open_app"; appId: string; approvalId?: string }
  | { action: "open_url"; url: string; approvalId?: string };

export interface BatchStepResult {
  index: number;
  action: string;
  target?: string;
  ok: boolean;
  change?: string;
  error?: string;
  code?: string;
  hint?: string;
  approvalId?: string;
}

export interface BatchResult {
  ok: boolean;
  completed: number;
  total: number;
  steps: BatchStepResult[];
  /** Index of the step that failed, if any. Later steps were not attempted. */
  stoppedAt?: number;
  /** Always a full render: the agent was blind while the batch ran. */
  screen: ScreenView;
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
  /** Things the agent should know about how its session was set up (e.g. policy it asked for but did not get). */
  readonly notes: string[] = [];

  private snapshot?: Snapshot;
  /**
   * Bumped immediately before every device mutation. A snapshot captured at the
   * current value therefore postdates the last thing we did to the phone.
   */
  private mutationSeq = 0;
  private snapshotSeq = -1;
  private snapshotSettled = false;
  private actionCount = 0;
  private closed = false;
  private readonly approvalWaitMs: number;
  private readonly secretStore: SecretStore;
  private readonly approvalStore: ApprovalStore;
  private readonly renderOpts: RenderOptions;
  private readonly traceScreenshots: boolean;
  private readonly renderMode: "auto" | "full";
  private readonly sourcesFor?: (device: Device) => MessageSource[];
  /** Messages whose code was already handed out — a retry must get a fresh code, not the stale one. */
  private readonly consumed = new Set<string>();
  /**
   * Codes already handed out, with when their message arrived. The same SMS
   * often shows up twice — once from the SMS store, once from the notification
   * shade — under different ids.
   */
  private readonly consumedCodes = new Map<string, number>();
  /**
   * One-time codes typed on the agent's behalf. Hidden wherever a field shows
   * exactly that value — the whole point of entering it for the agent is that
   * the code never lands in the model's context or its provider's logs.
   */
  private readonly hiddenValues = new Set<string>();

  constructor(readonly device: Device, opts: SessionOptions = {}) {
    this.id = randomUUID().slice(0, 8);
    this.policy = new Policy(opts.policy);
    this.audit = new AuditLog(this.id);
    this.approvalWaitMs = opts.approvalWaitMs ?? 45_000;
    this.secretStore = opts.secretStore ?? secrets;
    this.approvalStore = opts.approvalStore ?? approvals;
    this.renderOpts = opts.render ?? {};
    this.traceScreenshots = opts.traceScreenshots ?? false;
    this.renderMode = opts.renderMode ?? "auto";
    this.sourcesFor = opts.messageSources;
    this.audit.meta({
      sessionId: this.id,
      device: device.info,
      policy: this.policy.config,
      startedAt: this.startedAt,
    });
    log.info(`session ${this.id} on ${device.info.id} (${this.policy.config.mode})`);
  }

  /**
   * Forget the cached screen. Called when something outside this session — a
   * human in the panel — may have changed the device.
   */
  invalidateSnapshot(): void {
    this.mutationSeq++;
    this.snapshotSettled = false;
  }

  // ---------------------------------------------------------------- perception

  async observe(opts: ObserveOptions = {}): Promise<Snapshot> {
    if (opts.fresh === false && this.snapshot) return this.snapshot;
    const { elements, screen, prunedCount } = await this.device.dumpUi();
    const { kept, prunedCount: extraPruned } = pruneElements(elements, screen);
    // A Flutter/canvas/game surface yields a near-empty tree. Distinguish that
    // from "we pruned aggressively" by looking at the raw node count.
    const rawCount = elements.length + prunedCount;
    const snap: Snapshot = {
      snapshotId: randomUUID().slice(0, 8),
      deviceId: this.device.info.id,
      takenAt: Date.now(),
      screen,
      elements: kept,
      prunedCount: prunedCount + extraPruned,
      truncated: false,
      hash: hashElements(kept, screen),
      barren: kept.length < 3 && rawCount < 8,
    };
    this.snapshot = snap;
    this.snapshotSeq = this.mutationSeq;
    this.snapshotSettled = false;
    return snap;
  }

  view(snap: Snapshot, opts: ObserveOptions = {}): ScreenView {
    return this.renderView(snap, snap.elements, "full", opts);
  }

  private renderView(
    snap: Snapshot,
    elements: UiElement[],
    mode: ScreenView["mode"],
    opts: ObserveOptions = {},
  ): ScreenView {
    const rendered = renderElements(elements, snap.screen, {
      ...this.renderOpts,
      ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      ...(opts.bounds !== undefined ? { bounds: opts.bounds } : {}),
    });
    return {
      snapshotId: snap.snapshotId,
      app: snap.screen.app,
      activity: snap.screen.activity,
      size: { width: snap.screen.width, height: snap.screen.height },
      // A secret typed into an ordinary field comes straight back in the next
      // tree as the field's text; scrub it before the model sees it.
      elements:
        mode === "unchanged"
          ? "(screen unchanged — the tree from the previous result still applies)"
          : this.hide(this.secretStore.redact(rendered.text)),
      elementCount: snap.elements.length,
      truncated: rendered.truncated,
      mode,
      ...(snap.barren ? { barren: true } : {}),
    };
  }

  /**
   * Choose how much of the screen to re-send.
   *
   * Identical hash means the agent already holds a byte-identical tree, so
   * repeating it is pure waste. A small in-place change is sent as just the
   * changed elements. Anything navigational or large gets the full tree —
   * asking a model to reconstruct a screen from accumulated deltas costs more
   * turns than it saves in tokens.
   */
  private viewForResult(before: Snapshot | undefined, after: Snapshot): ScreenView {
    if (this.renderMode === "full" || !before) return this.view(after);
    if (before.hash === after.hash) return this.renderView(after, after.elements, "unchanged");

    const diff = diffSnapshots(before, after);
    if (diff.appChanged || after.barren) return this.view(after);

    const churn = diff.added.length + diff.removed.length;
    const changedFraction = after.elements.length ? churn / after.elements.length : 1;
    if (changedFraction > 0.4 || diff.added.length > 12) return this.view(after);
    if (!diff.added.length) return this.renderView(after, after.elements, "full");

    return this.renderView(after, diff.added, "partial");
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
      ? snap.elements.filter((e) => e.password || this.holdsSecret(e))
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

  /** Does this element display a stored secret or an entered code? */
  private holdsSecret(e: UiElement): boolean {
    if ((e.text && this.hiddenValues.has(e.text)) || (e.value && this.hiddenValues.has(e.value))) return true;
    const shown = `${e.text ?? ""}\u0000${e.value ?? ""}`;
    return this.secretStore.redact(shown) !== shown;
  }

  /** Replace entered codes where they appear as a whole rendered value (`"123456"`). */
  private hide(text: string): string {
    let out = text;
    for (const v of this.hiddenValues) out = out.split(JSON.stringify(v)).join('"«one-time code»"');
    return out;
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

  /**
   * A dump, unless the one we already hold is provably still current.
   *
   * Reuse requires all three: nothing has touched the device since it was taken,
   * settle confirmed the screen had stopped moving, and it is very recent. That
   * keeps the "never tap a stale coordinate" guarantee while removing the
   * redundant dump between consecutive actions — which, once settle profiles
   * landed, became the dominant per-action cost.
   */
  private async currentSnapshot(maxAgeMs = 400): Promise<Snapshot> {
    const snap = this.snapshot;
    if (
      snap &&
      this.snapshotSeq === this.mutationSeq &&
      this.snapshotSettled &&
      Date.now() - snap.takenAt <= maxAgeMs
    ) {
      return snap;
    }
    return this.observe();
  }

  private async resolveTargetInner(
    target: Target,
  ): Promise<{ element?: UiElement; point: [number, number]; label: string }> {
    if ("point" in target) {
      return { point: target.point, label: `point ${target.point.join(",")}` };
    }

    const cached = this.snapshot;
    const fresh = await this.currentSnapshot();

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
      this.mutationSeq++;
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
    return this.typeHidden(this.secretStore.get(key), `«secret:${key}»`, "type_secret", opts);
  }

  /** Type a value that must not appear in the returned label or the audit trail. */
  private async typeHidden(
    value: string,
    shown: string,
    name: string,
    opts: { target?: Target; submit?: boolean; clear?: boolean } = {},
  ): Promise<ActionResult> {
    let label = "focused field";
    if (opts.target) {
      const t = await this.resolveTarget(opts.target);
      label = t.label;
      this.mutationSeq++;
      await this.device.tap(t.point[0], t.point[1]);
      await sleep(250);
    }
    return this.perform(
      name,
      { kind: "type_secret", targetText: label, appId: this.snapshot?.screen.app },
      `${label} ← ${shown}`,
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
      this.mutationSeq++;
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

  private sources(): MessageSource[] {
    return this.sourcesFor ? this.sourcesFor(this.device) : defaultSources(this.device, { secretStore: this.secretStore });
  }

  /**
   * Recent messages from every configured source: SMS on the device, a rented
   * number's webhook, a relay phone, a mailbox. Notifications are left out
   * (they have their own tool) unless asked for.
   */
  async readMessages(
    opts: { limit?: number; sinceMs?: number; includeNotifications?: boolean } = {},
  ): Promise<{ messages: InboundMessage[]; errors: { source: string; error: string }[] }> {
    this.policy.assertAllowed({ kind: "read_sms" });
    const sources = this.sources().filter((s) => opts.includeNotifications || s.name !== "notification");
    const r = await collectMessages(sources, {
      sinceMs: opts.sinceMs ?? Date.now() - 24 * 3600_000,
      limit: opts.limit ?? 20,
    });
    this.audit.record({
      kind: "read_sms",
      ok: true,
      result: { count: r.messages.length, sources: sources.map((s) => s.name), errors: r.errors.length },
    });
    return r;
  }

  /** Device-only SMS, kept for callers that want exactly what is on the phone. */
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
   * Wait for a one-time code from any source and return it — or type it.
   *
   * This is the single feature that turns "agent gets stuck at 2FA" into
   * "agent finishes the signup". A code is never handed out twice in a
   * session, so a retry after a failed attempt waits for the new code rather
   * than resubmitting the stale one.
   */
  async waitForOtp(
    opts: {
      fromContains?: string;
      bodyContains?: string;
      digits?: number;
      timeoutMs?: number;
      /** Look back this far for a code that arrived before the call. Default 2 minutes. */
      sinceMs?: number;
      /** Type the code into the focused field (or `target`) instead of returning it. */
      enter?: boolean;
      target?: Target;
      submit?: boolean;
      pollMs?: number;
    } = {},
  ): Promise<{ code?: string; message: InboundMessage; entered: boolean; result?: ActionResult }> {
    this.policy.assertAllowed({ kind: "read_sms" });
    const since = opts.sinceMs ?? Date.now() - 120_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    const sources = this.sources();
    let lastErrors: { source: string; error: string }[] = [];

    for (;;) {
      const { messages, errors } = await collectMessages(sources, { sinceMs: since, limit: 40 });
      lastErrors = errors;
      for (const m of messages) {
        const key = `${m.origin}:${m.id}`;
        if (this.consumed.has(key)) continue;
        if (opts.fromContains && !m.from.toLowerCase().includes(opts.fromContains.toLowerCase())) continue;
        if (opts.bodyContains && !m.body.toLowerCase().includes(opts.bodyContains.toLowerCase())) continue;
        const code = findOtp(m.body, opts.digits ? { digits: opts.digits } : {});
        if (!code) continue;
        const seenAt = this.consumedCodes.get(code);
        if (seenAt !== undefined && Math.abs(seenAt - m.receivedAt) < 90_000) {
          this.consumed.add(key);
          continue;
        }
        this.consumed.add(key);
        this.consumedCodes.set(code, m.receivedAt);
        this.audit.record({ kind: "wait_for_otp", ok: true, result: { from: m.from, origin: m.origin, digits: code.length } });
        if (!opts.enter) return { code, message: m, entered: false };
        this.hiddenValues.add(code);
        const result = await this.typeHidden(code, `«${code.length}-digit code from ${m.from}»`, "enter_otp", {
          ...(opts.target ? { target: opts.target } : {}),
          ...(opts.submit !== undefined ? { submit: opts.submit } : {}),
        });
        return { message: m, entered: true, result };
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(opts.pollMs ?? 2000, Math.max(0, deadline - Date.now())));
    }

    const names = sources.map((s) => s.name);
    const external = names.some((n) => n === "inbox" || n === "imap");
    throw err("timeout", `No one-time code arrived within the timeout`, {
      hint:
        `Checked: ${names.join(", ")}. ` +
        (this.device.info.transport === "emulator" || this.device.info.platform === "mock" || !this.device.readSms
          ? "A virtual phone has no SIM — real SMS only arrive through a number the operator connected (docs/telephony.md). "
          : "") +
        "Confirm the code was actually sent and to which number/email, then call again. " +
        (external ? "" : "No external number or mailbox is configured."),
      details: { sources: names, ...(lastErrors.length ? { sourceErrors: lastErrors } : {}) },
    });
  }

  /**
   * Ask the operator to do something only a human should: solve a CAPTCHA,
   * sign in to Google, approve a biometric prompt. The operator is notified,
   * takes control in the panel, and hands back.
   *
   * Returns "pending" rather than throwing when the wait runs out, so the agent
   * can keep waiting by calling again with the id.
   */
  async requestHuman(
    reason: string,
    opts: { handoffId?: string; waitMs?: number } = {},
  ): Promise<{ id: string; status: "done" | "declined" | "pending"; note?: string }> {
    this.assertOpen();
    let id = opts.handoffId;
    if (id) {
      const existing = this.approvalStore.get(id);
      if (!existing || existing.sessionId !== this.id || existing.type !== "handoff") {
        throw err("bad_request", `No handoff ${id} in this session`);
      }
    } else {
      let evidence: string | undefined;
      try {
        const shot = await this.screenshot();
        evidence = this.audit.saveScreen(shot.data, "handoff");
      } catch {
        /* evidence is best effort */
      }
      const req = this.approvalStore.create({
        sessionId: this.id,
        type: "handoff",
        action: { kind: "handoff", targetText: reason, appId: this.snapshot?.screen.app },
        summary: `Agent needs a human on ${this.device.info.name}`,
        reason,
        deviceId: this.device.info.id,
        ...(evidence ? { evidence } : {}),
        ttlMs: 60 * 60_000,
      });
      id = req.id;
      this.audit.record({ kind: "handoff_requested", ok: true, args: { reason }, result: { id } });
    }

    const decided = await this.approvalStore.waitFor(id, opts.waitMs ?? this.approvalWaitMs);
    if (decided.status === "pending" || decided.status === "expired") {
      return { id, status: "pending" };
    }
    this.invalidateSnapshot();
    const status = decided.status === "approved" ? "done" : "declined";
    this.audit.record({ kind: "handoff_resolved", ok: status === "done", result: { id, status, by: decided.decidedBy } });
    return { id, status, ...(decided.note ? { note: decided.note } : {}) };
  }

  /** Clipboard access goes through policy and the audit trail like everything else. */
  async clipboard(action: "get" | "set", text = ""): Promise<string> {
    if (action === "get") {
      this.policy.assertAllowed({ kind: "clipboard_get" });
      if (!this.device.clipboardGet) throw err("unsupported", "clipboard read unavailable on this device");
      const v = await this.device.clipboardGet();
      this.audit.record({ kind: "clipboard_get", ok: true, result: { length: v.length } });
      return this.secretStore.redact(v);
    }
    this.policy.assertAllowed({ kind: "clipboard_set", text, appId: this.snapshot?.screen.app });
    if (!this.device.clipboardSet) throw err("unsupported", "clipboard write unavailable on this device");
    this.mutationSeq++;
    await this.device.clipboardSet(text);
    this.audit.record({ kind: "clipboard_set", ok: true, args: { length: text.length } });
    return "clipboard set";
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

    // `none`: one dump is the answer. Typing into a focused field cannot start
    // an animation worth waiting on.
    if (need <= 1 || timeoutMs <= 0) {
      this.snapshotSettled = true;
      return { settled: true, snapshot: snap };
    }

    for (;;) {
      if (snap.hash === last) stable++;
      else stable = 1;
      last = snap.hash;
      if (stable >= need) {
        this.snapshotSettled = true;
        return { settled: true, snapshot: snap };
      }

      // A provider that can cheaply say "no transition is running" saves a
      // whole dump. It may only end the wait early, never extend it.
      if (opts.useIdleProbe !== false && this.device.isIdle) {
        const idle = await this.device.isIdle().catch(() => undefined);
        if (idle === true) {
          this.snapshotSettled = true;
          return { settled: true, snapshot: snap };
        }
      }

      if (Date.now() > deadline) return { settled: false, snapshot: snap };
      await sleep(intervalMs);
      snap = await this.observe();
    }
  }

  /** Settle strictness implied by what the action can do to the screen. */
  private settleFor(action: string): SettleOptions {
    return SETTLE_PROFILES[PROFILE_BY_ACTION[action] ?? "full"];
  }


  // ---------------------------------------------------------------- batching

  /**
   * Run a predictable sequence in one call.
   *
   * The win is turns, not safety shortcuts: every step goes through the same
   * classify -> policy -> execute -> settle pipeline as its single-action
   * equivalent, and each step re-resolves its selector against a fresh dump, so
   * a batch cannot blunder on stale coordinates. It stops at the first failure
   * and hands back what happened plus the screen where it stopped.
   *
   * A step needing human approval halts the batch there with its approvalId;
   * the steps before it were, by definition, ones the policy allowed.
   */
  async batch(steps: BatchStep[], opts: { stopOnError?: boolean } = {}): Promise<BatchResult> {
    this.assertOpen();
    if (!steps.length) throw err("bad_request", "batch needs at least one step");

    const stopOnError = opts.stopOnError !== false;
    const results: BatchStepResult[] = [];
    let stoppedAt: number | undefined;

    for (const [index, step] of steps.entries()) {
      try {
        const r = await this.runStep(step);
        results.push({
          index,
          action: step.action,
          ok: true,
          ...(r.target ? { target: r.target } : {}),
          change: r.change,
        });
      } catch (e) {
        const he = e instanceof HarnessError ? e : undefined;
        results.push({
          index,
          action: step.action,
          ok: false,
          error: this.secretStore.redact(e instanceof Error ? e.message : String(e)),
          ...(he?.code ? { code: he.code } : {}),
          ...(he?.hint ? { hint: he.hint } : {}),
          ...(typeof he?.details?.approvalId === "string" ? { approvalId: he.details.approvalId } : {}),
        });
        if (stopOnError) {
          stoppedAt = index;
          break;
        }
      }
    }

    const snap = this.snapshot ?? (await this.observe());
    const ok = results.every((r) => r.ok);
    this.audit.record({
      kind: "batch",
      ok,
      args: { steps: steps.map((x) => x.action).join(",") },
      result: { completed: results.filter((r) => r.ok).length, total: steps.length, stoppedAt },
    });

    return {
      ok,
      completed: results.filter((r) => r.ok).length,
      total: steps.length,
      steps: results,
      ...(stoppedAt !== undefined ? { stoppedAt } : {}),
      screen: this.view(snap),
    };
  }

  private async runStep(step: BatchStep): Promise<ActionResult> {
    const target = (s: { ref?: string; selector?: Selector; x?: number; y?: number }): Target | undefined => {
      if (s.ref) return { ref: s.ref };
      if (s.selector && Object.keys(s.selector).length) return { selector: s.selector };
      if (s.x !== undefined && s.y !== undefined) return { point: [s.x, s.y] };
      return undefined;
    };
    const required = (s: { ref?: string; selector?: Selector; x?: number; y?: number }): Target => {
      const t = target(s);
      if (!t) throw err("bad_request", `step "${step.action}" needs a ref, selector or x+y`);
      return t;
    };

    switch (step.action) {
      case "tap":
        return this.tap(required(step), {
          ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
          ...(step.approvalId ? { approvalId: step.approvalId } : {}),
        });
      case "type": {
        const t = target(step);
        return this.type(step.text, {
          ...(t ? { target: t } : {}),
          ...(step.submit !== undefined ? { submit: step.submit } : {}),
          ...(step.clear !== undefined ? { clear: step.clear } : {}),
        });
      }
      case "type_secret": {
        const t = target(step);
        return this.typeSecret(step.key, {
          ...(t ? { target: t } : {}),
          ...(step.submit !== undefined ? { submit: step.submit } : {}),
          ...(step.clear !== undefined ? { clear: step.clear } : {}),
        });
      }
      case "key":
        return this.pressKey(step.key);
      case "clear_text":
        return this.clearText(target(step));
      case "swipe":
        return this.swipe([step.fromX, step.fromY], [step.toX, step.toY], step.durationMs ?? 300);
      case "scroll": {
        const t = target(step);
        return this.scroll(step.direction, {
          ...(t ? { target: t } : {}),
          ...(step.amount !== undefined ? { amount: step.amount } : {}),
        });
      }
      case "wait_for":
        return this.waitFor(
          {
            ...(step.selector ? { selector: step.selector } : {}),
            ...(step.textContains ? { textContains: step.textContains } : {}),
            ...(step.gone !== undefined ? { gone: step.gone } : {}),
          },
          { ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}) },
        );
      case "open_app":
        return this.openApp(step.appId, { ...(step.approvalId ? { approvalId: step.approvalId } : {}) });
      case "open_url":
        return this.openUrl(step.url, { ...(step.approvalId ? { approvalId: step.approvalId } : {}) });
      default: {
        const bad = step as { action: string };
        throw err("bad_request", `unknown batch step "${bad.action}"`);
      }
    }
  }

  /**
   * Entry points the foreground (or named) app declares.
   *
   * Usually the cheapest route to a screen: one `open_url` instead of six taps.
   */
  async deepLinks(appId?: string): Promise<DeepLink[]> {
    this.policy.assertAllowed({ kind: "observe" });
    if (!this.device.listDeepLinks) {
      throw err("unsupported", "this provider cannot enumerate deep links", {
        hint: "Android only for now. You can still call phone_open_url with a link you already know.",
      });
    }
    const app = appId ?? this.snapshot?.screen.app ?? (await this.observe()).screen.app;
    if (!app) throw err("bad_request", "no app in the foreground; pass appId");
    const links = await this.device.listDeepLinks(app);
    this.audit.record({ kind: "list_deep_links", ok: true, args: { app }, result: { count: links.length } });
    return links;
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
    this.mutationSeq++;
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
        const r = await this.waitForSettle(this.settleFor(name));
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
            : `Wait, then retry this call passing approvalId="${req.id}". An operator approves with \`agent-phone approve ${req.id}\`.`,
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
        mode: "full",
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
      screen: this.viewForResult(before, snapshot),
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
    try {
      this.approvalStore.expireForSession(this.id);
    } catch {
      /* a full disk must not stop the device being released */
    }
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
