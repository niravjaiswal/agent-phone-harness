import { finalizeElements } from "../../core/elements.js";
import { err } from "../../core/errors.js";
import { runCommand, type Runner } from "../../core/exec.js";
import { logger } from "../../core/logger.js";
import type {
  AppInfo, Device, DeviceInfo, DeviceProvider, KeyName, Message,
  NotificationItem, ScreenContext, Screenshot, UiElement,
} from "../../core/types.js";
import {
  Adb, findAdb, parseCurrentApp, parseDensity, parseDevices, parsePackages,
  parseSmsRows, parseWmSize, shQuote,
} from "./adb.js";
import { parseUiAutomatorXml } from "./uiautomator.js";

const log = logger("android");

const KEYCODES: Record<KeyName, string> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  delete: "KEYCODE_DEL",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  power: "KEYCODE_POWER",
  search: "KEYCODE_SEARCH",
  menu: "KEYCODE_MENU",
};

const DUMP_PATH = "/sdcard/.agent-phone-dump.xml";

export interface AndroidOptions {
  /**
   * Route text through the ADBKeyboard IME broadcast instead of `input text`.
   * Required for non-ASCII input; see README for the one-time setup.
   */
  useAdbKeyboard?: boolean;
}

export class AndroidDevice implements Device {
  info: DeviceInfo;

  constructor(
    private adb: Adb,
    info: DeviceInfo,
    private opts: AndroidOptions = {},
  ) {
    this.info = info;
  }

  async ping(): Promise<void> {
    await this.adb.assertOnline();
  }

  async refreshInfo(): Promise<DeviceInfo> {
    const [size, density] = await Promise.all([
      this.adb.shell("wm size"),
      this.adb.shell("wm density").catch(() => ""),
    ]);
    const s = parseWmSize(size);
    if (s) {
      const d = parseDensity(density);
      this.info.screen = d !== undefined ? { ...s, density: d } : s;
    }
    return this.info;
  }

  // ------------------------------------------------------------ perception

  async dumpUi(): Promise<{ elements: UiElement[]; screen: ScreenContext; prunedCount: number }> {
    const xml = await this.readUiXml();
    const parsed = parseUiAutomatorXml(xml);
    const current = await this.currentApp();
    const size =
      this.info.screen ??
      (parsed.rootBounds
        ? { width: parsed.rootBounds.width, height: parsed.rootBounds.height }
        : { width: 1080, height: 2340 });

    const screen: ScreenContext = {
      app: current.app ?? parsed.pkg,
      activity: current.activity,
      width: size.width,
      height: size.height,
      orientation: size.width > size.height ? "landscape" : "portrait",
    };
    return { elements: finalizeElements(parsed.elements), screen, prunedCount: 0 };
  }

  /**
   * uiautomator's dump is flaky when streamed to /dev/tty on some OEM builds,
   * so write to a file and cat it back. One retry covers the "window is
   * mid-animation" failure, which is common right after a tap.
   */
  private async readUiXml(attempt = 0): Promise<string> {
    const out = await this.adb.shell(
      `uiautomator dump --compressed ${DUMP_PATH} >/dev/null 2>&1; cat ${DUMP_PATH}`,
      { timeoutMs: 25_000, allowFailure: true },
    );
    const i = out.indexOf("<?xml");
    if (i >= 0 && out.includes("</hierarchy>")) return out.slice(i);
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 600));
      return this.readUiXml(attempt + 1);
    }
    throw err("provider_error", "uiautomator dump returned no hierarchy", {
      hint: "Screen may be off or showing a secure window (FLAG_SECURE). Wake the device and retry.",
      details: { output: out.slice(0, 200) },
    });
  }

  async screenshot(): Promise<Screenshot> {
    const data = await this.adb.execOut("screencap -p", { timeoutMs: 30_000 });
    if (data.length < 8 || data[0] !== 0x89 || data[1] !== 0x50) {
      throw err("provider_error", "screencap did not return a PNG", {
        hint: "Some secure screens block capture. Use phone_observe (accessibility tree) instead.",
      });
    }
    const s = this.info.screen ?? { width: 0, height: 0 };
    return { data, width: s.width, height: s.height, scale: 1 };
  }

  // ------------------------------------------------------------ input

  async tap(x: number, y: number, durationMs?: number): Promise<void> {
    if (durationMs && durationMs > 0) {
      await this.adb.shell(`input swipe ${x} ${y} ${x} ${y} ${durationMs}`);
      return;
    }
    await this.adb.shell(`input tap ${x} ${y}`);
  }

  async swipe(from: [number, number], to: [number, number], durationMs = 300): Promise<void> {
    await this.adb.shell(`input swipe ${from[0]} ${from[1]} ${to[0]} ${to[1]} ${durationMs}`);
  }

  async typeText(text: string, opts: { submit?: boolean } = {}): Promise<void> {
    if (this.opts.useAdbKeyboard) {
      await this.adb.shell(`am broadcast -a ADB_INPUT_TEXT --es msg ${shQuote(text)}`);
    } else {
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\x7F]/.test(text)) {
        throw err("unsupported", "`input text` cannot type non-ASCII characters", {
          hint: "Install ADBKeyboard on the device and start the session with useAdbKeyboard, or paste via the clipboard.",
        });
      }
      // Chunked: very long strings intermittently truncate on some builds.
      for (const part of chunks(text, 180)) {
        await this.adb.shell(`input text ${shQuote(part)}`);
      }
    }
    if (opts.submit) await this.pressKey("enter");
  }

  async clearText(): Promise<void> {
    if (this.opts.useAdbKeyboard) {
      await this.adb.shell("am broadcast -a ADB_CLEAR_TEXT");
      return;
    }
    // Move to the end then backspace: correct regardless of cursor position,
    // and `input keyevent` accepts a batch of keycodes in one round trip.
    await this.adb.shell("input keyevent KEYCODE_MOVE_END");
    await this.adb.shell(`input keyevent ${Array(60).fill("KEYCODE_DEL").join(" ")}`);
  }

  async pressKey(key: KeyName): Promise<void> {
    await this.adb.shell(`input keyevent ${KEYCODES[key]}`);
  }

  // ------------------------------------------------------------ apps

  async listApps(): Promise<AppInfo[]> {
    const [third, all] = await Promise.all([
      this.adb.shell("pm list packages -3"),
      this.adb.shell("pm list packages"),
    ]);
    const thirdSet = new Set(parsePackages(third));
    return parsePackages(all).map((id) => ({ id, system: !thirdSet.has(id) }));
  }

  async launchApp(appId: string): Promise<void> {
    const resolved = await this.adb.shell(
      `cmd package resolve-activity --brief ${shQuote(appId)}`,
      { allowFailure: true },
    );
    const component = resolved
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes("/") && !l.startsWith("priority") && !l.includes(" "));
    if (component) {
      await this.adb.shell(`am start -W -n ${shQuote(component)}`);
      return;
    }
    const out = await this.adb.shell(
      `monkey -p ${shQuote(appId)} -c android.intent.category.LAUNCHER 1`,
      { allowFailure: true },
    );
    if (/No activities found|Error/.test(out)) {
      throw err("bad_request", `Could not launch ${appId}`, {
        hint: "Check the package id with phone_list_apps.",
        details: { output: out.slice(0, 200) },
      });
    }
  }

  async stopApp(appId: string): Promise<void> {
    await this.adb.shell(`am force-stop ${shQuote(appId)}`);
  }

  async clearAppData(appId: string): Promise<void> {
    await this.adb.shell(`pm clear ${shQuote(appId)}`);
  }

  async installApp(path: string): Promise<void> {
    await this.adb.exec(["install", "-r", "-g", path], { timeoutMs: 180_000 });
  }

  async openUrl(url: string): Promise<void> {
    await this.adb.shell(`am start -a android.intent.action.VIEW -d ${shQuote(url)}`);
  }

  async currentApp(): Promise<{ app?: string; activity?: string }> {
    const win = await this.adb.shell(
      "dumpsys window displays | grep -E 'mCurrentFocus|mFocusedApp' | head -5",
      { allowFailure: true },
    );
    const fromWindow = parseCurrentApp(win);
    if (fromWindow.app) return fromWindow;
    const act = await this.adb.shell(
      "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -3",
      { allowFailure: true },
    );
    return parseCurrentApp(act);
  }

  // ------------------------------------------------------------ side channels

  async readSms(opts: { limit?: number; sinceMs?: number } = {}): Promise<Message[]> {
    const out = await this.adb.shell(
      `content query --uri content://sms/inbox --projection address:body:date --sort ${shQuote("date DESC")}`,
      { allowFailure: true },
    );
    if (/Permission Denial|SecurityException/.test(out)) {
      throw err("unsupported", "shell is not permitted to read SMS on this device", {
        hint:
          "Grant it once with `adb shell pm grant com.android.shell android.permission.READ_SMS`, " +
          "or read the code from notifications instead (phone_read_notifications).",
      });
    }
    let rows = parseSmsRows(out).map((r) => ({ from: r.address, body: r.body, timestamp: r.date }));
    if (opts.sinceMs) rows = rows.filter((r) => r.timestamp >= opts.sinceMs!);
    return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, opts.limit ?? 20);
  }

  async readNotifications(opts: { limit?: number } = {}): Promise<NotificationItem[]> {
    const out = await this.adb.shell("dumpsys notification --noredact", { allowFailure: true, timeoutMs: 20_000 });
    return parseNotifications(out).slice(0, opts.limit ?? 20);
  }

  async clipboardGet(): Promise<string> {
    const out = await this.adb.shell("cmd clipboard get-text", { allowFailure: true });
    if (/Unknown command|Exception/.test(out)) {
      throw err("unsupported", "this Android build does not expose `cmd clipboard`");
    }
    return out.trim();
  }

  async clipboardSet(text: string): Promise<void> {
    const out = await this.adb.shell(`cmd clipboard set-text ${shQuote(text)}`, { allowFailure: true });
    if (/Unknown command|Exception/.test(out)) {
      throw err("unsupported", "this Android build does not expose `cmd clipboard`");
    }
  }

  async shell(command: string): Promise<string> {
    return this.adb.shell(command, { allowFailure: true, timeoutMs: 60_000 });
  }

  async dispose(): Promise<void> {
    await this.adb.shell(`rm -f ${DUMP_PATH}`, { allowFailure: true }).catch(() => {});
  }
}

/** `dumpsys notification --noredact` → title/text pairs. */
export function parseNotifications(out: string): NotificationItem[] {
  const items: NotificationItem[] = [];
  const blocks = out.split(/NotificationRecord\(/).slice(1);
  for (const b of blocks) {
    const pkg = /pkg=([A-Za-z0-9_.]+)/.exec(b)?.[1];
    if (!pkg) continue;
    const title = /android\.title=(?:String \()?([^)\n]*)/.exec(b)?.[1]?.trim();
    const text = /android\.text=(?:String \()?([^)\n]*)/.exec(b)?.[1]?.trim();
    const when = /when=(\d+)/.exec(b)?.[1];
    if (!title && !text) continue;
    items.push({
      pkg,
      title: clean(title),
      text: clean(text),
      timestamp: when ? Number(when) : undefined,
    });
  }
  return items;
}

const clean = (s?: string) => {
  if (!s) return undefined;
  const t = s.replace(/^String \(/, "").replace(/\)$/, "").trim();
  return t || undefined;
};

function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

export class AndroidProvider implements DeviceProvider {
  readonly platform = "android" as const;
  private adbPath?: string;

  constructor(private run: Runner = runCommand, private opts: AndroidOptions = {}) {}

  private async resolveAdb(): Promise<string> {
    if (this.adbPath) return this.adbPath;
    const p = await findAdb(this.run);
    if (!p) {
      throw err("tool_missing", "adb not found", {
        hint: "brew install --cask android-platform-tools, or set PHONE_ADB=/path/to/adb",
      });
    }
    this.adbPath = p;
    return p;
  }

  async requirements() {
    const p = await findAdb(this.run).catch(() => null);
    return [
      {
        name: "adb",
        ok: Boolean(p),
        detail: p ?? "not found — `brew install --cask android-platform-tools` or set PHONE_ADB",
      },
    ];
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const adbPath = await this.resolveAdb();
    const r = await this.run(adbPath, ["devices", "-l"], { timeoutMs: 15_000, allowFailure: true });
    return parseDevices(r.stdout).map((d) => ({
      id: `android:${d.serial}`,
      platform: "android" as const,
      transport: d.serial.includes(":") ? ("tcp" as const) : d.serial.startsWith("emulator-") ? ("emulator" as const) : ("usb" as const),
      name: d.model?.replace(/_/g, " ") ?? d.serial,
      state:
        d.state === "device"
          ? ("available" as const)
          : d.state === "unauthorized"
            ? ("unauthorized" as const)
            : ("offline" as const),
      meta: { serial: d.serial, raw: d.state },
    }));
  }

  /** `adb connect host:port` — this is what makes "the agent's phone" location-independent. */
  async connect(hostPort: string): Promise<string> {
    const adbPath = await this.resolveAdb();
    const r = await this.run(adbPath, ["connect", hostPort], { timeoutMs: 20_000, allowFailure: true });
    if (!/connected to/i.test(r.stdout)) {
      throw err("device_unreachable", `adb connect ${hostPort} failed: ${r.stdout.trim()}`, {
        hint: "Enable wireless debugging on the phone and make sure the host is reachable (e.g. over Tailscale).",
      });
    }
    log.info(`connected to ${hostPort}`);
    return `android:${hostPort}`;
  }

  async open(deviceId: string): Promise<Device> {
    const adbPath = await this.resolveAdb();
    const serial = deviceId.replace(/^android:/, "");
    const adb = new Adb(serial, adbPath, this.run);
    await adb.assertOnline();

    const [sizeOut, densityOut, release] = await Promise.all([
      adb.shell("wm size").catch(() => ""),
      adb.shell("wm density").catch(() => ""),
      adb.shell("getprop ro.build.version.release").catch(() => ""),
    ]);
    const size = parseWmSize(sizeOut) ?? { width: 1080, height: 2340 };
    const density = parseDensity(densityOut);
    const model = (await adb.shell("getprop ro.product.model").catch(() => "")).trim();

    const info: DeviceInfo = {
      id: `android:${serial}`,
      platform: "android",
      transport: serial.includes(":") ? "tcp" : serial.startsWith("emulator-") ? "emulator" : "usb",
      name: model || serial,
      osVersion: release.trim() || undefined,
      screen: density !== undefined ? { ...size, density } : size,
      state: "available",
      meta: { serial },
    };
    return new AndroidDevice(adb, info, this.opts);
  }
}
