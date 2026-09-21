import { unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand, type Runner } from "../../core/exec.js";
import { err } from "../../core/errors.js";

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

interface SimctlListJson {
  devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]>;
}

export function parseSimctlList(json: string): SimDevice[] {
  const parsed = JSON.parse(json) as SimctlListJson;
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false) continue;
      out.push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, " "),
        isAvailable: true,
      });
    }
  }
  return out;
}

/** Thin `xcrun simctl` wrapper — lifecycle only; input comes from WDA. */
export class Simctl {
  constructor(private run: Runner = runCommand) {}

  private async xcrun(args: string[], opts: { timeoutMs?: number; allowFailure?: boolean } = {}) {
    return this.run("xcrun", args, { timeoutMs: opts.timeoutMs ?? 60_000, allowFailure: opts.allowFailure });
  }

  async list(): Promise<SimDevice[]> {
    const r = await this.xcrun(["simctl", "list", "devices", "available", "--json"], { timeoutMs: 30_000 });
    return parseSimctlList(r.stdout);
  }

  async boot(udid: string): Promise<void> {
    const r = await this.xcrun(["simctl", "boot", udid], { allowFailure: true, timeoutMs: 120_000 });
    if (r.code !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/i.test(r.stderr + r.stdout)) {
      throw err("provider_error", `simctl boot failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    await this.xcrun(["simctl", "bootstatus", udid, "-b"], { allowFailure: true, timeoutMs: 180_000 });
  }

  async shutdown(udid: string): Promise<void> {
    await this.xcrun(["simctl", "shutdown", udid], { allowFailure: true });
  }

  async screenshot(udid: string): Promise<Buffer> {
    const p = join(tmpdir(), `agent-phone-${randomUUID()}.png`);
    await this.xcrun(["simctl", "io", udid, "screenshot", "--type=png", p], { timeoutMs: 30_000 });
    try {
      return readFileSync(p);
    } finally {
      try {
        unlinkSync(p);
      } catch {
        /* temp file cleanup is best effort */
      }
    }
  }

  async launch(udid: string, bundleId: string): Promise<void> {
    await this.xcrun(["simctl", "launch", udid, bundleId], { timeoutMs: 60_000 });
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    await this.xcrun(["simctl", "terminate", udid, bundleId], { allowFailure: true });
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.xcrun(["simctl", "openurl", udid, url], { timeoutMs: 30_000 });
  }

  async install(udid: string, appPath: string): Promise<void> {
    await this.xcrun(["simctl", "install", udid, appPath], { timeoutMs: 180_000 });
  }

  async uninstall(udid: string, bundleId: string): Promise<void> {
    await this.xcrun(["simctl", "uninstall", udid, bundleId], { allowFailure: true });
  }

  /** `simctl listapps` emits a plist; plutil turns it into something parseable. */
  async listApps(udid: string): Promise<{ id: string; name?: string; system?: boolean }[]> {
    const r = await this.xcrun(["simctl", "listapps", udid], { timeoutMs: 60_000, allowFailure: true });
    if (r.code !== 0) return [];
    const conv = await this.run("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: r.stdout,
      timeoutMs: 20_000,
      allowFailure: true,
    });
    if (conv.code !== 0) {
      // Fall back to scraping bundle ids out of the raw plist.
      return [...r.stdout.matchAll(/CFBundleIdentifier\s*=\s*"?([A-Za-z0-9_.-]+)"?/g)].map((m) => ({ id: m[1]! }));
    }
    const parsed = JSON.parse(conv.stdout) as Record<string, { CFBundleDisplayName?: string; CFBundleName?: string; ApplicationType?: string }>;
    return Object.entries(parsed).map(([id, v]) => ({
      id,
      name: v.CFBundleDisplayName ?? v.CFBundleName,
      system: v.ApplicationType === "System",
    }));
  }

  /** Simulators have no telephony; this injects a push payload instead. */
  async pushNotification(udid: string, bundleId: string, payloadPath: string): Promise<void> {
    await this.xcrun(["simctl", "push", udid, bundleId, payloadPath], { timeoutMs: 30_000 });
  }
}

export interface PhysicalDevice {
  udid: string;
  name: string;
  osVersion?: string;
  state?: string;
}

/**
 * `xcrun devicectl` (Xcode 15+) covers physical iPhones with no third-party
 * tooling — install and launch only; touch still goes through WDA.
 */
export class DeviceCtl {
  constructor(private run: Runner = runCommand) {}

  async list(): Promise<PhysicalDevice[]> {
    const out = join(tmpdir(), `devicectl-${randomUUID()}.json`);
    const r = await this.run("xcrun", ["devicectl", "list", "devices", "--json-output", out], {
      timeoutMs: 60_000,
      allowFailure: true,
    });
    if (r.code !== 0) return [];
    try {
      const parsed = JSON.parse(readFileSync(out, "utf8")) as {
        result?: { devices?: { identifier?: string; hardwareProperties?: { udid?: string; marketingName?: string }; deviceProperties?: { name?: string; osVersionNumber?: string }; connectionProperties?: { tunnelState?: string } }[] };
      };
      return (parsed.result?.devices ?? []).map((d) => ({
        udid: d.hardwareProperties?.udid ?? d.identifier ?? "unknown",
        name: d.deviceProperties?.name ?? d.hardwareProperties?.marketingName ?? "iPhone",
        osVersion: d.deviceProperties?.osVersionNumber,
        state: d.connectionProperties?.tunnelState,
      }));
    } catch {
      return [];
    } finally {
      try {
        unlinkSync(out);
      } catch {
        /* best effort */
      }
    }
  }

  async launch(udid: string, bundleId: string): Promise<void> {
    await this.run(
      "xcrun",
      ["devicectl", "device", "process", "launch", "--terminate-existing", "--device", udid, bundleId],
      { timeoutMs: 120_000 },
    );
  }

  async install(udid: string, appPath: string): Promise<void> {
    await this.run("xcrun", ["devicectl", "device", "install", "app", "--device", udid, appPath], {
      timeoutMs: 300_000,
    });
  }
}
