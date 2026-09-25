import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emulatorArgs, freeEmulatorPort, systemImage, waitForBoot,
} from "../src/virtual/avd.js";
import { VirtualPhoneManager } from "../src/virtual/index.js";
import type { ExecResult, Runner } from "../src/core/exec.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", stdoutBuffer: Buffer.from(stdout) });

describe("system image selection", () => {
  it("picks an architecture-matched image", () => {
    expect(systemImage({ arch: "arm64-v8a" })).toBe("system-images;android-34;google_apis_playstore;arm64-v8a");
    expect(systemImage({ arch: "x86_64", api: 33 })).toBe("system-images;android-33;google_apis_playstore;x86_64");
    expect(systemImage({ arch: "arm64-v8a", variant: "google_apis" })).toBe(
      "system-images;android-34;google_apis;arm64-v8a",
    );
  });
});

describe("emulator launch", () => {
  it("runs headless by default — this is a server, not a desktop", () => {
    const args = emulatorArgs({ name: "agent-phone", port: 5554 });
    expect(args).toContain("-no-window");
    expect(args).toContain("-no-audio");
    expect(args.join(" ")).toContain("-port 5554");
  });

  it("shows a window when asked", () => {
    expect(emulatorArgs({ name: "x", port: 5554, headless: false })).not.toContain("-no-window");
  });

  it("wipes only on request", () => {
    expect(emulatorArgs({ name: "x", port: 5554 })).not.toContain("-wipe-data");
    expect(emulatorArgs({ name: "x", port: 5554, wipe: true })).toContain("-wipe-data");
  });
});

describe("port allocation", () => {
  it("takes the first free even port", () => {
    expect(freeEmulatorPort([])).toBe(5554);
    expect(freeEmulatorPort(["emulator-5554"])).toBe(5556);
    expect(freeEmulatorPort(["emulator-5554", "emulator-5556"])).toBe(5558);
  });

  it("ignores physical serials", () => {
    expect(freeEmulatorPort(["R5CT30ABCDE", "100.1.2.3:5555"])).toBe(5554);
  });

  it("errors when the whole range is taken", () => {
    const all = Array.from({ length: 16 }, (_, i) => `emulator-${5554 + i * 2}`);
    expect(() => freeEmulatorPort(all)).toThrowError(/No free emulator port/);
  });
});

describe("boot detection", () => {
  it("waits for the package manager, not just sys.boot_completed", async () => {
    const calls: string[] = [];
    let step = 0;
    const run: Runner = async (_cmd, args) => {
      calls.push(args.join(" "));
      if (args.includes("sys.boot_completed")) return ok(step++ > 0 ? "1\n" : "\n");
      if (args.includes("pm")) return ok(step > 2 ? "package:/system/framework/framework-res.apk\n" : "\n");
      return ok();
    };
    await waitForBoot("/fake/adb", "emulator-5554", run, { timeoutMs: 8000, intervalMs: 10 });
    expect(calls.some((c) => c.includes("sys.boot_completed"))).toBe(true);
    expect(calls.some((c) => c.includes("pm path android"))).toBe(true);
  });

  it("times out with an actionable message", async () => {
    const run: Runner = async () => ok("\n");
    await expect(
      waitForBoot("/fake/adb", "emulator-5554", run, { timeoutMs: 120, intervalMs: 10 }),
    ).rejects.toThrowError(/did not finish booting/);
  });
});

/**
 * A real-on-disk SDK tree with fake executables, driven by a fake Runner.
 *
 * The layout has to be real because `findSdk` probes the filesystem — that path
 * resolution is exactly what breaks across Homebrew / Android Studio / manual
 * installs, so it deserves to be exercised rather than stubbed.
 */
function fakeSdkTree(): string {
  const root = mkdtempSync(join(tmpdir(), "fake-sdk-"));
  const binDir = join(root, "cmdline-tools", "latest", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "sdkmanager"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(binDir, "avdmanager"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(root, "emulator"), { recursive: true });
  writeFileSync(join(root, "emulator", "emulator"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(root, "platform-tools"), { recursive: true });
  writeFileSync(join(root, "platform-tools", "adb"), "#!/bin/sh\n", { mode: 0o755 });
  process.env.ANDROID_SDK_ROOT = root;
  return root;
}

const savedSdkRoot = process.env.ANDROID_SDK_ROOT;
afterEach(() => {
  if (savedSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = savedSdkRoot;
});

function fakeSdk(opts: { installed?: string[]; avds?: string[] } = {}) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith("which")) return ok("/fake/sdk/cmdline-tools/latest/bin/sdkmanager\n");
    if (cmd.endsWith("sdkmanager") && args.includes("--list_installed")) {
      return ok((opts.installed ?? []).map((p) => `  ${p} | 1 | x`).join("\n"));
    }
    if (cmd.endsWith("avdmanager") && args.join(" ").includes("list avd")) {
      return ok((opts.avds ?? []).join("\n"));
    }
    if (cmd.endsWith("adb") && args[0] === "devices") return ok("List of devices attached\n");
    if (args.includes("sys.boot_completed")) return ok("1\n");
    if (args.includes("pm")) return ok("package:/system/framework/framework-res.apk\n");
    return ok();
  };
  return { run, calls, find: (needle: string) => calls.find((c) => c.join(" ").includes(needle)) };
}

describe("VirtualPhoneManager.up", () => {
  it("reports missing SDK with an install recipe rather than a bare failure", async () => {
    delete process.env.ANDROID_SDK_ROOT;
    delete process.env.ANDROID_HOME;
    const run: Runner = async () => ok("");
    const e = await new VirtualPhoneManager(run).up().catch((x) => x);
    expect(e.code).toBe("tool_missing");
    expect(e.hint).toContain("brew install --cask android-commandlinetools");
    expect(e.hint).toContain("docs/hosting.md");
  });

  it("surfaces the download cost in doctor output before anything is fetched", async () => {
    fakeSdkTree();
    const { run } = fakeSdk();
    const checks = await new VirtualPhoneManager(run).requirements();
    const image = checks.find((c) => c.name === "system image")!;
    expect(image.ok).toBe(false);
    expect(image.detail).toContain("1.5 GB");
  });

  it("refuses to download when --no-install is set", async () => {
    fakeSdkTree();
    const { run } = fakeSdk();
    const e = await new VirtualPhoneManager(run).up({ noInstall: true }).catch((x) => x);
    expect(e.code).toBe("tool_missing");
    expect(e.message).toContain("system-images;android-34");
  });

  it("creates the AVD, then boots it headless on a free port", async () => {
    fakeSdkTree();
    const image = systemImage();
    const { run, find, calls } = fakeSdk({ installed: ["platform-tools", "emulator", image] });

    const phone = await new VirtualPhoneManager(run).up({ name: "agent-phone" });

    const create = find("create avd")!;
    expect(create.join(" ")).toContain("--name agent-phone");
    expect(create.join(" ")).toContain(`--package ${image}`);

    expect(phone.deviceId).toBe("android:emulator-5554");
    expect(phone.serial).toBe("emulator-5554");
    // Nothing was downloaded: everything needed was already installed.
    expect(calls.some((c) => c.join(" ").includes("--licenses"))).toBe(false);
  });

  it("skips creation when the virtual device already exists", async () => {
    fakeSdkTree();
    const image = systemImage();
    const { run, find } = fakeSdk({ installed: ["platform-tools", "emulator", image], avds: ["agent-phone"] });
    await new VirtualPhoneManager(run).up({ name: "agent-phone" });
    expect(find("create avd")).toBeUndefined();
  });
});
