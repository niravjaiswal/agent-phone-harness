import { err } from "./errors.js";
import { logger } from "./logger.js";
import { Session, type SessionOptions } from "./session.js";
import type { DeviceInfo, DeviceProvider, Platform } from "./types.js";
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
}

export interface DoctorReport {
  platform: Platform;
  checks: { name: string; ok: boolean; detail: string }[];
  devices: DeviceInfo[];
  error?: string;
}

/** Top-level entry point: device discovery + session lifecycle. */
export class Harness {
  readonly providers = new Map<Platform, DeviceProvider>();
  private sessions = new Map<string, Session>();

  constructor(private opts: HarnessOptions = {}) {
    this.providers.set("android", new AndroidProvider(undefined, opts.android));
    this.providers.set("ios", new IosProvider(undefined, opts.ios));
    this.providers.set("mock", new MockProvider());
  }

  /** Never throws for one bad provider — a missing adb must not hide iOS devices. */
  async listDevices(): Promise<DeviceInfo[]> {
    const out: DeviceInfo[] = [];
    for (const [platform, p] of this.providers) {
      try {
        out.push(...(await p.listDevices()));
      } catch (e) {
        log.debug(`${platform} listDevices failed`, (e as Error).message);
      }
    }
    return out;
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

  private providerFor(deviceId: string): DeviceProvider {
    const platform = deviceId.split(":")[0] as Platform;
    const p = this.providers.get(platform);
    if (!p) {
      throw err("bad_request", `Unknown device id "${deviceId}"`, {
        hint: 'Ids look like "android:<serial>", "ios:<udid>" or "mock:demo".',
      });
    }
    return p;
  }

  /** Pick a device when the caller did not name one. */
  async pickDevice(platform?: Platform): Promise<DeviceInfo> {
    const all = await this.listDevices();
    const usable = all.filter((d) => d.state === "available" && (!platform || d.platform === platform));

    const real = usable.filter((d) => d.platform !== "mock");
    const preferred =
      real.find((d) => d.platform === "android") ??
      real.find((d) => d.platform === "ios") ??
      real[0];
    if (preferred) return preferred;

    if (this.opts.allowMockFallback || platform === "mock") {
      const mock = all.find((d) => d.platform === "mock");
      if (mock) return mock;
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
    opts: { deviceId?: string; platform?: Platform } & SessionOptions = {},
  ): Promise<Session> {
    const info = opts.deviceId
      ? { id: opts.deviceId }
      : await this.pickDevice(opts.platform);
    const provider = this.providerFor(info.id);
    const device = await provider.open(info.id);
    await device.ping();
    const session = new Session(device, { ...this.opts.session, ...opts });
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw err("session_not_found", `No session "${sessionId}"`, {
        hint: `Open one with phone_session_start. Active: ${[...this.sessions.keys()].join(", ") || "none"}`,
      });
    }
    return s;
  }

  /** Most tools accept an optional sessionId; with exactly one open session, infer it. */
  resolve(sessionId?: string): Session {
    if (sessionId) return this.get(sessionId);
    if (this.sessions.size === 1) return [...this.sessions.values()][0]!;
    if (this.sessions.size === 0) {
      throw err("session_not_found", "No phone session is open", {
        hint: "Call phone_session_start first.",
      });
    }
    throw err("bad_request", `${this.sessions.size} sessions are open; pass sessionId`, {
      hint: `Open sessions: ${[...this.sessions.keys()].join(", ")}`,
    });
  }

  list(): ReturnType<Session["stats"]>[] {
    return [...this.sessions.values()].map((s) => s.stats());
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.close();
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
