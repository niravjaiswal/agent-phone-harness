import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Keep tests out of the real ~/.agent-phone.
const home = mkdtempSync(join(tmpdir(), "agent-phone-test-"));
process.env.PHONE_HOME = home;
// os.tmpdir() reads TMPDIR on every call, so each test's own mkdtemp lands here too.
process.env.TMPDIR = home;
process.env.PHONE_LOG_LEVEL = "silent";
// Virtual-device code creates this directory; keep it out of the real ~/.android.
process.env.ANDROID_AVD_HOME = join(home, "avd");

// Leave nothing behind: every run writes traces and screenshots here.
afterAll(() => rmSync(home, { recursive: true, force: true }));
