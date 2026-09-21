/**
 * Core type vocabulary for the harness.
 *
 * Everything above the provider layer speaks these types only, so an agent that
 * learned to drive an Android emulator drives a real iPhone unchanged.
 */

export type Platform = "android" | "ios" | "mock";

/** How the harness reaches a device. Perception/action semantics are identical regardless. */
export type Transport = "usb" | "tcp" | "simulator" | "emulator" | "cloud" | "memory";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeviceInfo {
  /** Stable harness-wide id, e.g. "android:R5CT30XXXX" or "ios:8DD8FBE2-...". */
  id: string;
  platform: Platform;
  transport: Transport;
  /** Human name, e.g. "Pixel 7" / "iPhone 17 Pro". */
  name: string;
  osVersion?: string;
  /** Logical screen size in the coordinate space taps use. */
  screen?: { width: number; height: number; density?: number };
  state: "available" | "busy" | "offline" | "unauthorized";
  /** Provider-specific extras (serial, udid, booted, etc). */
  meta?: Record<string, unknown>;
}

/** Normalized accessibility element. The single currency of targeting. */
export interface UiElement {
  /** Snapshot-scoped handle, e.g. "e7". Only valid against the snapshot that produced it. */
  ref: string;
  /** Normalized role: Button, TextField, Text, Image, Switch, Checkbox, List, Cell, Tab, Other... */
  role: string;
  text?: string;
  /** accessibility label / content-description. */
  label?: string;
  /** current value (text fields, sliders, switches). */
  value?: string;
  /** resource-id (Android) / identifier (iOS). */
  id?: string;
  bounds: Rect;
  center: [number, number];
  enabled: boolean;
  clickable: boolean;
  scrollable: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  /** true => contents must never be screenshotted or logged in the clear. */
  password?: boolean;
  depth: number;
  /** index among siblings sharing the same role — used for stable selectors. */
  roleIndex: number;
  pkg?: string;
  childCount: number;
}

export interface ScreenContext {
  /** foreground package (android) / bundle id (ios). */
  app?: string;
  /** activity (android) / view controller or window name (ios), best effort. */
  activity?: string;
  orientation?: "portrait" | "landscape";
  width: number;
  height: number;
}

export interface Snapshot {
  snapshotId: string;
  deviceId: string;
  takenAt: number;
  screen: ScreenContext;
  elements: UiElement[];
  /** Pruned element count, for "am I missing something?" reasoning. */
  prunedCount: number;
  truncated: boolean;
  /** Hash of the significant UI state; used for settle detection. */
  hash: string;
  /**
   * The accessibility tree came back essentially empty — a Flutter/canvas/game
   * surface. Element targeting will not work here; the agent needs pixels.
   */
  barren: boolean;
}

/** Re-resolved at action time; survives re-renders in a way refs cannot. */
export interface Selector {
  text?: string;
  textContains?: string;
  label?: string;
  labelContains?: string;
  id?: string;
  idContains?: string;
  role?: string;
  value?: string;
  /** Restrict to enabled/clickable elements. Defaults: clickable=undefined (no filter). */
  clickable?: boolean;
  enabled?: boolean;
  /** Which match to take when several qualify. Default 0. Negative counts from the end. */
  index?: number;
}

export type Target =
  | { ref: string }
  | { selector: Selector }
  | { point: [number, number] };

export type KeyName =
  | "back"
  | "home"
  | "recents"
  | "enter"
  | "delete"
  | "tab"
  | "escape"
  | "volume_up"
  | "volume_down"
  | "power"
  | "search"
  | "menu";

export type Direction = "up" | "down" | "left" | "right";

export interface Message {
  id?: string;
  /** sender address */
  from: string;
  body: string;
  /** epoch ms */
  timestamp: number;
  read?: boolean;
}

export interface NotificationItem {
  pkg: string;
  title?: string;
  text?: string;
  /** epoch ms, best effort */
  timestamp?: number;
}

/** An externally launchable entry point an app declares (Android intent filter). */
export interface DeepLink {
  scheme: string;
  host?: string;
  pathPrefix?: string;
  /** Best-effort URL to hand `openUrl`. May need a real id substituted. */
  example: string;
  activity?: string;
}

export interface AppInfo {
  /** package (android) / bundle id (ios) */
  id: string;
  name?: string;
  version?: string;
  system?: boolean;
}

export interface ScreenshotOptions {
  /** Longest-edge cap in pixels. Default 1000. */
  maxSize?: number;
  /** Black out password-flagged element regions. Default true. */
  redact?: boolean;
  /** Draw numbered boxes for these elements (set-of-marks). */
  marks?: UiElement[];
}

export interface Screenshot {
  /** PNG bytes. */
  data: Buffer;
  width: number;
  height: number;
  /** Scale applied relative to device coordinate space (1 = none). */
  scale: number;
}

/**
 * The provider contract. ~20 methods; implementing it is all a new backend
 * (cloud farm, Redroid container, Corellium) needs to do.
 *
 * Coordinates are always in the device's logical point space (same space
 * `DeviceInfo.screen` and `UiElement.bounds` use).
 */
export interface Device {
  readonly info: DeviceInfo;

  /** Cheap liveness check; throws DeviceError if unreachable. */
  ping(): Promise<void>;
  /** Re-read screen size/orientation etc. */
  refreshInfo(): Promise<DeviceInfo>;

  // --- perception ---
  dumpUi(): Promise<{ elements: UiElement[]; screen: ScreenContext; prunedCount: number }>;
  screenshot(opts?: ScreenshotOptions): Promise<Screenshot>;

  // --- action ---
  tap(x: number, y: number, durationMs?: number): Promise<void>;
  swipe(
    from: [number, number],
    to: [number, number],
    durationMs?: number,
  ): Promise<void>;
  typeText(text: string, opts?: { submit?: boolean }): Promise<void>;
  pressKey(key: KeyName): Promise<void>;
  clearText(): Promise<void>;

  // --- app + system ---
  listApps(): Promise<AppInfo[]>;
  launchApp(appId: string): Promise<void>;
  stopApp(appId: string): Promise<void>;
  clearAppData?(appId: string): Promise<void>;
  installApp?(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  currentApp(): Promise<{ app?: string; activity?: string }>;

  // --- side channels: the reason mobile flows become tractable ---
  readSms?(opts?: { limit?: number; sinceMs?: number }): Promise<Message[]>;
  readNotifications?(opts?: { limit?: number }): Promise<NotificationItem[]>;
  clipboardGet?(): Promise<string>;
  clipboardSet?(text: string): Promise<void>;

  /**
   * Cheap "has the UI stopped animating?" probe.
   *
   * Optional, and deliberately allowed to return undefined: it exists only to
   * let settle detection finish early, never to make it finish wrongly.
   */
  isIdle?(): Promise<boolean | undefined>;

  /**
   * Entry points the app declares. A deep link collapses a whole navigation
   * sequence into one action, so this is usually the cheapest route to a screen.
   */
  listDeepLinks?(appId: string): Promise<DeepLink[]>;

  /** Raw escape hatch (android shell). Policy-gated above. */
  shell?(command: string): Promise<string>;

  /** Release provider-side resources (sessions, ports). */
  dispose(): Promise<void>;
}

export interface DeviceProvider {
  readonly platform: Platform;
  /** Tools this provider needs (adb, xcrun...) — used by `agent-phone doctor`. */
  requirements(): Promise<{ name: string; ok: boolean; detail: string }[]>;
  listDevices(): Promise<DeviceInfo[]>;
  open(deviceId: string): Promise<Device>;
}
