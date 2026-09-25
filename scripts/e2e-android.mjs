// End-to-end check against a real Android device or emulator.
//
// Everything else in the test suite runs against a fake adb. This is the one
// place the parsers meet real `uiautomator`, `dumpsys` and the SMS provider.
// Hard checks fail the run; UI-flow checks that depend on how a particular
// Android build lays out Settings only warn.
//
//   npm run build && node scripts/e2e-android.mjs [android:<serial>]
import { execFileSync } from "node:child_process";
import { Harness } from "../dist/index.js";

let failures = 0;
const log = (...a) => console.log("[e2e]", ...a);
const check = (cond, msg) => {
  if (cond) log("ok  ", msg);
  else {
    failures++;
    console.error("[e2e] FAIL", msg);
  }
};
const soft = (cond, msg) => (cond ? log("ok  ", msg) : console.warn("[e2e] warn", msg));
const attempt = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
};

const harness = new Harness({
  // A throwaway emulator: let the run exercise everything, including Settings.
  ceiling: { mode: "autonomous", blockedApps: [], allowShell: true },
});

const devices = await harness.listDevices();
const wanted = process.argv[2];
const device = devices.find((d) => (wanted ? d.id === wanted : d.platform === "android" && d.state === "available"));
if (!device) {
  console.error(`[e2e] no Android device found; saw: ${devices.map((d) => `${d.id}(${d.state})`).join(", ") || "none"}`);
  process.exit(1);
}
log(`device ${device.id} — ${device.name}`);
const serial = device.id.replace(/^android:/, "");
const session = await harness.createSession({ deviceId: device.id, policy: { mode: "autonomous" } });

// ---- perception
const home = await session.observe();
check(home.elements.length >= 3, `home screen yields an element tree (${home.elements.length} elements, ${home.prunedCount} pruned)`);
check(Boolean(home.screen.app), `foreground app detected (${home.screen.app} / ${home.screen.activity})`);
check(home.screen.width > 0 && home.screen.height > 0, `screen size ${home.screen.width}x${home.screen.height}`);
console.log(session.view(home).elements.split("\n").slice(0, 25).join("\n"));

const idle = await attempt(() => session.device.isIdle?.());
check(!(idle instanceof Error), `transition idle probe answers (${String(idle)})`);

// ---- screenshot, with password redaction path engaged
const shot = await attempt(() => session.screenshot({ marks: true }));
check(!(shot instanceof Error) && shot.data.subarray(0, 4).toString("hex") === "89504e47", `screenshot is a PNG${shot instanceof Error ? `: ${shot.message}` : ` ${shot.width}x${shot.height}`}`);

// ---- apps
const apps = await attempt(() => session.device.listApps());
check(!(apps instanceof Error) && apps.some((a) => a.id === "com.android.settings"), `listApps sees Settings (${apps instanceof Error ? apps.message : apps.length} apps)`);

const opened = await attempt(() => session.openApp("com.android.settings"));
check(!(opened instanceof Error) && opened.screen.app === "com.android.settings", `openApp lands in Settings${opened instanceof Error ? `: ${opened.message}` : ` (${opened.change})`}`);

const scrolled = await attempt(() => session.scroll("down"));
check(!(scrolled instanceof Error), `scroll${scrolled instanceof Error ? `: ${scrolled.message}` : ` (${scrolled.change})`}`);

const tapped = await attempt(() => session.tap({ selector: { textContains: "Apps" } }));
soft(!(tapped instanceof Error), `tap by selector "Apps"${tapped instanceof Error ? `: ${tapped.message}` : ` (${tapped.change})`}`);
await attempt(() => session.pressKey("back"));

const links = await attempt(() => session.deepLinks("com.android.settings"));
check(!(links instanceof Error), `deep-link enumeration runs (${links instanceof Error ? links.message : `${links.length} links`})`);

// ---- text entry through Settings search
await attempt(() => session.openApp("com.android.settings"));
const search = await attempt(() => session.tap({ selector: { textContains: "Search" } }));
if (!(search instanceof Error)) {
  const typed = await attempt(() => session.type("display"));
  soft(!(typed instanceof Error), `type into Settings search${typed instanceof Error ? `: ${typed.message}` : ""}`);
  const found = await attempt(() => session.waitFor({ textContains: "rightness" }, { timeoutMs: 8000 }));
  soft(!(found instanceof Error), `search results appear${found instanceof Error ? `: ${found.message}` : ""}`);
} else {
  soft(false, `find the Settings search bar: ${search.message}`);
}
await attempt(() => session.pressKey("home"));

// ---- SMS: the emulator console injects a message; the harness must read it from the provider
const hasConsole = serial.startsWith("emulator-");
if (hasConsole) {
  execFileSync("adb", ["-s", serial, "emu", "sms", "send", "5551234", "Your E2E verification code is 424242"]);
  const otp = await attempt(() => session.waitForOtp({ timeoutMs: 45_000 }));
  check(!(otp instanceof Error) && otp.code === "424242", `one-time code read back${otp instanceof Error ? `: ${otp.message}` : ` via ${otp.message.origin}`}`);
  const sms = await attempt(() => session.readSms({ limit: 5 }));
  soft(!(sms instanceof Error) && sms.some((m) => m.body.includes("424242")), `SMS provider readable directly${sms instanceof Error ? `: ${sms.message}` : ""}`);
} else {
  log("skip SMS injection (not an emulator)");
}

const notes = await attempt(() => session.readNotifications({ limit: 10 }));
check(!(notes instanceof Error), `notification shade readable (${notes instanceof Error ? notes.message : `${notes.length} items`})`);

// ---- clipboard (Android 10+ restricts background access; failure is informative, not fatal)
const clip = await attempt(() => session.clipboard("set", "agent-phone e2e"));
soft(!(clip instanceof Error), `clipboard write${clip instanceof Error ? `: ${clip.message}` : ""}`);

await harness.closeAll();
if (failures) {
  console.error(`[e2e] ${failures} check(s) failed`);
  process.exit(1);
}
log("all hard checks passed");
