import { err } from "../../core/errors.js";
import type { RawElement } from "../../core/elements.js";
import type { Rect } from "../../core/types.js";

/**
 * WebDriverAgent client.
 *
 * WDA is the only input path that works on both the Simulator and a physical
 * iPhone, so it is the harness's iOS backend. `simctl`/`devicectl` handle
 * lifecycle; everything touch-related goes through here.
 */

export interface WdaSourceNode {
  type?: string;
  name?: string | null;
  label?: string | null;
  value?: unknown;
  rawIdentifier?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  frame?: string;
  isEnabled?: boolean | string;
  isVisible?: boolean | string;
  isAccessible?: boolean | string;
  children?: WdaSourceNode[];
}

const truthy = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === 1;

const TYPE_MAP: [RegExp, string][] = [
  [/SecureTextField/, "SecureTextField"],
  [/TextField|SearchField|TextView/, "TextField"],
  [/Button|Link/, "Button"],
  [/Switch|Toggle/, "Switch"],
  [/Slider/, "Slider"],
  [/PickerWheel|Picker|DatePicker/, "Picker"],
  [/Cell/, "Cell"],
  [/Table|CollectionView|ScrollView/, "List"],
  [/TabBar/, "TabBar"],
  [/NavigationBar|Toolbar/, "Toolbar"],
  [/StaticText/, "Text"],
  [/Image|Icon/, "Image"],
  [/WebView/, "WebView"],
  [/Application|Window|Other|Group/, "Group"],
];

export function roleFromType(type: string | undefined): string {
  const t = (type ?? "").replace(/^XCUIElementType/, "");
  for (const [re, role] of TYPE_MAP) if (re.test(t)) return role;
  return t || "Other";
}

/** Types iOS treats as directly actionable — WDA exposes no `clickable` flag. */
const INTERACTIVE = /Button|Link|Cell|Switch|TextField|SecureTextField|TextView|Tab|SegmentedControl|PickerWheel|Slider|Stepper|MenuItem|SearchField/;

export function parseWdaSource(root: WdaSourceNode): RawElement[] {
  const out: RawElement[] = [];
  const walk = (n: WdaSourceNode, depth: number) => {
    const rect = n.rect ?? parseFrame(n.frame);
    const children = n.children ?? [];
    if (rect) {
      const type = (n.type ?? "").replace(/^XCUIElementType/, "");
      const role = roleFromType(n.type);
      const label = n.label?.trim() || undefined;
      const name = n.rawIdentifier?.trim() || n.name?.trim() || undefined;
      const rawValue = n.value;
      const value =
        rawValue === null || rawValue === undefined
          ? undefined
          : typeof rawValue === "string"
            ? rawValue
            : String(rawValue);
      const isSwitch = /Switch|Toggle/.test(type);
      out.push({
        role,
        // iOS puts visible copy in `label`; `name` is usually the a11y identifier.
        text: /Text|Button|Cell|Link/.test(role) ? label : undefined,
        label,
        value: isSwitch ? undefined : value,
        id: name && name !== label ? name : undefined,
        bounds: rect,
        enabled: n.isEnabled === undefined ? true : truthy(n.isEnabled),
        clickable: INTERACTIVE.test(type),
        scrollable: /ScrollView|Table|CollectionView/.test(type),
        checked: isSwitch ? truthy(value) : undefined,
        password: /SecureTextField/.test(type) || undefined,
        depth,
        childCount: children.length,
      });
    }
    for (const c of children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Older WDA builds emit `{{x, y}, {w, h}}` strings instead of a rect object. */
function parseFrame(frame: string | undefined): Rect | null {
  if (!frame) return null;
  const m = /\{\{([-\d.]+),\s*([-\d.]+)\},\s*\{([-\d.]+),\s*([-\d.]+)\}\}/.exec(frame);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

export interface WdaOptions {
  baseUrl: string;
  bundleId?: string;
  timeoutMs?: number;
}

export class WdaClient {
  private sessionId?: string;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private opts: WdaOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw err("device_unreachable", `WebDriverAgent at ${this.base} is not responding`, {
        hint:
          "Start WDA (Xcode: run the WebDriverAgentRunner test target, or `xcodebuild test-without-building`), " +
          "and for a physical device forward the port with `iproxy 8100 8100`.",
        cause: e,
      });
    }
    const text = await res.text();
    let json: { value?: unknown; sessionId?: string } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      /* WDA occasionally returns a bare body */
    }
    if (!res.ok) {
      const v = json.value as { error?: string; message?: string } | undefined;
      throw err("provider_error", `WDA ${method} ${path} → ${res.status}: ${v?.message ?? v?.error ?? text.slice(0, 200)}`);
    }
    return (json.value ?? json) as T;
  }

  async status(): Promise<Record<string, unknown>> {
    return this.req<Record<string, unknown>>("GET", "/status");
  }

  /** Create (or reuse) a WDA session. Attaching without a bundleId targets the foreground app. */
  async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const body = {
      capabilities: {
        alwaysMatch: {
          ...(this.opts.bundleId ? { bundleId: this.opts.bundleId } : {}),
          shouldWaitForQuiescence: false,
        },
        firstMatch: [{}],
      },
    };
    const v = await this.req<{ sessionId?: string }>("POST", "/session", body);
    const id = v.sessionId ?? (v as unknown as { sessionId?: string }).sessionId;
    if (!id) throw err("provider_error", "WDA did not return a sessionId");
    this.sessionId = id;
    return id;
  }

  private async s(path: string): Promise<string> {
    return `/session/${await this.session()}${path}`;
  }

  /** Recover once from "session does not exist" after the app or WDA restarts. */
  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && /session|invalid session id|terminated/i.test(e.message)) {
        this.sessionId = undefined;
        return fn();
      }
      throw e;
    }
  }

  async source(): Promise<WdaSourceNode> {
    return this.withSession(async () =>
      this.req<WdaSourceNode>("GET", `${await this.s("/source")}?format=json`),
    );
  }

  async screenshotBase64(): Promise<string> {
    return this.req<string>("GET", "/screenshot");
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    return this.withSession(async () =>
      this.req<{ width: number; height: number }>("GET", await this.s("/window/size")),
    );
  }

  async tap(x: number, y: number, durationMs = 0): Promise<void> {
    await this.withSession(async () => {
      const path = await this.s("/actions");
      await this.req("POST", path, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x, y },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: Math.max(durationMs, 50) },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    });
  }

  async drag(from: [number, number], to: [number, number], durationMs = 300): Promise<void> {
    await this.withSession(async () => {
      await this.req("POST", await this.s("/wda/dragfromtoforduration"), {
        fromX: from[0],
        fromY: from[1],
        toX: to[0],
        toY: to[1],
        duration: durationMs / 1000,
      });
    });
  }

  async typeText(text: string): Promise<void> {
    await this.withSession(async () => {
      await this.req("POST", await this.s("/wda/keys"), { value: [...text] });
    });
  }

  async pressButton(name: "home" | "volumeUp" | "volumeDown"): Promise<void> {
    await this.withSession(async () => {
      await this.req("POST", await this.s("/wda/pressButton"), { name });
    });
  }

  async openUrl(url: string): Promise<void> {
    await this.withSession(async () => {
      await this.req("POST", await this.s("/url"), { url });
    });
  }

  async launchApp(bundleId: string): Promise<void> {
    await this.withSession(async () => {
      await this.req("POST", await this.s("/wda/apps/launch"), { bundleId });
    });
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.withSession(async () => {
      await this.req("POST", await this.s("/wda/apps/terminate"), { bundleId });
    });
  }

  async activeApp(): Promise<{ bundleId?: string; name?: string; processArguments?: unknown }> {
    return this.withSession(async () =>
      this.req<{ bundleId?: string; name?: string }>("GET", await this.s("/wda/activeAppInfo")),
    );
  }

  /** Dismiss the keyboard / return to home. */
  async home(): Promise<void> {
    await this.req("POST", "/wda/homescreen", {});
  }
}
