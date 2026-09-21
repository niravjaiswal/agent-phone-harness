import { PNG } from "pngjs";
import { encodePng, fillRect, strokeRect } from "../../core/image.js";
import { finalizeElements, type RawElement } from "../../core/elements.js";
import { err } from "../../core/errors.js";
import type {
  AppInfo, DeepLink, Device, DeviceInfo, DeviceProvider, KeyName, Message,
  NotificationItem, Rect, ScreenContext, Screenshot, ScreenshotOptions, UiElement,
} from "../../core/types.js";

/**
 * A deterministic fake phone.
 *
 * Exists so the entire harness — session core, policy, approvals, secrets,
 * MCP surface — can be exercised end to end with no hardware, in CI, and as a
 * zero-setup demo. The scripted app deliberately covers the flow that motivates
 * the project: login → SMS OTP → a money transfer that must be gated.
 */

const W = 1080;
const H = 2340;

interface MockNode {
  role: string;
  text?: string;
  label?: string;
  id?: string;
  value?: string;
  password?: boolean;
  clickable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  checked?: boolean;
  height?: number;
  /** Screen to move to when tapped. */
  goto?: string;
  /** Side effect when tapped. */
  action?: (d: MockDevice) => void;
  /** Field key this element edits. */
  field?: string;
}

interface MockScreen {
  app: string;
  activity: string;
  nodes: (d: MockDevice) => MockNode[];
}

const BANK = "com.example.demobank";
const LAUNCHER = "com.mock.launcher";

const SCREENS: Record<string, MockScreen> = {
  "launcher.home": {
    app: LAUNCHER,
    activity: ".Home",
    nodes: () => [
      { role: "Text", text: "Mock Phone", height: 120 },
      { role: "Button", text: "Demo Bank", id: `${LAUNCHER}:id/app_demobank`, clickable: true, goto: "bank.login", height: 180 },
      { role: "Button", text: "Messages", id: `${LAUNCHER}:id/app_messages`, clickable: true, goto: "messages.inbox", height: 180 },
      { role: "Button", text: "Settings", id: `${LAUNCHER}:id/app_settings`, clickable: true, goto: "settings.root", height: 180 },
    ],
  },
  "bank.login": {
    app: BANK,
    activity: ".LoginActivity",
    nodes: (d) => [
      { role: "Text", text: "Demo Bank", height: 160 },
      { role: "Text", text: "Sign in to continue", height: 100 },
      { role: "TextField", label: "Username", id: `${BANK}:id/username`, field: "username", value: d.fields.username ?? "", clickable: true, height: 140 },
      { role: "TextField", label: "Password", id: `${BANK}:id/password`, field: "password", password: true, value: d.fields.password ?? "", clickable: true, height: 140 },
      {
        role: "Button", text: "Sign in", id: `${BANK}:id/signin`, clickable: true, height: 150,
        enabled: Boolean(d.fields.username && d.fields.password),
        goto: "bank.otp",
        action: (dev) => dev.deliverOtp(),
      },
      { role: "Text", text: "Forgot password?", clickable: true, height: 90 },
    ],
  },
  "bank.otp": {
    app: BANK,
    activity: ".OtpActivity",
    nodes: (d) => [
      { role: "Text", text: "Two-factor authentication", height: 140 },
      { role: "Text", text: "Enter the 6-digit code we texted you", height: 100 },
      { role: "TextField", label: "Verification code", id: `${BANK}:id/otp`, field: "otp", value: d.fields.otp ?? "", clickable: true, height: 140 },
      {
        role: "Button", text: "Verify", id: `${BANK}:id/verify`, clickable: true, height: 150,
        enabled: (d.fields.otp ?? "").length === 6,
        action: (dev) => {
          if (dev.fields.otp !== dev.expectedOtp) {
            dev.flash = "Incorrect code";
            return;
          }
          dev.flash = undefined;
          dev.screen = "bank.home";
        },
      },
      ...(d.flash ? [{ role: "Text", text: d.flash, height: 90 } as MockNode] : []),
    ],
  },
  "bank.home": {
    app: BANK,
    activity: ".HomeActivity",
    nodes: () => [
      { role: "Text", text: "Checking ••4821", height: 120 },
      { role: "Text", text: "Balance $1,234.56", height: 160 },
      { role: "Button", text: "Send money", id: `${BANK}:id/send`, clickable: true, goto: "bank.send", height: 150 },
      { role: "Button", text: "Statements", id: `${BANK}:id/statements`, clickable: true, height: 150 },
      { role: "List", scrollable: true, label: "Recent transactions", height: 700 },
      { role: "Button", text: "Sign out", id: `${BANK}:id/signout`, clickable: true, goto: "bank.login", height: 140 },
    ],
  },
  "bank.send": {
    app: BANK,
    activity: ".SendMoneyActivity",
    nodes: (d) => [
      { role: "Text", text: "Send money", height: 140 },
      { role: "TextField", label: "Recipient", id: `${BANK}:id/recipient`, field: "recipient", value: d.fields.recipient ?? "", clickable: true, height: 140 },
      { role: "TextField", label: "Amount", id: `${BANK}:id/amount`, field: "amount", value: d.fields.amount ?? "", clickable: true, height: 140 },
      {
        role: "Button", text: "Confirm transfer", id: `${BANK}:id/confirm`, clickable: true, height: 150,
        enabled: Boolean(d.fields.recipient && d.fields.amount),
        goto: "bank.sent",
      },
      { role: "Button", text: "Cancel", clickable: true, goto: "bank.home", height: 140 },
    ],
  },
  "bank.sent": {
    app: BANK,
    activity: ".ReceiptActivity",
    nodes: (d) => [
      { role: "Text", text: "Transfer complete", height: 160 },
      { role: "Text", text: `Sent ${d.fields.amount ?? "?"} to ${d.fields.recipient ?? "?"}`, height: 120 },
      { role: "Button", text: "Done", clickable: true, goto: "bank.home", height: 150 },
    ],
  },
  "messages.inbox": {
    app: "com.mock.messages",
    activity: ".Inbox",
    nodes: (d) => [
      { role: "Text", text: "Messages", height: 140 },
      ...d.sms.map(
        (m): MockNode => ({ role: "Cell", text: `${m.from}: ${m.body}`, clickable: true, height: 160 }),
      ),
    ],
  },
  "settings.root": {
    app: "com.android.settings",
    activity: ".Settings",
    nodes: () => [
      { role: "Text", text: "Settings", height: 140 },
      { role: "Cell", text: "Network & internet", clickable: true, height: 150 },
      { role: "Cell", text: "Erase all data (factory reset)", clickable: true, height: 150 },
    ],
  },
};

export class MockDevice implements Device {
  info: DeviceInfo;
  screen = "launcher.home";
  fields: Record<string, string> = {};
  sms: Message[] = [];
  notifications: NotificationItem[] = [];
  clipboard = "";
  expectedOtp = "";
  flash?: string;
  focusedField?: string;
  /** Every action taken — assertions in tests read this. */
  readonly log: string[] = [];

  constructor(id = "mock:demo") {
    this.info = {
      id,
      platform: "mock",
      transport: "memory",
      name: "Mock Phone",
      osVersion: "1.0",
      screen: { width: W, height: H, density: 3 },
      state: "available",
    };
  }

  async ping(): Promise<void> {}
  async refreshInfo(): Promise<DeviceInfo> {
    return this.info;
  }
  async dispose(): Promise<void> {}

  private current(): MockScreen {
    const s = SCREENS[this.screen];
    if (!s) throw err("provider_error", `mock screen ${this.screen} missing`);
    return s;
  }

  /** Vertical stack layout — deterministic bounds, which is what tests need. */
  private layout(): { node: MockNode; bounds: Rect }[] {
    const nodes = this.current().nodes(this);
    let y = 120;
    return nodes.map((node) => {
      const height = node.height ?? 120;
      const bounds: Rect = { x: 48, y, width: W - 96, height: height - 20 };
      y += height;
      return { node, bounds };
    });
  }

  async dumpUi(): Promise<{ elements: UiElement[]; screen: ScreenContext; prunedCount: number }> {
    const s = this.current();
    const raw: RawElement[] = this.layout().map(({ node, bounds }, i) => ({
      role: node.role,
      text: node.text,
      label: node.label,
      value: node.password ? "•".repeat((node.value ?? "").length) : node.value,
      id: node.id,
      bounds,
      enabled: node.enabled !== false,
      clickable: Boolean(node.clickable),
      scrollable: Boolean(node.scrollable),
      focused: node.field !== undefined && node.field === this.focusedField,
      checked: node.checked,
      password: node.password,
      depth: 1 + (i === 0 ? 0 : 1),
      pkg: s.app,
      childCount: 0,
    }));
    return {
      elements: finalizeElements(raw),
      screen: { app: s.app, activity: s.activity, width: W, height: H, orientation: "portrait" },
      prunedCount: 0,
    };
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Screenshot> {
    const png = new PNG({ width: W, height: H });
    fillRect(png, { x: 0, y: 0, width: W, height: H }, [248, 248, 250, 255]);
    fillRect(png, { x: 0, y: 0, width: W, height: 90 }, [30, 30, 40, 255]);
    for (const { node, bounds } of this.layout()) {
      const bg: [number, number, number, number] = node.clickable
        ? node.role === "Button"
          ? [40, 110, 240, 255]
          : [255, 255, 255, 255]
        : [240, 240, 244, 255];
      fillRect(png, bounds, node.enabled === false ? [200, 200, 210, 255] : bg);
      strokeRect(png, bounds, [190, 190, 200, 255], 2);
    }
    const data = encodePng(png);
    void opts;
    return { data, width: W, height: H, scale: 1 };
  }

  async tap(x: number, y: number): Promise<void> {
    this.log.push(`tap(${x},${y})`);
    const hit = [...this.layout()]
      .reverse()
      .find(({ bounds }) => x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height);
    if (!hit) return;
    const { node } = hit;
    if (node.enabled === false) return;
    if (node.field) this.focusedField = node.field;
    if (node.action) node.action(this);
    if (node.goto && node.clickable) this.screen = node.goto;
  }

  async swipe(from: [number, number], to: [number, number]): Promise<void> {
    this.log.push(`swipe(${from.join(",")}->${to.join(",")})`);
  }

  async typeText(text: string, opts: { submit?: boolean } = {}): Promise<void> {
    this.log.push(`type(${text.length} chars)`);
    if (!this.focusedField) {
      throw err("bad_request", "nothing focused on the mock device", {
        hint: "Tap the target field first.",
      });
    }
    this.fields[this.focusedField] = (this.fields[this.focusedField] ?? "") + text;
    if (opts.submit) await this.pressKey("enter");
  }

  async clearText(): Promise<void> {
    if (this.focusedField) this.fields[this.focusedField] = "";
  }

  async pressKey(key: KeyName): Promise<void> {
    this.log.push(`key(${key})`);
    if (key === "home") this.screen = "launcher.home";
    if (key === "back") {
      const back: Record<string, string> = {
        "bank.login": "launcher.home",
        "bank.otp": "bank.login",
        "bank.send": "bank.home",
        "bank.sent": "bank.home",
        "messages.inbox": "launcher.home",
        "settings.root": "launcher.home",
      };
      this.screen = back[this.screen] ?? this.screen;
    }
  }

  async listApps(): Promise<AppInfo[]> {
    return [
      { id: BANK, name: "Demo Bank" },
      { id: "com.mock.messages", name: "Messages" },
      { id: "com.android.settings", name: "Settings", system: true },
      { id: LAUNCHER, name: "Launcher", system: true },
    ];
  }

  async launchApp(appId: string): Promise<void> {
    this.log.push(`launch(${appId})`);
    const first = Object.entries(SCREENS).find(([, s]) => s.app === appId);
    if (!first) throw err("bad_request", `mock device has no app ${appId}`);
    this.screen = first[0];
  }

  async stopApp(appId: string): Promise<void> {
    this.log.push(`stop(${appId})`);
    this.screen = "launcher.home";
  }

  async clearAppData(appId: string): Promise<void> {
    this.log.push(`clear(${appId})`);
    this.fields = {};
  }

  async openUrl(url: string): Promise<void> {
    this.log.push(`openUrl(${url})`);
    if (url.startsWith("demobank://send")) this.screen = "bank.send";
    else if (url.startsWith("demobank://")) this.screen = "bank.home";
  }

  async listDeepLinks(appId: string): Promise<DeepLink[]> {
    if (appId !== BANK) return [];
    return [
      { scheme: "demobank", host: "home", example: "demobank://home", activity: `${BANK}/.HomeActivity` },
      { scheme: "demobank", host: "send", example: "demobank://send", activity: `${BANK}/.SendMoneyActivity` },
    ];
  }

  async currentApp(): Promise<{ app?: string; activity?: string }> {
    const s = this.current();
    return { app: s.app, activity: s.activity };
  }

  async readSms(opts: { limit?: number; sinceMs?: number } = {}): Promise<Message[]> {
    let out = [...this.sms].sort((a, b) => b.timestamp - a.timestamp);
    if (opts.sinceMs) out = out.filter((m) => m.timestamp >= opts.sinceMs!);
    return out.slice(0, opts.limit ?? 20);
  }

  async readNotifications(opts: { limit?: number } = {}): Promise<NotificationItem[]> {
    return this.notifications.slice(0, opts.limit ?? 20);
  }

  async clipboardGet(): Promise<string> {
    return this.clipboard;
  }
  async clipboardSet(text: string): Promise<void> {
    this.clipboard = text;
  }

  /** Simulate the carrier delivering a 2FA code. */
  deliverOtp(code?: string): string {
    this.expectedOtp = code ?? String(Math.floor(100000 + Math.random() * 900000));
    const m: Message = {
      id: String(this.sms.length + 1),
      from: "+15550001111",
      body: `Demo Bank: your verification code is ${this.expectedOtp}. Do not share it.`,
      timestamp: Date.now(),
    };
    this.sms.push(m);
    this.notifications.unshift({ pkg: "com.mock.messages", title: "Demo Bank", text: m.body, timestamp: m.timestamp });
    return this.expectedOtp;
  }
}

export class MockProvider implements DeviceProvider {
  readonly platform = "mock" as const;
  private devices = new Map<string, MockDevice>();

  async requirements() {
    return [{ name: "mock", ok: true, detail: "built in — no external tooling required" }];
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return [this.ensure("mock:demo").info];
  }

  async open(deviceId: string): Promise<Device> {
    return this.ensure(deviceId);
  }

  /** Reset between tests. */
  reset(deviceId = "mock:demo"): MockDevice {
    this.devices.delete(deviceId);
    return this.ensure(deviceId);
  }

  private ensure(id: string): MockDevice {
    let d = this.devices.get(id);
    if (!d) {
      d = new MockDevice(id);
      this.devices.set(id, d);
    }
    return d;
  }
}
