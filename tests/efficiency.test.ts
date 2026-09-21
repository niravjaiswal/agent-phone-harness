import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/core/approvals.js";
import { HarnessError } from "../src/core/errors.js";
import { SecretStore } from "../src/core/secrets.js";
import { Session } from "../src/core/session.js";
import { MockDevice } from "../src/providers/mock/index.js";
import { parseDeepLinks, parseTransitionIdle } from "../src/providers/android/adb.js";
import type { PolicyConfig } from "../src/core/policy.js";
import type { ScreenContext, UiElement } from "../src/core/types.js";

const BANK = "com.example.demobank";

/** Counts dumps so the settle-profile work is measured, not assumed. */
class CountingDevice extends MockDevice {
  dumps = 0;
  idleAnswer: boolean | undefined = undefined;
  override async dumpUi() {
    this.dumps++;
    return super.dumpUi();
  }
  override async isIdle(): Promise<boolean | undefined> {
    return this.idleAnswer;
  }
}

function newSession(policy: Partial<PolicyConfig> = {}, opts: { renderMode?: "auto" | "full" } = {}) {
  process.env.PHONE_SECRET_TEST_PASSWORD = "s3cr3t-value-xyz";
  const device = new CountingDevice(`mock:${Math.random().toString(36).slice(2)}`);
  const session = new Session(device, {
    policy: { allowedApps: [BANK, "com.mock.launcher", "com.mock.messages"], ...policy },
    secretStore: new SecretStore("/nonexistent.json"),
    approvalStore: new ApprovalStore(mkdtempSync(join(tmpdir(), "approvals-"))),
    approvalWaitMs: 300,
    ...(opts.renderMode ? { renderMode: opts.renderMode } : {}),
  });
  return { device, session };
}

describe("settle profiles", () => {
  it("spends a single dump on typing, which cannot start an animation", async () => {
    const { session, device } = newSession();
    await session.openApp(BANK);

    device.dumps = 0;
    await session.type("ada", { target: { selector: { label: "Username" } } });
    // Resolve reuses the settled snapshot the previous action left behind, and
    // text entry needs no stability loop, so one dump reads the result.
    expect(device.dumps).toBe(1);
    await session.close();
  });

  it("still runs a stability check on a tap, which can navigate", async () => {
    const { session, device } = newSession();
    await session.openApp(BANK);

    device.dumps = 0;
    await session.tap({ selector: { text: "Forgot password?" } });
    const tapDumps = device.dumps;

    device.dumps = 0;
    await session.type("ada", { target: { selector: { label: "Username" } } });
    const typeDumps = device.dumps;

    expect(tapDumps).toBeGreaterThanOrEqual(2);
    expect(typeDumps).toBeLessThan(tapDumps);
    await session.close();
  });

  it("re-dumps rather than trusting a snapshot the device may have outrun", async () => {
    const { session, device } = newSession();
    await session.openApp(BANK);

    // Something changed the screen behind the harness's back.
    await device.launchApp("com.mock.launcher");
    device.dumps = 0;

    // Reuse is keyed on "nothing has touched the device since", and a direct
    // device call is invisible to the session, so this is the dangerous case:
    // it must still resolve against what is actually on screen.
    const r = await session.tap({ selector: { text: "Demo Bank" } });
    expect(device.dumps).toBeGreaterThanOrEqual(1);
    expect(r.ok).toBe(true);
    await session.close();
  });

  it("lets a provider's idle probe end the wait a dump early", async () => {
    const { session, device } = newSession();
    await session.openApp(BANK);

    device.idleAnswer = undefined;
    device.dumps = 0;
    await session.tap({ selector: { text: "Forgot password?" } });
    const withoutProbe = device.dumps;

    device.idleAnswer = true;
    device.dumps = 0;
    await session.tap({ selector: { text: "Forgot password?" } });
    const withProbe = device.dumps;

    expect(withProbe).toBeLessThan(withoutProbe);
    await session.close();
  });

  it("never lets a probe claiming idle skip reading the screen", async () => {
    const { session, device } = newSession();
    device.idleAnswer = true;
    const r = await session.openApp(BANK);
    expect(r.screen.elements).toContain("Sign in");
    await session.close();
  });
});

describe("adaptive rendering", () => {
  it("does not repeat a tree the agent already has", async () => {
    const { session } = newSession();
    await session.openApp(BANK);
    // Tapping a label that changes nothing leaves the screen byte-identical.
    const r = await session.tap({ selector: { text: "Forgot password?" } });
    expect(r.screen.mode).toBe("unchanged");
    expect(r.screen.elements).not.toContain("TextField");
    expect(r.screen.elements).toContain("unchanged");
    await session.close();
  });

  it("sends the full tree when navigation happens", async () => {
    const { session } = newSession();
    const r = await session.openApp(BANK);
    expect(r.screen.mode).toBe("full");
    expect(r.screen.elements).toContain("Sign in");
    await session.close();
  });

  it("sends only what changed for a small in-place update", async () => {
    const { session, device } = newSession();
    await session.openApp(BANK);
    await session.type("ada", { target: { selector: { label: "Username" } } });
    await session.typeSecret("test_password", { target: { selector: { label: "Password" } } });
    await session.tap({ selector: { text: "Sign in" } });

    // Wrong code: the OTP screen gains a single error line and nothing else.
    device.expectedOtp = "111111";
    await session.type("999999", { target: { selector: { label: "Verification code" } } });
    const r = await session.tap({ selector: { text: "Verify" } });

    expect(r.screen.mode).toBe("partial");
    expect(r.screen.elements).toContain("Incorrect code");
    expect(r.screen.elements).not.toContain("Verification code");
    await session.close();
  });

  it("honours renderMode: full for agents that want everything every time", async () => {
    const { session } = newSession({}, { renderMode: "full" });
    await session.openApp(BANK);
    const r = await session.tap({ selector: { text: "Forgot password?" } });
    expect(r.screen.mode).toBe("full");
    expect(r.screen.elements).toContain("Sign in");
    await session.close();
  });
});

describe("barren screens", () => {
  /** A canvas/Flutter surface: one node, no usable tree. */
  class CanvasDevice extends MockDevice {
    override async dumpUi(): Promise<{ elements: UiElement[]; screen: ScreenContext; prunedCount: number }> {
      const screen: ScreenContext = {
        app: "com.example.game",
        activity: ".GameActivity",
        width: 1080,
        height: 2340,
        orientation: "portrait",
      };
      return {
        elements: [
          {
            ref: "e1", role: "WebView", bounds: { x: 0, y: 0, width: 1080, height: 2340 },
            center: [540, 1170], enabled: true, clickable: false, scrollable: false,
            depth: 0, roleIndex: 0, childCount: 0,
          },
        ],
        screen,
        prunedCount: 0,
      };
    }
  }

  it("flags a screen the accessibility tree cannot describe", async () => {
    const session = new Session(new CanvasDevice("mock:canvas"), {
      secretStore: new SecretStore("/nonexistent.json"),
      approvalStore: new ApprovalStore(mkdtempSync(join(tmpdir(), "approvals-"))),
    });
    const snap = await session.observe();
    expect(snap.barren).toBe(true);
    expect(session.view(snap).barren).toBe(true);
    await session.close();
  });

  it("does not flag an ordinary screen", async () => {
    const { session } = newSession();
    await session.openApp(BANK);
    expect((await session.observe()).barren).toBe(false);
    await session.close();
  });
});

describe("batching", () => {
  it("runs a whole login in one call", async () => {
    const { session, device } = newSession();
    const r = await session.batch([
      { action: "open_app", appId: BANK },
      { action: "type", selector: { label: "Username" }, text: "ada@example.com" },
      { action: "type_secret", selector: { label: "Password" }, key: "test_password" },
      { action: "tap", selector: { text: "Sign in" } },
    ]);

    expect(r.ok).toBe(true);
    expect(r.completed).toBe(4);
    expect(device.screen).toBe("bank.otp");
    // The agent was blind during the batch, so it gets everything at the end.
    expect(r.screen.mode).toBe("full");
    expect(r.screen.elements).toContain("Verification code");
    await session.close();
  });

  it("stops at the first failure and says what was not attempted", async () => {
    const { session } = newSession();
    const r = await session.batch([
      { action: "open_app", appId: BANK },
      { action: "tap", selector: { text: "Does not exist" } },
      { action: "tap", selector: { text: "Sign in" } },
    ]);

    expect(r.ok).toBe(false);
    expect(r.completed).toBe(1);
    expect(r.stoppedAt).toBe(1);
    expect(r.steps[1]!.code).toBe("no_match");
    expect(r.steps).toHaveLength(2);
    expect(r.screen.elements).toContain("Sign in");
    await session.close();
  });

  it("halts on a step needing approval and surfaces the id", async () => {
    const { session } = newSession();
    await session.batch([
      { action: "open_app", appId: BANK },
      { action: "type", selector: { label: "Username" }, text: "ada" },
      { action: "type_secret", selector: { label: "Password" }, key: "test_password" },
      { action: "tap", selector: { text: "Sign in" } },
    ]);
    const otp = await session.waitForOtp({ timeoutMs: 5000 });
    await session.batch([
      { action: "type", selector: { label: "Verification code" }, text: otp.code },
      { action: "tap", selector: { text: "Verify" } },
    ]);

    const r = await session.batch([
      { action: "tap", selector: { text: "Send money" } },
      { action: "type", selector: { label: "Recipient" }, text: "Grace" },
    ]);

    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe(0);
    expect(r.steps[0]!.code).toBe("awaiting_approval");
    expect(r.steps[0]!.approvalId).toMatch(/^[0-9a-f]{8}$/);
    await session.close();
  }, 30_000);

  it("keeps the bright lines inside a batch", async () => {
    const { session } = newSession();
    const r = await session.batch([
      { action: "open_app", appId: BANK },
      { action: "type", selector: { label: "Username" }, text: "4111 1111 1111 1111" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.steps[1]!.code).toBe("policy_denied");
    expect(r.steps[1]!.error).toContain("payment card");
    await session.close();
  });

  it("never leaks a secret into a batch result", async () => {
    const { session } = newSession();
    const r = await session.batch([
      { action: "open_app", appId: BANK },
      { action: "type_secret", selector: { label: "Password" }, key: "test_password" },
    ]);
    expect(JSON.stringify(r)).not.toContain("s3cr3t-value-xyz");
    await session.close();
  });

  it("can be told to push through failures", async () => {
    const { session } = newSession();
    const r = await session.batch(
      [
        { action: "open_app", appId: BANK },
        { action: "tap", selector: { text: "Nope" } },
        { action: "type", selector: { label: "Username" }, text: "ada" },
      ],
      { stopOnError: false },
    );
    expect(r.completed).toBe(2);
    expect(r.steps).toHaveLength(3);
    await session.close();
  });

  it("rejects an empty batch", async () => {
    const { session } = newSession();
    await expect(session.batch([])).rejects.toThrowError(/at least one step/);
    await session.close();
  });
});

describe("deep links", () => {
  it("lists what the foreground app declares", async () => {
    const { session } = newSession();
    await session.openApp(BANK);
    const links = await session.deepLinks();
    expect(links.map((l) => l.example)).toContain("demobank://send");
    await session.close();
  });

  it("explains itself when the provider cannot enumerate them", async () => {
    const device = new MockDevice("mock:nolinks");
    delete (device as { listDeepLinks?: unknown }).listDeepLinks;
    const bare = Object.create(
      Object.getPrototypeOf(device) as object,
      Object.getOwnPropertyDescriptors(device),
    ) as MockDevice & { listDeepLinks?: unknown };
    bare.listDeepLinks = undefined;

    const session = new Session(bare, {
      secretStore: new SecretStore("/nonexistent.json"),
      approvalStore: new ApprovalStore(mkdtempSync(join(tmpdir(), "approvals-"))),
    });
    const e = (await session.deepLinks(BANK).catch((x) => x)) as HarnessError;
    expect(e.code).toBe("unsupported");
    expect(e.hint).toContain("phone_open_url");
    await session.close();
  });
});

describe("android deep link and idle parsing", () => {
  const DUMP = `
Activity Resolver Table:
  Non-Data Actions:
      android.intent.action.MAIN:
        a1b2 com.example.bank/.LaunchActivity filter c3d4
          Action: "android.intent.action.MAIN"
          Category: "android.intent.category.LAUNCHER"
  Schemes:
      "bankapp":
        e5f6 com.example.bank/.DeepLinkActivity filter 7a8b
          Action: "android.intent.action.VIEW"
          Category: "android.intent.category.DEFAULT"
          Category: "android.intent.category.BROWSABLE"
          Scheme: "bankapp"
          Authority: "orders": -1
          Path: "PatternMatcher{PREFIX: /detail}"
      "https":
        9c0d com.example.bank/.WebLinkActivity filter 1e2f
          Action: "android.intent.action.VIEW"
          Category: "android.intent.category.DEFAULT"
          Category: "android.intent.category.BROWSABLE"
          Scheme: "https"
          Authority: "bank.example.com": -1
      "internal":
        3a4b com.example.bank/.InternalActivity filter 5c6d
          Action: "android.intent.action.VIEW"
          Category: "android.intent.category.DEFAULT"
          Scheme: "internal"
          Authority: "secret": -1
`;

  it("keeps only filters that are launchable from outside the app", () => {
    const links = parseDeepLinks(DUMP);
    const examples = links.map((l) => l.example);

    expect(examples).toContain("bankapp://orders/detail");
    expect(examples).toContain("https://bank.example.com");
    // No BROWSABLE category, so nothing outside the app can open it.
    expect(examples.some((e) => e.startsWith("internal://"))).toBe(false);
    // MAIN/LAUNCHER is not a deep link.
    expect(examples.some((e) => e.includes("LaunchActivity"))).toBe(false);
  });

  it("attributes each link to its activity", () => {
    const link = parseDeepLinks(DUMP).find((l) => l.scheme === "bankapp")!;
    expect(link.activity).toBe("com.example.bank/.DeepLinkActivity");
    expect(link.host).toBe("orders");
    expect(link.pathPrefix).toBe("/detail");
  });

  it("returns nothing rather than guessing on unfamiliar output", () => {
    expect(parseDeepLinks("")).toEqual([]);
    expect(parseDeepLinks("some completely unrelated dumpsys output")).toEqual([]);
  });

  it("reads the transition state, and admits when it cannot", () => {
    expect(parseTransitionIdle("  mAppTransitionState=APP_STATE_IDLE")).toBe(true);
    expect(parseTransitionIdle("  mAppTransitionState=APP_STATE_RUNNING")).toBe(false);
    expect(parseTransitionIdle("no such field here")).toBeUndefined();
  });
});
