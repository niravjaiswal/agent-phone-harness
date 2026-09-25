import { clampPolicy, loadCeiling } from "./ceiling.js";
import { err } from "./errors.js";
import { logger } from "./logger.js";
import { defaultSources, type Inbox } from "./messages/index.js";
import { DEFAULT_POLICY, type PolicyConfig } from "./policy.js";
import { Session, type SessionOptions } from "./session.js";
import type { Device, DeviceInfo, DeviceProvider, Platform } from "./types.js";
import { AndroidProvider, type AndroidOptions } from "../providers/android/index.js";
import { IosProvider, type IosOptions } from "../providers/ios/index.js";
import { MockProvider } from "../providers/mock/index.js";

const log = logger("harness");

export interface HarnessOptions {
  android?: AndroidOptions;
  ios?: IosOptions;
  /**
   * Allow a session to fall back to the mock device when no real device is
   * present. Off by default: an agent must never believe it drove a real phone
   * when it drove a simulation.
   */
  allowMockFallback?: boolean;
  session?: SessionOptions;
  /**
   * The operator's policy ceiling. Defaults to policy.json (re-read on change).
   * Pass an object to pin it — tests and the mock-only demo do.
   */
  ceiling?: Partial<PolicyConfig>;
  /** Close sessions nobody has touched for this long. Off by default; the HTTP server turns it on. */
  idleTimeoutMs?: number;
  /** Where webhook-delivered messages land. Sessions read codes from here. */
  inbox?: Inbox;
}

export interface DoctorReport {
  platform: Platform;
  checks: { name: string; ok: boolean; detail: string }[];
  devices: DeviceInfo[];
  error?: string;
}

/** Who a session belongs to: an MCP connection id, "rest", "cli"... */
export type Owner = string;

interface Entry {
  session: Session;
  owner?: Owner;
  lastActiveAt: number;
}

export interface ControlState {
  by: string;
  since: number;
}

export interface DeviceStatus extends DeviceInfo {
  /** Session currently holding the device. */
  leasedBy?: string;
  /** Set while a human has taken control from the panel. */
  control?: ControlState;
}

/** Methods that change the device. Everything else (reads) passes straight through. */
const MUTATING = new Set([
  "tap", "swipe", "typeText", "pressKey", "clearText", "launchApp", "stopApp",
  "clearAppData", "installApp", "openUrl", "clipboardSet", "shell",
]);

/**
 * Wrap a device so every mutation first asks `check`. Enforcing operator
 * control here, rather than in each Session method, means no future action
 * path can forget to.
 */
function guardDevice(device: Device, check: () => void): Device {
  return new Proxy(device, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop === "string" && MUTATING.has(prop) && typeof v === "function") {
        return (...args: unknown[]) => {
          check();
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Top-level entry point: device discovery, leases, and session lifecycle. */
export class Harness {
  readonly providers = new Map<Platform, DeviceProvider>();
  private sessions = new Map<string, Entry>();
  /** deviceId → sessionId. One agent per phone. */
  private leases = new Map<string, string>();
  private control = new Map<string, ControlState>();
  private operatorDevices = new Map<string, Promise<Device>>();
  private reaper?: NodeJS.Timeout;

  constructor(private opts: HarnessOptions = {}) {
    this.providers.set("android", new AndroidProvider(undefined, opts.android));
    this.providers.set("ios", new IosProvider(undefined, opts.ios));
    this.providers.set("mock", new MockProvider());
    if (opts.idleTimeoutMs) this.startReaper(opts.idleTimeoutMs);
  }

  ceiling(): PolicyConfig {
    return this.opts.ceiling ? { ...DEFAULT_POLICY, ...this.opts.ceiling } : loadCeiling();
  }

  private listCache?: { at: number; devices: Promise<DeviceInfo[]> };

  /**
   * Never throws for one bad provider — a missing adb must not hide iOS devices.
   * Providers are asked in parallel (`xcrun devicectl` alone can take seconds)
   * and the answer is reused briefly, since the panel polls it.
   */
  async listDevices(opts: { maxAgeMs?: number } = {}): Promise<DeviceInfo[]> {
    const maxAge = opts.maxAgeMs ?? 2000;
    if (this.listCache && Date.now() - this.listCache.at < maxAge) return this.listCache.devices;
    const devices = Promise.all(
      [...this.providers].map(([platform, p]) =>
        p.listDevices().catch((e: Error) => {
          log.debug(`${platform} listDevices failed`, e.message);
          return [] as DeviceInfo[];
        }),
      ),
    ).then((lists) => lists.flat());
    this.listCache = { at: Date.now(), devices };
    return devices;
  }

  /** Devices plus who holds them. What the panel and `phone_list_devices` show. */
  async deviceStatus(): Promise<DeviceStatus[]> {
    const listed = await this.listDevices();
    // A leased device may not appear in discovery (a mock id opened by name);
    // it is still in use and the operator must see it.
    for (const [id] of this.leases) {
      if (listed.some((d) => d.id === id)) continue;
      const s = [...this.sessions.values()].find((e) => e.session.device.info.id === id)?.session;
      if (s) listed.push({ ...s.device.info });
    }
    return listed.map((d) => {
      const leasedBy = this.leases.get(d.id);
      const control = this.control.get(d.id);
      return {
        ...d,
        ...(leasedBy ? { leasedBy, state: d.state === "available" ? ("busy" as const) : d.state } : {}),
        ...(control ? { control } : {}),
      };
    });
  }

  async doctor(): Promise<DoctorReport[]> {
    const reports: DoctorReport[] = [];
    for (const [platform, p] of this.providers) {
      const report: DoctorReport = { platform, checks: [], devices: [] };
      try {
        report.checks = await p.requirements();
        report.devices = await p.listDevices();
      } catch (e) {
        report.error = (e as Error).message;
      }
      reports.push(report);
    }
    return reports;
  }

  providerFor(deviceId: string): DeviceProvider {
    const platform = deviceId.split(":")[0] as Platform;
    const p = this.providers.get(platform);
    if (!p) {
      throw err("bad_request", `Unknown device id "${deviceId}"`, {
        hint: 'Ids look like "android:<serial>", "ios:<udid>" or "mock:demo".',
      });
    }
    return p;
  }

  /** Pick a device when the caller did not name one. Leased devices are skipped. */
  async pickDevice(platform?: Platform): Promise<DeviceInfo> {
    const all = await this.listDevices({ maxAgeMs: 0 });
    const usable = all.filter(
      (d) => d.state === "available" && !this.leases.has(d.id) && (!platform || d.platform === platform),
    );

    const real = usable.filter((d) => d.platform !== "mock");
    const preferred =
      real.find((d) => d.platform === "android") ??
      real.find((d) => d.platform === "ios") ??
      real[0];
    if (preferred) return preferred;

    if (this.opts.allowMockFallback || platform === "mock") {
      const mock = all.find((d) => d.platform === "mock" && !this.leases.has(d.id));
      if (mock) return mock;
    }

    const busy = all.filter((d) => this.leases.has(d.id));
    if (busy.length) {
      throw err("device_busy", "Every phone is in use by another session", {
        hint: "Wait for the other task to finish, or ask the operator to end its session.",
        details: { busy: busy.map((d) => d.id) },
      });
    }
    throw err("device_not_found", "No phone is available", {
      hint:
        "Plug in / `adb connect` an Android device, boot an iOS simulator with WebDriverAgent running, " +
        'or start the session with deviceId "mock:demo" to use the built-in simulated phone. ' +
        "Run `agent-phone doctor` for a full diagnosis.",
      details: { seen: all.map((d) => `${d.id} (${d.state})`) },
    });
  }

  async createSession(
    opts: { deviceId?: string; platform?: Platform; owner?: Owner } & SessionOptions = {},
  ): Promise<Session> {
    const info = opts.deviceId ? { id: opts.deviceId } : await this.pickDevice(opts.platform);
    const holder = this.leases.get(info.id);
    if (holder) {
      throw err("device_busy", `${info.id} is in use by session ${holder}`, {
        hint: "One session per phone. Wait for it to finish, or omit deviceId to take any free phone.",
      });
    }

    const { policy, clamped } = clampPolicy(this.ceiling(), opts.policy);
    const provider = this.providerFor(info.id);
    const raw = await provider.open(info.id);
    await raw.ping();
    const device = guardDevice(raw, () => this.assertAgentMayAct(raw.info.id));

    // Re-check: another caller may have leased it while we were opening.
    if (this.leases.has(info.id)) {
      throw err("device_busy", `${info.id} was taken by another session`);
    }
    const inbox = this.opts.inbox;
    const session = new Session(device, {
      ...(inbox ? { messageSources: (d) => defaultSources(d, { inbox }) } : {}),
      ...this.opts.session,
      ...opts,
      policy,
    });
    session.notes.push(...clamped);
    this.sessions.set(session.id, { session, owner: opts.owner, lastActiveAt: Date.now() });
    this.leases.set(raw.info.id, session.id);
    return session;
  }

  private visible(e: Entry, owner?: Owner): boolean {
    return owner === undefined || e.owner === undefined || e.owner === owner;
  }

  /**
   * Look up a session. With an owner, sessions belonging to someone else are
   * reported as not found — one agent must not be able to drive another's phone
   * by guessing an id.
   */
  get(sessionId: string, owner?: Owner): Session {
    const e = this.sessions.get(sessionId);
    if (!e || !this.visible(e, owner)) {
      throw err("session_not_found", `No session "${sessionId}"`, {
        hint: `Open one with phone_session_start. Yours: ${this.idsFor(owner).join(", ") || "none"}`,
      });
    }
    e.lastActiveAt = Date.now();
    return e.session;
  }

  private idsFor(owner?: Owner): string[] {
    return [...this.sessions.entries()].filter(([, e]) => this.visible(e, owner)).map(([id]) => id);
  }

  /** Most tools accept an optional sessionId; with exactly one open session (of yours), infer it. */
  resolve(sessionId?: string, owner?: Owner): Session {
    if (sessionId) return this.get(sessionId, owner);
    const mine = this.idsFor(owner);
    if (mine.length === 1) return this.get(mine[0]!, owner);
    if (mine.length === 0) {
      throw err("session_not_found", "No phone session is open", {
        hint: "Call phone_session_start first.",
      });
    }
    throw err("bad_request", `${mine.length} sessions are open; pass sessionId`, {
      hint: `Open sessions: ${mine.join(", ")}`,
    });
  }

  list(owner?: Owner) {
    return [...this.sessions.values()]
      .filter((e) => this.visible(e, owner))
      .map((e) => ({ ...e.session.stats(), owner: e.owner, lastActiveAt: e.lastActiveAt }));
  }

  async close(sessionId: string): Promise<void> {
    const e = this.sessions.get(sessionId);
    if (!e) return;
    this.sessions.delete(sessionId);
    for (const [dev, sid] of this.leases) if (sid === sessionId) this.leases.delete(dev);
    await e.session.close();
  }

  /** Close everything an owner opened — used when an MCP connection goes away. */
  async closeOwned(owner: Owner): Promise<number> {
    const ids = [...this.sessions.entries()].filter(([, e]) => e.owner === owner).map(([id]) => id);
    await Promise.all(ids.map((id) => this.close(id)));
    return ids.length;
  }

  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /**
   * An agent that crashes mid-task must not hold the phone forever. Sessions
   * idle past the timeout, or past their own time budget, are closed.
   */
  startReaper(idleMs: number, everyMs = 30_000): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = setInterval(() => void this.reap(idleMs), everyMs);
    this.reaper.unref();
  }

  async reap(idleMs: number, now = Date.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const [id, e] of this.sessions) {
      const idle = now - e.lastActiveAt > idleMs;
      const overBudget = now - e.session.startedAt > (e.session.policy.config.maxSessionMinutes + 1) * 60_000;
      if (idle || overBudget) {
        log.info(`closing session ${id}: ${idle ? "idle" : "over its time budget"}`);
        await this.close(id);
        closed.push(id);
      }
    }
    return closed;
  }

  // ------------------------------------------------------------ operator control

  /**
   * A human takes the wheel. Agent mutations on this device fail with
   * `device_busy` until control is released; reads still work, so the agent can
   * watch what the human is doing.
   */
  takeControl(deviceId: string, by = "operator"): ControlState {
    const state = { by, since: Date.now() };
    this.control.set(deviceId, state);
    log.info(`${by} took control of ${deviceId}`);
    return state;
  }

  releaseControl(deviceId: string): void {
    if (!this.control.delete(deviceId)) return;
    // The human changed the screen behind the agent's back; nothing it cached is trustworthy.
    for (const e of this.sessions.values()) {
      if (e.session.device.info.id === deviceId) e.session.invalidateSnapshot();
    }
    log.info(`control of ${deviceId} returned to the agent`);
  }

  controlOf(deviceId: string): ControlState | undefined {
    return this.control.get(deviceId);
  }

  private assertAgentMayAct(deviceId: string): void {
    const c = this.control.get(deviceId);
    if (!c) return;
    throw err("device_busy", `A human (${c.by}) has taken control of this phone`, {
      hint:
        "Do not try to work around this. Wait 30–60 seconds and retry; observe first, because the human " +
        "has probably changed the screen.",
      details: { since: new Date(c.since).toISOString() },
    });
  }

  /**
   * The unguarded device, for the operator's own actions from the panel.
   * Cached: the live view polls it every second.
   */
  operatorDevice(deviceId: string): Promise<Device> {
    let d = this.operatorDevices.get(deviceId);
    if (!d) {
      d = this.providerFor(deviceId).open(deviceId);
      d.catch(() => this.operatorDevices.delete(deviceId));
      this.operatorDevices.set(deviceId, d);
    }
    return d;
  }
}
