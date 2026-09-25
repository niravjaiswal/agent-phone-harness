import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCurrentApp, parseDensity, parseDevices, parsePackages,
  parseSmsRows, parseWmSize, shQuote,
} from "../src/providers/android/adb.js";
import { parseNotifications } from "../src/providers/android/index.js";
import { parseBounds, parseUiAutomatorXml, roleFromClass } from "../src/providers/android/uiautomator.js";
import { parseWdaSource, roleFromType, type WdaSourceNode } from "../src/providers/ios/wda.js";
import { parseSimctlList } from "../src/providers/ios/simctl.js";
import { pruneElements, finalizeElements } from "../src/core/elements.js";

const fixture = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", n), "utf8");

describe("adb output parsing", () => {
  it("parses `adb devices -l`", () => {
    const rows = parseDevices(
      `List of devices attached\n` +
        `R5CT30ABCDE            device usb:338690048X product:a54x model:SM_A546E device:a54x transport_id:3\n` +
        `emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n` +
        `100.83.1.4:5555        offline\n` +
        `ZY223LLKKK             unauthorized\n`,
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ serial: "R5CT30ABCDE", state: "device", model: "SM_A546E" });
    expect(rows[2]).toMatchObject({ serial: "100.83.1.4:5555", state: "offline" });
    expect(rows[3]!.state).toBe("unauthorized");
  });

  it("prefers an override screen size over the physical one", () => {
    expect(parseWmSize("Physical size: 1440x3120\nOverride size: 1080x2340")).toEqual({ width: 1080, height: 2340 });
    expect(parseWmSize("Physical size: 1080x2340")).toEqual({ width: 1080, height: 2340 });
    expect(parseWmSize("nothing here")).toBeNull();
    expect(parseDensity("Physical density: 420")).toBeCloseTo(2.625);
  });

  it("finds the foreground component in several dumpsys shapes", () => {
    expect(parseCurrentApp("  mCurrentFocus=Window{a1b2c3 u0 com.example.bank/com.example.bank.LoginActivity}")).toEqual({
      app: "com.example.bank",
      activity: "com.example.bank.LoginActivity",
    });
    expect(parseCurrentApp("  topResumedActivity=ActivityRecord{ff u0 com.foo/.MainActivity t42}").app).toBe("com.foo");
    expect(parseCurrentApp("nothing")).toEqual({});
  });

  it("parses SMS rows including bodies containing commas", () => {
    const rows = parseSmsRows(
      `Row: 0 address=+15550001111, body=Your code is 493021, do not share it, date=1737412345678\n` +
        `Row: 1 address=Bank, body=Hi, Ada, date=1737412300000\n`,
    );
    expect(rows[0]).toEqual({ address: "+15550001111", body: "Your code is 493021, do not share it", date: 1737412345678 });
    expect(rows[1]!.body).toBe("Hi, Ada");
  });

  it("parses package lists in both plain and -f form", () => {
    expect(parsePackages("package:com.a\npackage:/data/app/x.apk=com.b\n")).toEqual(["com.a", "com.b"]);
  });

  it("parses notification dumps", () => {
    const items = parseNotifications(
      `NotificationRecord(0x1: pkg=com.google.android.apps.messaging userId=0\n` +
        `  extras={\n    android.title=String (Demo Bank)\n    android.text=String (Your code is 998877)\n  }\n` +
        `  when=1737412345678\n` +
        `NotificationRecord(0x2: pkg=com.other userId=0\n  extras={\n    android.title=Nothing\n  }\n`,
    );
    expect(items[0]).toMatchObject({ pkg: "com.google.android.apps.messaging", title: "Demo Bank" });
    expect(items[0]!.text).toContain("998877");
    expect(items[1]!.pkg).toBe("com.other");
  });

  it("quotes text safely for the device shell", () => {
    expect(shQuote("hello world")).toBe("'hello world'");
    expect(shQuote("it's $HOME; rm -rf /")).toBe(`'it'\\''s $HOME; rm -rf /'`);
  });
});

describe("uiautomator XML", () => {
  it("parses bounds", () => {
    expect(parseBounds("[48,400][1032,540]")).toEqual({ x: 48, y: 400, width: 984, height: 140 });
    expect(parseBounds("garbage")).toBeNull();
  });

  it("maps Android classes onto normalized roles", () => {
    expect(roleFromClass("android.widget.EditText")).toBe("TextField");
    expect(roleFromClass("androidx.recyclerview.widget.RecyclerView")).toBe("List");
    expect(roleFromClass("android.widget.Switch")).toBe("Switch");
    expect(roleFromClass("android.widget.TextView")).toBe("Text");
  });

  it("extracts a usable screen from a real dump", () => {
    const parsed = parseUiAutomatorXml(fixture("uiautomator.xml"));
    expect(parsed.pkg).toBe("com.example.bank");

    const els = finalizeElements(parsed.elements);
    const { kept } = pruneElements(els, { width: 1080, height: 2340 });
    const byText = (t: string) => kept.find((e) => e.text === t || e.label === t);

    expect(byText("Sign in")).toMatchObject({ role: "Button", clickable: true, enabled: true });
    expect(byText("Password")).toMatchObject({ role: "TextField", password: true });
    expect(byText("Email address")).toMatchObject({ role: "TextField", focused: true, value: "ada@example.com" });
    expect(byText("Remember this device")).toMatchObject({ role: "Switch", checked: true });
    expect(byText("Disabled action")!.enabled).toBe(false);
    // The scrollable list survives pruning even with no text of its own.
    expect(kept.some((e) => e.scrollable)).toBe(true);
    // The zero-area ImageView and the bare layout containers do not.
    expect(kept.every((e) => e.bounds.width > 0)).toBe(true);
    expect(kept.length).toBeLessThan(els.length);
  });
});

describe("WebDriverAgent source", () => {
  it("maps XCUIElement types onto the same roles as Android", () => {
    expect(roleFromType("XCUIElementTypeButton")).toBe("Button");
    expect(roleFromType("XCUIElementTypeSecureTextField")).toBe("SecureTextField");
    expect(roleFromType("XCUIElementTypeCollectionView")).toBe("List");
  });

  it("parses a source tree into elements", () => {
    const els = finalizeElements(parseWdaSource(JSON.parse(fixture("wda-source.json")) as WdaSourceNode));
    const byLabel = (l: string) => els.find((e) => e.label === l);

    expect(byLabel("Sign in")).toMatchObject({ role: "Button", clickable: true, text: "Sign in" });
    expect(byLabel("Password")).toMatchObject({ role: "SecureTextField", password: true });
    expect(byLabel("Email address")).toMatchObject({ role: "TextField", value: "ada@example.com" });
    expect(byLabel("Remember this device")).toMatchObject({ role: "Switch", checked: true });
    expect(byLabel("Later")!.enabled).toBe(false);
    expect(byLabel("Sign in")!.center).toEqual([197, 344]);
  });

  it("understands legacy frame strings", () => {
    const els = parseWdaSource({
      type: "XCUIElementTypeButton",
      frame: "{{16, 320}, {361, 48}}",
      label: "Legacy",
      children: [],
    });
    expect(els[0]!.bounds).toEqual({ x: 16, y: 320, width: 361, height: 48 });
  });
});

describe("simctl list", () => {
  it("flattens iOS runtimes and skips unavailable devices and non-phones", () => {
    const list = parseSimctlList(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
            { udid: "AAA", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
            { udid: "BBB", name: "Old", state: "Shutdown", isAvailable: false },
          ],
          "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
            { udid: "WWW", name: "Apple Watch", state: "Shutdown", isAvailable: true },
          ],
        },
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ udid: "AAA", state: "Booted", runtime: "iOS 26 1" });
  });
});
