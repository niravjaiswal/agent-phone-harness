import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, which, type ExecResult, type Runner } from "../../core/exec.js";
import { err } from "../../core/errors.js";

/**
 * Locate adb without assuming a particular install method.
 * `exists` is the filesystem probe; tests pass one so the answer does not
 * depend on whether the machine running them happens to have an SDK.
 */
export async function findAdb(
  run: Runner = runCommand,
  exists: (path: string) => boolean = existsSync,
): Promise<string | null> {
  if (process.env.PHONE_ADB && exists(process.env.PHONE_ADB)) return process.env.PHONE_ADB;
  const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  const candidates = [
    sdk ? join(sdk, "platform-tools", "adb") : null,
    join(homedir(), "Library/Android/sdk/platform-tools/adb"),
    join(homedir(), "Android/Sdk/platform-tools/adb"),
    "/usr/local/bin/adb",
    "/opt/homebrew/bin/adb",
  ].filter((x): x is string => Boolean(x));
  for (const c of candidates) if (exists(c)) return c;
  return which("adb", run);
}

export interface AdbDeviceLine {
  serial: string;
  state: string;
  model?: string;
  device?: string;
  transportId?: string;
}

/** `adb devices -l` output → structured rows. */
export function parseDevices(stdout: string): AdbDeviceLine[] {
  const out: AdbDeviceLine[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("List of devices")) continue;
    if (t.startsWith("*")) continue;
    const parts = t.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    const row: AdbDeviceLine = { serial, state };
    for (const kv of parts.slice(2)) {
      const [k, v] = kv.split(":");
      if (!k || !v) continue;
      if (k === "model") row.model = v;
      if (k === "device") row.device = v;
      if (k === "transport_id") row.transportId = v;
    }
    out.push(row);
  }
  return out;
}

/** `wm size` → logical screen size, preferring an override if one is set. */
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
  const m = override ?? physical;
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function parseDensity(stdout: string): number | undefined {
  const m = /Override density:\s*(\d+)/.exec(stdout) ?? /Physical density:\s*(\d+)/.exec(stdout);
  return m ? Number(m[1]) / 160 : undefined;
}

/** Foreground component from `dumpsys window` / `dumpsys activity activities`. */
export function parseCurrentApp(stdout: string): { app?: string; activity?: string } {
  const m =
    /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/.exec(stdout) ??
    /(?:mResumedActivity|topResumedActivity)[^\n]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(stdout) ??
    /ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(stdout);
  if (!m) return {};
  return { app: m[1], activity: m[2] };
}

/** `content query --uri content://sms/inbox` rows. */
export function parseSmsRows(stdout: string): { address: string; body: string; date: number }[] {
  const out: { address: string; body: string; date: number }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("Row:")) continue;
    const fields = new Map<string, string>();
    // Values may contain ", " so split on ", key=" boundaries only.
    const body = line.replace(/^Row:\s*\d+\s*/, "");
    for (const part of body.split(/,\s(?=[a-zA-Z_]+=)/)) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      fields.set(part.slice(0, i).trim(), part.slice(i + 1));
    }
    const address = fields.get("address");
    const text = fields.get("body");
    if (address === undefined && text === undefined) continue;
    out.push({
      address: address ?? "unknown",
      body: text ?? "",
      date: Number(fields.get("date") ?? 0),
    });
  }
  return out;
}

/** `pm list packages -3` / `-f` output. */
export function parsePackages(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package:"))
    .map((l) => {
      const v = l.slice("package:".length);
      const eq = v.lastIndexOf("=");
      return eq >= 0 ? v.slice(eq + 1) : v;
    })
    .filter(Boolean);
}

/**
 * Escape text for the device-side `sh` that `adb shell` invokes.
 *
 * adb concatenates argv and hands it to sh on the device, so quoting has to be
 * correct for *that* shell, not the host's.
 */
export function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

export class Adb {
  constructor(
    readonly serial: string,
    private adbPath: string,
    private run: Runner = runCommand,
  ) {}

  /** Raw adb invocation, scoped to this device. */
  async exec(args: string[], opts: { timeoutMs?: number; allowFailure?: boolean } = {}): Promise<ExecResult> {
    return this.run(this.adbPath, ["-s", this.serial, ...args], {
      timeoutMs: opts.timeoutMs ?? 30_000,
      allowFailure: opts.allowFailure,
    });
  }

  /** Text shell command. */
  async shell(command: string, opts: { timeoutMs?: number; allowFailure?: boolean } = {}): Promise<string> {
    const r = await this.exec(["shell", command], opts);
    return r.stdout;
  }

  /** Binary-safe shell command (screencap, cat of a dump file). */
  async execOut(command: string, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
    const r = await this.exec(["exec-out", command], { timeoutMs: opts.timeoutMs ?? 30_000 });
    return r.stdoutBuffer;
  }

  async assertOnline(): Promise<void> {
    const r = await this.exec(["get-state"], { allowFailure: true, timeoutMs: 8000 });
    const state = r.stdout.trim();
    if (state !== "device") {
      throw err("device_unreachable", `adb device ${this.serial} is "${state || "offline"}"`, {
        hint: "Check the cable/tailnet, unlock the phone, and confirm the USB-debugging prompt.",
      });
    }
  }
}

/**
 * Parse `dumpsys package <pkg>` for externally launchable entry points.
 *
 * Only filters carrying both VIEW and BROWSABLE are usable from outside the
 * app, which is exactly the set an agent can jump to with `openUrl`.
 */
export function parseDeepLinks(dump: string): {
  scheme: string;
  host?: string;
  pathPrefix?: string;
  example: string;
  activity?: string;
}[] {
  interface Filter {
    activity?: string;
    actions: string[];
    categories: string[];
    schemes: string[];
    authorities: string[];
    paths: string[];
  }
  const blank = (activity?: string): Filter => ({
    ...(activity ? { activity } : {}),
    actions: [],
    categories: [],
    schemes: [],
    authorities: [],
    paths: [],
  });

  const out: {
    scheme: string;
    host?: string;
    pathPrefix?: string;
    example: string;
    activity?: string;
  }[] = [];
  const seen = new Set<string>();

  const flush = (f: Filter) => {
    if (!f.actions.some((a) => a.endsWith("action.VIEW"))) return;
    if (!f.categories.some((c) => c.endsWith("category.BROWSABLE"))) return;
    for (const scheme of f.schemes.length ? f.schemes : []) {
      const hosts = f.authorities.length ? f.authorities : [undefined];
      for (const host of hosts) {
        const paths = f.paths.length ? f.paths : [undefined];
        for (const pathPrefix of paths) {
          const example = `${scheme}://${host ?? ""}${pathPrefix ?? ""}`;
          const key = `${example}|${f.activity ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            scheme,
            ...(host ? { host } : {}),
            ...(pathPrefix ? { pathPrefix } : {}),
            example,
            ...(f.activity ? { activity: f.activity } : {}),
          });
        }
      }
    }
  };

  let current = blank();
  let activity: string | undefined;

  for (const raw of dump.split("\n")) {
    const line = raw.trim();

    // "  a1b2c3 com.example/.DeepLinkActivity filter d4e5f6"
    const header = /^\S*\s*([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s+filter\s+\S+/.exec(line);
    if (header) {
      flush(current);
      activity = header[1];
      current = blank(activity);
      continue;
    }
    if (/^filter\s+\S+/.test(line)) {
      flush(current);
      current = blank(activity);
      continue;
    }

    const kv = /^(Action|Category|Scheme|Authority|Path):\s*"?([^"]*)"?/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = (rawValue ?? "").replace(/:\s*-?\d+$/, "").trim();
    if (!value) continue;

    if (key === "Action") current.actions.push(value);
    else if (key === "Category") current.categories.push(value);
    else if (key === "Scheme") current.schemes.push(value);
    else if (key === "Authority") current.authorities.push(value);
    else if (key === "Path") {
      // Path: "PatternMatcher{PREFIX: /order}"
      const m = /(?:PREFIX|LITERAL|GLOB|ADVANCED_GLOB|SIMPLE_GLOB)\s*:\s*([^}]*)/.exec(value);
      const p = (m?.[1] ?? value).trim();
      if (p.startsWith("/")) current.paths.push(p);
    }
  }
  flush(current);
  return out;
}

/**
 * Is the window manager done animating?
 *
 * Purely an optimisation signal: `undefined` means "cannot tell", and callers
 * must fall back to comparing dumps rather than assuming either answer.
 */
export function parseTransitionIdle(dump: string): boolean | undefined {
  const m = /mAppTransitionState=(\w+)/.exec(dump);
  if (!m) return undefined;
  return m[1] === "APP_STATE_IDLE";
}
