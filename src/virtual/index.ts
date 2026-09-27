import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { err } from "../core/errors.js";
import { runCommand, spawnDetached, type Runner } from "../core/exec.js";
import { logger } from "../core/logger.js";
import { paths, ensureDir } from "../core/paths.js";
import { findAdb } from "../providers/android/adb.js";
import { parseDevices } from "../providers/android/adb.js";
import {
  createAvd, deleteAvd, emulatorArgs, findSdk, freeEmulatorPort, INSTALL_HINT,
  installPackages, killEmulator, listAvds, listInstalledPackages, systemImage,
  avdEnv, waitForBoot, type SdkPaths,
} from "./avd.js";

const log = logger("virtual");

export const DEFAULT_AVD = "agent-phone";

export interface UpOptions {
  name?: string;
  /** Android API level. Default 34. */
  api?: number;
  /** `google_apis_playstore` (can install from Play) or `google_apis` (rootable). */
  variant?: string;
  deviceProfile?: string;
  headless?: boolean;
  wipe?: boolean;
  /** Skip the (large) SDK download and fail if pieces are missing. */
  noInstall?: boolean;
  onProgress?: (msg: string) => void;
}

export interface VirtualPhone {
  deviceId: string;
  serial: string;
  avd: string;
  port: number;
  logFile: string;
}

/**
 * One command from "nothing installed" to "an agent has a phone".
 *
 * This is the whole point of the virtual path: no handset, no SIM, no cable —
 * and once it is booted the harness treats it exactly like a physical device,
 * because to adb it *is* one.
 */
export class VirtualPhoneManager {
  constructor(private run: Runner = runCommand) {}

  private say(opts: UpOptions, msg: string) {
    opts.onProgress?.(msg);
    log.info(msg);
  }

  async requirements(): Promise<{ name: string; ok: boolean; detail: string }[]> {
    const sdk = await findSdk(this.run).catch(() => null);
    if (!sdk) {
      return [{ name: "android sdk", ok: false, detail: `not found — ${INSTALL_HINT.split("\n")[0]}` }];
    }
    const installed = await listInstalledPackages(sdk, this.run).catch((): string[] => []);
    const image = systemImage();
    return [
      { name: "android sdk", ok: true, detail: sdk.root },
      {
        name: "emulator",
        ok: existsSync(sdk.emulator),
        detail: existsSync(sdk.emulator) ? sdk.emulator : "missing — `agent-phone up` will install it",
      },
      {
        name: "system image",
        ok: installed.includes(image),
        detail: installed.includes(image) ? image : `${image} not installed — \`agent-phone up\` will fetch it (~1.5 GB)`,
      },
    ];
  }

  /** Create the AVD if needed, boot it, wait until Android is actually usable. */
  async up(opts: UpOptions = {}): Promise<VirtualPhone> {
    const name = opts.name ?? DEFAULT_AVD;
    const sdk = await this.requireSdk();
    const image = systemImage({ ...(opts.api !== undefined ? { api: opts.api } : {}), ...(opts.variant ? { variant: opts.variant } : {}) });

    const installed = await listInstalledPackages(sdk, this.run).catch((): string[] => []);
    const missing = ["platform-tools", "emulator", image].filter((p) => !installed.includes(p));
    if (missing.length) {
      if (opts.noInstall) {
        throw err("tool_missing", `Missing SDK packages: ${missing.join(", ")}`, { hint: INSTALL_HINT });
      }
      this.say(opts, `installing ${missing.join(", ")} — the system image is ~1.5 GB, this takes a few minutes`);
      await installPackages(sdk, missing, this.run);
    }

    const avds = await listAvds(sdk, this.run);
    if (!avds.includes(name)) {
      this.say(opts, `creating virtual device "${name}" (${image})`);
      await createAvd(
        sdk,
        { name, image, ...(opts.deviceProfile ? { deviceProfile: opts.deviceProfile } : {}) },
        this.run,
      );
    }

    const adbPath = await this.requireAdb(sdk);
    const running = await this.runningSerials(adbPath);
    const port = freeEmulatorPort(running);
    const serial = `emulator-${port}`;

    const logDir = ensureDir(join(paths.home, "logs"));
    const logFile = join(logDir, `${name}-${port}.log`);

    this.say(opts, `booting ${serial}${opts.headless === false ? "" : " (headless)"}`);
    const { pid, exited } = spawnDetached(
      sdk.emulator,
      emulatorArgs({
        name,
        port,
        ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
        ...(opts.wipe !== undefined ? { wipe: opts.wipe } : {}),
      }),
      { logFile, env: { ANDROID_SDK_ROOT: sdk.root, ...avdEnv() } },
    );
    log.debug(`emulator pid ${pid}, log ${logFile}`);

    this.say(opts, "waiting for Android to finish booting (first boot is slow)");
    await waitForBoot(adbPath, serial, this.run, { exited, logFile });

    this.say(opts, `ready: android:${serial}`);
    return { deviceId: `android:${serial}`, serial, avd: name, port, logFile };
  }

  /** Shut down running emulators. */
  async down(opts: { serial?: string } = {}): Promise<string[]> {
    const sdk = await findSdk(this.run).catch(() => null);
    const adbPath = await this.requireAdb(sdk);
    const running = (await this.runningSerials(adbPath)).filter((s) => s.startsWith("emulator-"));
    const targets = opts.serial ? running.filter((s) => s === opts.serial || `android:${s}` === opts.serial) : running;
    for (const s of targets) {
      log.info(`stopping ${s}`);
      await killEmulator(adbPath, s, this.run);
    }
    return targets;
  }

  /** Delete the AVD entirely — the virtual phone and all of its state. */
  async destroy(name = DEFAULT_AVD): Promise<void> {
    const sdk = await this.requireSdk();
    await this.down();
    await deleteAvd(sdk, name, this.run);
  }

  async list(): Promise<{ avds: string[]; running: string[] }> {
    const sdk = await findSdk(this.run).catch(() => null);
    const adbPath = await findAdb(this.run).catch(() => null);
    return {
      avds: sdk ? await listAvds(sdk, this.run).catch((): string[] => []) : [],
      running: adbPath ? (await this.runningSerials(adbPath)).filter((s) => s.startsWith("emulator-")) : [],
    };
  }

  private async runningSerials(adbPath: string): Promise<string[]> {
    const r = await this.run(adbPath, ["devices"], { timeoutMs: 15_000, allowFailure: true }).catch(() => null);
    return r ? parseDevices(r.stdout).map((d) => d.serial) : [];
  }

  private async requireSdk(): Promise<SdkPaths> {
    const sdk = await findSdk(this.run);
    if (!sdk) throw err("tool_missing", "Android SDK command-line tools not found", { hint: INSTALL_HINT });
    if (!existsSync(join(sdk.root, "cmdline-tools"))) mkdirSync(join(sdk.root, "cmdline-tools"), { recursive: true });
    return sdk;
  }

  private async requireAdb(sdk: SdkPaths | null): Promise<string> {
    const fromSdk = sdk ? join(sdk.root, "platform-tools", "adb") : null;
    if (fromSdk && existsSync(fromSdk)) return fromSdk;
    const found = await findAdb(this.run);
    if (!found) throw err("tool_missing", "adb not found", { hint: INSTALL_HINT });
    return found;
  }
}

export { systemImage, findSdk, INSTALL_HINT, sendEmulatorSms } from "./avd.js";
