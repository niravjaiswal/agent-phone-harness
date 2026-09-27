import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { err } from "../core/errors.js";
import { runCommand, sleep, which, type Runner } from "../core/exec.js";

/**
 * Android SDK plumbing for creating virtual phones.
 *
 * The harness drives an emulator through exactly the same adb path as a
 * physical handset — nothing downstream knows the difference. All this module
 * does is *manufacture* the device so the user never has to learn
 * sdkmanager/avdmanager.
 */

export interface SdkPaths {
  root: string;
  sdkmanager: string;
  avdmanager: string;
  emulator: string;
}

/**
 * Where virtual devices live. avdmanager and the emulator must be told the
 * same place: left to their own defaults they can disagree (GitHub's runners
 * are one example), and the emulator then cannot find the device avdmanager
 * just created — "Unknown AVD name".
 */
export function avdHome(): string {
  return process.env.ANDROID_AVD_HOME || join(homedir(), ".android", "avd");
}

/** Environment for every avdmanager and emulator invocation. */
export function avdEnv(): Record<string, string> {
  const home = avdHome();
  mkdirSync(home, { recursive: true });
  return { ANDROID_AVD_HOME: home };
}

/** Read at call time, not import time — env can legitimately change after load. */
const candidateRoots = (): string[] =>
  [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
    "/opt/homebrew/share/android-commandlinetools",
    "/usr/local/share/android-commandlinetools",
    "/opt/android-sdk",
  ].filter((r): r is string => Boolean(r));

const bin = (root: string, name: string): string[] => [
  join(root, "cmdline-tools", "latest", "bin", name),
  join(root, "cmdline-tools", "bin", name),
  join(root, "tools", "bin", name),
  join(root, name === "emulator" ? "emulator" : "bin", name),
];

/**
 * Locate the SDK.
 *
 * Deliberately forgiving: Homebrew, Android Studio and a manual unzip all lay
 * the tree out differently, and telling a user "set ANDROID_HOME" is exactly
 * the friction this command exists to remove.
 */
export async function findSdk(run: Runner = runCommand): Promise<SdkPaths | null> {
  const roots = candidateRoots();

  // A brew-linked `sdkmanager` on PATH reveals the root by walking up from it.
  const onPath = await which("sdkmanager", run);
  if (onPath) {
    const parts = onPath.split("/cmdline-tools/");
    if (parts[0]) roots.unshift(parts[0]);
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const sdkmanager = bin(root, "sdkmanager").find((p) => existsSync(p));
    const avdmanager = bin(root, "avdmanager").find((p) => existsSync(p));
    const emulator = [join(root, "emulator", "emulator"), join(root, "tools", "emulator")].find((p) => existsSync(p));
    if (sdkmanager && avdmanager) {
      return { root, sdkmanager, avdmanager, emulator: emulator ?? join(root, "emulator", "emulator") };
    }
  }
  return null;
}

export const INSTALL_HINT =
  "Install the Android command-line tools, then re-run:\n" +
  "  macOS:  brew install --cask android-commandlinetools\n" +
  "  Linux:  sdk=$HOME/Android/Sdk; mkdir -p $sdk/cmdline-tools && \\\n" +
  "          curl -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \\\n" +
  "          unzip -q /tmp/clt.zip -d $sdk/cmdline-tools && mv $sdk/cmdline-tools/cmdline-tools $sdk/cmdline-tools/latest\n" +
  "Or run the container stack on a Linux host — no SDK needed: see docs/hosting.md";

/** ARM hosts must use an ARM image; an x86 image under emulation is unusably slow. */
export function systemImage(opts: { api?: number; variant?: string; arch?: string } = {}): string {
  const api = opts.api ?? 34;
  const variant = opts.variant ?? "google_apis_playstore";
  const arch = opts.arch ?? (process.arch === "arm64" ? "arm64-v8a" : "x86_64");
  return `system-images;android-${api};${variant};${arch}`;
}

export async function listAvds(sdk: SdkPaths, run: Runner = runCommand): Promise<string[]> {
  const r = await run(sdk.avdmanager, ["list", "avd", "-c"], { timeoutMs: 60_000, allowFailure: true, env: avdEnv() });
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes(" "));
}

export async function listInstalledPackages(sdk: SdkPaths, run: Runner = runCommand): Promise<string[]> {
  const r = await run(sdk.sdkmanager, ["--list_installed"], { timeoutMs: 120_000, allowFailure: true });
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s*\|\s*/)[0]?.trim() ?? "")
    .filter((l) => l.includes(";") || l === "emulator" || l === "platform-tools");
}

/**
 * Install SDK packages, accepting licences non-interactively.
 *
 * sdkmanager prompts per licence on stdin; feeding it a stream of "y" is the
 * only non-interactive path it supports.
 */
export async function installPackages(
  sdk: SdkPaths,
  packages: string[],
  run: Runner = runCommand,
): Promise<void> {
  if (!packages.length) return;
  await run(sdk.sdkmanager, ["--licenses"], {
    input: "y\n".repeat(64),
    timeoutMs: 300_000,
    allowFailure: true,
  });
  await run(sdk.sdkmanager, packages, {
    input: "y\n".repeat(64),
    timeoutMs: 2_400_000,
  });
}

export async function createAvd(
  sdk: SdkPaths,
  opts: { name: string; image: string; deviceProfile?: string; sdcardMb?: number },
  run: Runner = runCommand,
): Promise<void> {
  await run(
    sdk.avdmanager,
    [
      "create", "avd",
      "--name", opts.name,
      "--package", opts.image,
      "--device", opts.deviceProfile ?? "pixel_6",
      "--sdcard", `${opts.sdcardMb ?? 2048}M`,
      "--force",
    ],
    { input: "no\n", timeoutMs: 300_000, env: avdEnv() },
  );
}

export async function deleteAvd(sdk: SdkPaths, name: string, run: Runner = runCommand): Promise<void> {
  await run(sdk.avdmanager, ["delete", "avd", "--name", name], { timeoutMs: 60_000, allowFailure: true, env: avdEnv() });
}

/** Emulator consoles bind even ports from 5554; find one nothing is using. */
export function freeEmulatorPort(takenSerials: string[], start = 5554): number {
  const taken = new Set(
    takenSerials
      .map((s) => /^emulator-(\d+)$/.exec(s)?.[1])
      .filter((p): p is string => Boolean(p))
      .map(Number),
  );
  for (let port = start; port <= 5584; port += 2) {
    if (!taken.has(port)) return port;
  }
  throw err("provider_error", "No free emulator port between 5554 and 5584", {
    hint: "Shut down an existing emulator with `agent-phone down`.",
  });
}

export interface BootOptions {
  name: string;
  port: number;
  /** Run without a visible window. Default true — this is a server, not a desktop. */
  headless?: boolean;
  /** Wipe to a clean state on boot. */
  wipe?: boolean;
  logFile?: string;
}

export function emulatorArgs(opts: BootOptions): string[] {
  const args = [
    "-avd", opts.name,
    "-port", String(opts.port),
    "-no-audio",
    "-no-boot-anim",
    "-no-snapshot-save",
  ];
  if (opts.headless !== false) {
    args.push("-no-window", "-gpu", "swiftshader_indirect");
  }
  if (opts.wipe) args.push("-wipe-data");
  return args;
}

/** The last lines of a log file, or "" if it cannot be read. */
function tailOf(path: string, lines = 40): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Poll until Android is actually usable.
 *
 * `sys.boot_completed` flips before the package manager is ready, so a tap sent
 * at that moment lands nowhere. Both checks must pass.
 */
export async function waitForBoot(
  adbPath: string,
  serial: string,
  run: Runner = runCommand,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    /** True once the emulator process has exited; the wait stops at once. */
    exited?: () => boolean;
    /** The emulator's log, quoted in the error so the cause is visible. */
    logFile?: string;
  } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  const logTail = () => {
    const t = opts.logFile ? tailOf(opts.logFile) : "";
    return t ? `\n--- last lines of ${opts.logFile} ---\n${t}` : "";
  };
  for (;;) {
    const booted = await run(adbPath, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
      timeoutMs: 10_000,
      allowFailure: true,
    }).catch(() => null);

    if (booted?.stdout.trim() === "1") {
      const pm = await run(adbPath, ["-s", serial, "shell", "pm", "path", "android"], {
        timeoutMs: 10_000,
        allowFailure: true,
      }).catch(() => null);
      if (pm?.stdout.includes("package:")) return;
    }

    // Checked after the boot probe, so a launcher that hands off to a child
    // process and exits is never mistaken for a crash.
    if (opts.exited?.()) {
      throw err("provider_error", `The emulator for ${serial} exited before Android finished booting${logTail()}`, {
        hint: "The emulator log above says why. Common causes: no hardware acceleration (/dev/kvm), not enough memory, or a broken virtual device (`agent-phone destroy`, then `agent-phone up`).",
      });
    }
    if (Date.now() > deadline) {
      throw err("timeout", `${serial} did not finish booting in time${logTail()}`, {
        hint: "First boot of a fresh image is slow. Retry; if it keeps failing, the emulator log above says why.",
      });
    }
    await sleep(opts.intervalMs ?? 3000);
  }
}

export async function killEmulator(adbPath: string, serial: string, run: Runner = runCommand): Promise<void> {
  await run(adbPath, ["-s", serial, "emu", "kill"], { timeoutMs: 20_000, allowFailure: true }).catch(() => {});
}

/**
 * Inject an SMS into a running emulator.
 *
 * A virtual phone has no SIM, so this is how an OTP flow is exercised without a
 * carrier. For codes from a *real* sender you need a real number — see
 * docs/telephony.md.
 */
export async function sendEmulatorSms(
  adbPath: string,
  serial: string,
  from: string,
  body: string,
  run: Runner = runCommand,
): Promise<void> {
  await run(adbPath, ["-s", serial, "emu", "sms", "send", from, body], { timeoutMs: 20_000 });
}
