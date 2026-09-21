import { finalizeElements } from "../../core/elements.js";
import { err } from "../../core/errors.js";
import { runCommand, which, type Runner } from "../../core/exec.js";
import { logger } from "../../core/logger.js";
import type {
  AppInfo, Device, DeviceInfo, DeviceProvider, KeyName, ScreenContext,
  Screenshot, UiElement,
} from "../../core/types.js";
import { DeviceCtl, Simctl } from "./simctl.js";
import { parseWdaSource, WdaClient } from "./wda.js";

const log = logger("ios");

/** XCUITest's backspace key. */
const BACKSPACE = "";

export interface IosOptions {
  /** WebDriverAgent base URL. Required for perception and input. */
  wdaUrl?: string;
  /** Boot the simulator automatically when opening it. Default true. */
  autoBoot?: boolean;
}

const noWda = (what: string) =>
  err("unsupported", `${what} on iOS requires WebDriverAgent`, {
    hint:
      "Start WDA and pass wdaUrl (default http://127.0.0.1:8100). Simulator: run the WebDriverAgentRunner " +
      "test target from Xcode. Physical device: run it on the device and forward the port " +
      "(`iproxy 8100 8100`). See README -> iOS setup.",
  });

export class IosDevice implements Device {
  info: DeviceInfo;

  constructor(
    info: DeviceInfo,
    private wda: WdaClient | undefined,
    private sim: Simctl | undefined,
    private devicectl: DeviceCtl | undefined,
    private udid: string,
  ) {
    this.info = info;
  }

  async ping(): Promise<void> {
    if (this.wda) {
      await this.wda.status();
      return;
    }
    if (this.sim) {
      const devices = await this.sim.list();
      const d = devices.find((x) => x.udid === this.udid);
      if (!d || d.state !== "Booted") {
        throw err("device_unreachable", `simulator ${this.udid} is not booted`);
      }
      return;
    }
    throw noWda("ping");
  }

  async refreshInfo(): Promise<DeviceInfo> {
    if (this.wda) {
      try {
        const size = await this.wda.windowSize();
        this.info.screen = { ...size, density: this.info.screen?.density };
      } catch {
        /* keep whatever we had */
      }
    }
    return this.info;
  }

  async dumpUi(): Promise<{ elements: UiElement[]; screen: ScreenContext; prunedCount: number }> {
    if (!this.wda) throw noWda("Reading the screen");
    const source = await this.wda.source();
    const raw = parseWdaSource(source);
    let size = this.info.screen;
    if (!size) {
      size = await this.wda.windowSize();
      this.info.screen = size;
    }
    let app: string | undefined;
    let name: string | undefined;
    try {
      const active = await this.wda.activeApp();
      app = active.bundleId;
      name = active.name;
    } catch {
      /* activeAppInfo is unavailable on some WDA builds */
    }
    const screen: ScreenContext = {
      app,
      activity: name,
      width: size.width,
      height: size.height,
      orientation: size.width > size.height ? "landscape" : "portrait",
    };
    return { elements: finalizeElements(raw), screen, prunedCount: 0 };
  }

  async screenshot(): Promise<Screenshot> {
    // simctl is faster and needs no WDA session, so prefer it on simulators.
    if (this.sim) {
      const data = await this.sim.screenshot(this.udid);
      const s = this.info.screen ?? { width: 0, height: 0 };
      return { data, width: s.width, height: s.height, scale: 1 };
    }
    if (!this.wda) throw noWda("Screenshots");
    const b64 = await this.wda.screenshotBase64();
    const data = Buffer.from(b64, "base64");
    const s = this.info.screen ?? { width: 0, height: 0 };
    return { data, width: s.width, height: s.height, scale: 1 };
  }

  async tap(x: number, y: number, durationMs?: number): Promise<void> {
    if (!this.wda) throw noWda("Tapping");
    await this.wda.tap(x, y, durationMs ?? 0);
  }

  async swipe(from: [number, number], to: [number, number], durationMs = 300): Promise<void> {
    if (!this.wda) throw noWda("Swiping");
    await this.wda.drag(from, to, durationMs);
  }

  async typeText(text: string, opts: { submit?: boolean } = {}): Promise<void> {
    if (!this.wda) throw noWda("Typing");
    await this.wda.typeText(text);
    if (opts.submit) await this.pressKey("enter");
  }

  async clearText(): Promise<void> {
    if (!this.wda) throw noWda("Clearing text");
    // XCUITest has no select-all; backspace enough times to empty a normal field.
    await this.wda.typeText(BACKSPACE.repeat(80));
  }

  async pressKey(key: KeyName): Promise<void> {
    if (!this.wda) throw noWda("Key presses");
    switch (key) {
      case "home":
        await this.wda.home();
        return;
      case "enter":
        await this.wda.typeText("\n");
        return;
      case "delete":
        await this.wda.typeText(BACKSPACE);
        return;
      case "volume_up":
        await this.wda.pressButton("volumeUp");
        return;
      case "volume_down":
        await this.wda.pressButton("volumeDown");
        return;
      case "back":
        // iOS has no global back; the navigation bar's leading button is the convention.
        throw err("unsupported", "iOS has no global back key", {
          hint: 'Tap the nav bar back button, e.g. {"selector":{"role":"Button","index":0}}, or swipe right from the left edge.',
        });
      default:
        throw err("unsupported", `key "${key}" is not available on iOS`);
    }
  }

  async listApps(): Promise<AppInfo[]> {
    if (this.sim) {
      const apps = await this.sim.listApps(this.udid);
      return apps.map((a) => ({ id: a.id, name: a.name, system: a.system }));
    }
    throw err("unsupported", "listing apps on a physical iPhone is not supported", {
      hint: "Launch by bundle id directly with phone_open_app.",
    });
  }

  async launchApp(appId: string): Promise<void> {
    if (this.sim) {
      await this.sim.launch(this.udid, appId);
      return;
    }
    if (this.devicectl) {
      await this.devicectl.launch(this.udid, appId);
      return;
    }
    if (this.wda) {
      await this.wda.launchApp(appId);
      return;
    }
    throw noWda("Launching apps");
  }

  async stopApp(appId: string): Promise<void> {
    if (this.sim) {
      await this.sim.terminate(this.udid, appId);
      return;
    }
    if (!this.wda) throw noWda("Stopping apps");
    await this.wda.terminateApp(appId);
  }

  async installApp(path: string): Promise<void> {
    if (this.sim) {
      await this.sim.install(this.udid, path);
      return;
    }
    if (this.devicectl) {
      await this.devicectl.install(this.udid, path);
      return;
    }
    throw err("unsupported", "no install path available for this device");
  }

  async openUrl(url: string): Promise<void> {
    if (this.sim) {
      await this.sim.openUrl(this.udid, url);
      return;
    }
    if (!this.wda) throw noWda("Opening URLs");
    await this.wda.openUrl(url);
  }

  async currentApp(): Promise<{ app?: string; activity?: string }> {
    if (!this.wda) return {};
    try {
      const a = await this.wda.activeApp();
      return { app: a.bundleId, activity: a.name };
    } catch {
      return {};
    }
  }

  async dispose(): Promise<void> {}
}

export class IosProvider implements DeviceProvider {
  readonly platform = "ios" as const;
  private simctl: Simctl;
  private devicectl: DeviceCtl;

  constructor(
    private run: Runner = runCommand,
    private opts: IosOptions = {},
  ) {
    this.simctl = new Simctl(run);
    this.devicectl = new DeviceCtl(run);
  }

  private wdaUrl(): string {
    return this.opts.wdaUrl ?? process.env.PHONE_WDA_URL ?? "http://127.0.0.1:8100";
  }

  async requirements() {
    const xcrun = await which("xcrun", this.run).catch(() => null);
    const url = this.wdaUrl();
    let wdaOk = false;
    let wdaDetail = `${url} - not reachable; iOS perception and input need WebDriverAgent`;
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/status`, { signal: AbortSignal.timeout(2500) });
      wdaOk = res.ok;
      if (res.ok) wdaDetail = `${url} - reachable`;
    } catch {
      /* reported as not ok */
    }
    return [
      { name: "xcrun", ok: Boolean(xcrun), detail: xcrun ?? "install Xcode command line tools" },
      { name: "WebDriverAgent", ok: wdaOk, detail: wdaDetail },
    ];
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const out: DeviceInfo[] = [];
    try {
      for (const s of await this.simctl.list()) {
        out.push({
          id: `ios:${s.udid}`,
          platform: "ios",
          transport: "simulator",
          name: `${s.name} (Simulator)`,
          osVersion: s.runtime,
          state: s.state === "Booted" ? "available" : "offline",
          meta: { udid: s.udid, simulator: true, simState: s.state },
        });
      }
    } catch (e) {
      log.warn("simctl list failed", (e as Error).message);
    }
    try {
      for (const d of await this.devicectl.list()) {
        out.push({
          id: `ios:${d.udid}`,
          platform: "ios",
          transport: "usb",
          name: d.name,
          osVersion: d.osVersion,
          state: "available",
          meta: { udid: d.udid, simulator: false, tunnel: d.state },
        });
      }
    } catch (e) {
      log.debug("devicectl list failed", (e as Error).message);
    }
    return out;
  }

  async open(deviceId: string): Promise<Device> {
    const udid = deviceId.replace(/^ios:/, "");
    const sims = await this.simctl.list().catch(() => []);
    const sim = sims.find((s) => s.udid === udid || s.name === udid);
    const url = this.wdaUrl();

    let wda: WdaClient | undefined = new WdaClient({ baseUrl: url });
    try {
      await wda.status();
    } catch {
      log.warn(
        `WebDriverAgent not reachable at ${url}; lifecycle and screenshots will work, ` +
          "but tapping/typing/observing will not. See README -> iOS setup.",
      );
      wda = undefined;
    }

    if (sim) {
      if (sim.state !== "Booted" && this.opts.autoBoot !== false) {
        log.info(`booting simulator ${sim.name}`);
        await this.simctl.boot(sim.udid);
      }
      const info: DeviceInfo = {
        id: `ios:${sim.udid}`,
        platform: "ios",
        transport: "simulator",
        name: `${sim.name} (Simulator)`,
        osVersion: sim.runtime,
        state: "available",
        meta: { udid: sim.udid, simulator: true },
      };
      const device = new IosDevice(info, wda, this.simctl, undefined, sim.udid);
      await device.refreshInfo();
      return device;
    }

    const phys = (await this.devicectl.list().catch(() => [])).find((d) => d.udid === udid);
    if (!phys) {
      throw err("device_not_found", `No iOS device or simulator ${udid}`, {
        hint: "Run `phone devices` to list what the harness can see.",
      });
    }
    const info: DeviceInfo = {
      id: `ios:${phys.udid}`,
      platform: "ios",
      transport: "usb",
      name: phys.name,
      osVersion: phys.osVersion,
      state: "available",
      meta: { udid: phys.udid, simulator: false },
    };
    const device = new IosDevice(info, wda, undefined, this.devicectl, phys.udid);
    await device.refreshInfo();
    return device;
  }
}
