import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { AndroidProvider, AndroidDevice } from "../src/providers/android/index.js";
import { Adb } from "../src/providers/android/adb.js";
import type { ExecResult, Runner } from "../src/core/exec.js";
import type { DeviceInfo } from "../src/core/types.js";

const xml = readFileSync(join(import.meta.dirname, "fixtures", "uiautomator.xml"), "utf8");

const ok = (stdout: string | Buffer): ExecResult => {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  return { code: 0, stdout: buf.toString("utf8"), stderr: "", stdoutBuffer: buf };
};

/**
 * A fake adb.
 *
 * This is the point of threading a Runner through the providers: every command
 * the Android backend builds is asserted here, with no phone in the room.
 */
function fakeAdb(overrides: Record<string, string | Buffer> = {}) {
  const calls: string[][] = [];
  const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));

  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith("which")) return ok("/fake/adb\n");
    const line = args.join(" ");
    for (const [needle, out] of Object.entries(overrides)) {
      if (line.includes(needle)) return ok(out);
    }
    if (line.startsWith("devices")) {
      return ok("List of devices attached\nR5CT30ABCDE\tdevice usb:1 model:SM_A546E transport_id:3\n");
    }
    if (line.includes("get-state")) return ok("device\n");
    if (line.includes("wm size")) return ok("Physical size: 1080x2340\n");
    if (line.includes("wm density")) return ok("Physical density: 420\n");
    if (line.includes("ro.build.version.release")) return ok("15\n");
    if (line.includes("ro.product.model")) return ok("SM_A546E\n");
    if (line.includes("uiautomator dump")) return ok(xml);
    if (line.includes("screencap")) return ok(png);
    if (line.includes("mCurrentFocus")) {
      return ok("  mCurrentFocus=Window{1 u0 com.example.bank/com.example.bank.LoginActivity}\n");
    }
    if (line.includes("pm list packages -3")) return ok("package:com.example.bank\n");
    if (line.includes("pm list packages")) return ok("package:com.example.bank\npackage:com.android.settings\n");
    if (line.includes("resolve-activity")) return ok("  com.example.bank/.LoginActivity\n");
    return ok("");
  };
  return { run, calls, last: () => calls[calls.length - 1]!.join(" ") };
}

function device(run: Runner): AndroidDevice {
  const info: DeviceInfo = {
    id: "android:R5CT30ABCDE",
    platform: "android",
    transport: "usb",
    name: "SM_A546E",
    screen: { width: 1080, height: 2340, density: 2.625 },
    state: "available",
  };
  return new AndroidDevice(new Adb("R5CT30ABCDE", "/fake/adb", run), info);
}

describe("AndroidProvider", () => {
  it("lists devices with transport inferred from the serial", async () => {
    const { run } = fakeAdb({
      devices: "List of devices attached\nR5CT30ABCDE\tdevice model:SM_A546E\n100.1.2.3:5555\tdevice\nemulator-5554\tdevice\n",
    });
    const list = await new AndroidProvider(run).listDevices();
    expect(list.map((d) => d.transport)).toEqual(["usb", "tcp", "emulator"]);
    expect(list[0]!.id).toBe("android:R5CT30ABCDE");
  });

  it("reports adb as missing in doctor output rather than throwing", async () => {
    const run: Runner = async () => ok("");
    // No adb anywhere on disk — CI runners ship an Android SDK, so don't ask the real filesystem.
    const checks = await new AndroidProvider(run, { fileExists: () => false }).requirements();
    expect(checks[0]!.name).toBe("adb");
    expect(checks[0]!.detail).toContain("android-platform-tools");
  });
});

describe("AndroidDevice — perception", () => {
  it("dumps the UI to a file and cats it back, then parses it", async () => {
    const f = fakeAdb();
    const d = device(f.run);
    const { elements, screen } = await d.dumpUi();

    expect(f.calls.some((c) => c.join(" ").includes("uiautomator dump --compressed"))).toBe(true);
    expect(screen).toMatchObject({ app: "com.example.bank", width: 1080, height: 2340, orientation: "portrait" });
    expect(elements.some((e) => e.text === "Sign in")).toBe(true);
  });

  it("retries a dump that comes back without a hierarchy, then gives a useful error", async () => {
    const f = fakeAdb({ "uiautomator dump": "ERROR: could not get idle state." });
    const d = device(f.run);
    await expect(d.dumpUi()).rejects.toThrowError(/no hierarchy/);
    const dumps = f.calls.filter((c) => c.join(" ").includes("uiautomator dump"));
    expect(dumps.length).toBe(3);
  });

  it("rejects a screencap that is not a PNG", async () => {
    const f = fakeAdb({ screencap: "error: something went wrong" });
    await expect(device(f.run).screenshot()).rejects.toThrowError(/did not return a PNG/);
  });
});

describe("AndroidDevice — input", () => {
  it("builds tap, long press and swipe commands", async () => {
    const f = fakeAdb();
    const d = device(f.run);

    await d.tap(100, 200);
    expect(f.last()).toContain("input tap 100 200");

    await d.tap(100, 200, 900);
    expect(f.last()).toContain("input swipe 100 200 100 200 900");

    await d.swipe([10, 20], [30, 40], 250);
    expect(f.last()).toContain("input swipe 10 20 30 40 250");
  });

  it("quotes text for the device shell", async () => {
    const f = fakeAdb();
    await device(f.run).typeText("it's me; rm -rf /");
    expect(f.last()).toContain(`input text 'it'\\''s me; rm -rf /'`);
  });

  it("chunks long text so it is not truncated", async () => {
    const f = fakeAdb();
    await device(f.run).typeText("x".repeat(400));
    const typed = f.calls.filter((c) => c.join(" ").includes("input text"));
    expect(typed.length).toBe(3);
  });

  it("refuses non-ASCII rather than silently typing garbage", async () => {
    const f = fakeAdb();
    await expect(device(f.run).typeText("naïve 日本語")).rejects.toThrowError(/non-ASCII/);
  });

  it("uses the ADBKeyboard broadcast when configured", async () => {
    const f = fakeAdb();
    const info: DeviceInfo = { id: "android:x", platform: "android", transport: "usb", name: "x", state: "available" };
    const d = new AndroidDevice(new Adb("x", "/fake/adb", f.run), info, { useAdbKeyboard: true });
    await d.typeText("naïve 日本語");
    expect(f.last()).toContain("am broadcast -a ADB_INPUT_TEXT --es msg 'naïve 日本語'");
  });

  it("maps key names to Android keycodes", async () => {
    const f = fakeAdb();
    const d = device(f.run);
    await d.pressKey("back");
    expect(f.last()).toContain("KEYCODE_BACK");
    await d.pressKey("recents");
    expect(f.last()).toContain("KEYCODE_APP_SWITCH");
  });
});

describe("AndroidDevice — apps and side channels", () => {
  it("launches via the resolved component when one is available", async () => {
    const f = fakeAdb();
    await device(f.run).launchApp("com.example.bank");
    expect(f.last()).toContain("am start -W -n 'com.example.bank/.LoginActivity'");
  });

  it("falls back to monkey when no activity resolves", async () => {
    const f = fakeAdb({ "resolve-activity": "" });
    await device(f.run).launchApp("com.example.bank");
    expect(f.last()).toContain("monkey -p 'com.example.bank'");
  });

  it("marks packages missing from the third-party list as system apps", async () => {
    const apps = await device(fakeAdb().run).listApps();
    expect(apps.find((a) => a.id === "com.example.bank")!.system).toBe(false);
    expect(apps.find((a) => a.id === "com.android.settings")!.system).toBe(true);
  });

  it("explains how to grant SMS access instead of failing opaquely", async () => {
    const f = fakeAdb({ "content://sms": "Error: java.lang.SecurityException: Permission Denial" });
    const e = await device(f.run).readSms().catch((x) => x);
    expect(e.code).toBe("unsupported");
    expect(e.hint).toContain("pm grant com.android.shell android.permission.READ_SMS");
  });

  it("reads SMS newest-first and honours a since filter", async () => {
    const f = fakeAdb({
      "content://sms":
        "Row: 0 address=Bank, body=code 111111, date=2000\nRow: 1 address=Bank, body=code 222222, date=1000\n",
    });
    const msgs = await device(f.run).readSms({ sinceMs: 1500 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("111111");
  });

  it("opens deep links through the VIEW intent", async () => {
    const f = fakeAdb();
    await device(f.run).openUrl("mybank://transfer?to=ada");
    expect(f.last()).toContain("am start -a android.intent.action.VIEW -d 'mybank://transfer?to=ada'");
  });
});
