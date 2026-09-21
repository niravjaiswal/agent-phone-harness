import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/core/approvals.js";
import { HarnessError } from "../src/core/errors.js";
import { SecretStore } from "../src/core/secrets.js";
import { Session } from "../src/core/session.js";
import { MockDevice } from "../src/providers/mock/index.js";
import type { PolicyConfig } from "../src/core/policy.js";

const BANK = "com.example.demobank";

function newApprovals() {
  return new ApprovalStore(mkdtempSync(join(tmpdir(), "approvals-")));
}

function newSession(policy: Partial<PolicyConfig> = {}, opts: { approvals?: ApprovalStore; approvalWaitMs?: number } = {}) {
  const device = new MockDevice(`mock:${Math.random().toString(36).slice(2)}`);
  process.env.PHONE_SECRET_TEST_PASSWORD = "s3cr3t-value-xyz";
  const session = new Session(device, {
    policy: { allowedApps: [BANK, "com.mock.launcher", "com.mock.messages"], ...policy },
    secretStore: new SecretStore("/nonexistent.json"),
    approvalStore: opts.approvals ?? newApprovals(),
    approvalWaitMs: opts.approvalWaitMs ?? 300,
  });
  return { device, session };
}

/** Drive the mock phone as far as the authenticated home screen. */
async function signIn(session: Session) {
  await session.openApp(BANK);
  await session.type("ada@example.com", { target: { selector: { label: "Username" } } });
  await session.typeSecret("test_password", { target: { selector: { label: "Password" } } });
  await session.tap({ selector: { text: "Sign in" } });
  const otp = await session.waitForOtp({ digits: 6, timeoutMs: 5000 });
  await session.type(otp.code, { target: { selector: { label: "Verification code" } } });
  await session.tap({ selector: { text: "Verify" } });
  return otp.code;
}

describe("Session — end to end on the mock phone", () => {
  it("completes a login that requires an SMS one-time code", async () => {
    const { session } = newSession();
    const code = await signIn(session);
    expect(code).toMatch(/^\d{6}$/);

    const snap = await session.observe();
    expect(snap.screen.activity).toBe(".HomeActivity");
    expect(session.view(snap).elements).toContain("Balance $1,234.56");
    await session.close();
  });

  it("returns the resulting screen from every action, with a change summary", async () => {
    const { session } = newSession();
    const r = await session.openApp(BANK);
    expect(r.ok).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.change).toContain(".LoginActivity");
    expect(r.screen.elements).toContain("Sign in");
    await session.close();
  });

  it("refuses to tap a disabled control", async () => {
    const { session } = newSession();
    await session.openApp(BANK);
    // "Sign in" is disabled until both fields are filled.
    await expect(session.tap({ selector: { text: "Sign in" } })).rejects.toThrowError(/disabled/);
    await session.close();
  });
});

describe("Session — targeting", () => {
  it("re-finds an element by identity when refs have shifted", async () => {
    const { session, device } = newSession();
    device.sms.push({ from: "A", body: "first", timestamp: 1 });
    device.sms.push({ from: "B", body: "second", timestamp: 2 });
    await session.openApp("com.mock.messages");

    const before = await session.observe();
    const target = before.elements.find((e) => e.text?.includes("second"))!;

    // A new message arrives at the top of the list, shifting every ref below it.
    // Read the device directly so the session keeps its pre-shift snapshot.
    device.sms.unshift({ from: "C", body: "zero", timestamp: 0 });
    const fresh = await device.dumpUi();
    expect(fresh.elements.find((e) => e.ref === target.ref)?.text).not.toContain("second");

    // resolveTarget takes its own fresh dump and re-finds by identity.
    const resolved = await session.resolveTarget({ ref: target.ref });
    expect(resolved.element?.text).toContain("second");
    await session.close();
  });

  it("errors on a ref that no longer exists at all", async () => {
    const { session } = newSession();
    await session.observe();
    await expect(session.tap({ ref: "e999" })).rejects.toMatchObject({ code: "stale_ref" });
    await session.close();
  });

  it("reports no_match with what is actually on screen", async () => {
    const { session } = newSession();
    await session.observe();
    const e = await session.tap({ selector: { text: "Nonexistent" } }).catch((x: HarnessError) => x);
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).code).toBe("no_match");
    expect(JSON.stringify((e as HarnessError).details)).toContain("Demo Bank");
    await session.close();
  });

  it("taps raw coordinates when asked", async () => {
    const { session, device } = newSession();
    await session.observe();
    const target = (await session.observe()).elements.find((el) => el.text === "Demo Bank")!;
    await session.tap({ point: target.center });
    expect(device.screen).toBe("bank.login");
    await session.close();
  });
});

describe("Session — safety", () => {
  it("routes a risky tap to a human and refuses while it is pending", async () => {
    const approvals = newApprovals();
    const { session } = newSession({}, { approvals });
    await signIn(session);

    const e = (await session.tap({ selector: { text: "Send money" } }).catch((x) => x)) as HarnessError;
    expect(e.code).toBe("awaiting_approval");
    const approvalId = (e.details as { approvalId: string }).approvalId;
    expect(approvals.get(approvalId)?.status).toBe("pending");
    expect(e.hint).toContain(approvalId);
    await session.close();
  });

  it("proceeds once a human approves, and only with that approval id", async () => {
    const approvals = newApprovals();
    const { session } = newSession({}, { approvals });
    await signIn(session);

    const e = (await session.tap({ selector: { text: "Send money" } }).catch((x) => x)) as HarnessError;
    const approvalId = (e.details as { approvalId: string }).approvalId;

    // A separate operator process decides; the agent cannot.
    approvals.decide(approvalId, true, "test-operator");

    const r = await session.tap({ selector: { text: "Send money" } }, { approvalId });
    expect(r.change).toContain(".SendMoneyActivity");

    // A fresh attempt without the approval is gated again — approvals are single-shot.
    await session.tap({ selector: { text: "Cancel" } });
    await expect(session.tap({ selector: { text: "Send money" } })).rejects.toMatchObject({
      code: "awaiting_approval",
    });
    await session.close();
  });

  it("stops for good when a human denies", async () => {
    const approvals = newApprovals();
    const { session } = newSession({}, { approvals, approvalWaitMs: 5000 });
    await signIn(session);

    const pending = session.tap({ selector: { text: "Send money" } });
    // Wait for the request to land, then deny it.
    await new Promise((r) => setTimeout(r, 400));
    const req = approvals.list({ pendingOnly: true })[0]!;
    approvals.decide(req.id, false, "test-operator", "not authorised");

    const e = (await pending.catch((x) => x)) as HarnessError;
    expect(e.code).toBe("policy_denied");
    expect(e.message).toContain("denied");
    expect(e.hint).toContain("Do not retry");
    await session.close();
  });

  it("never lets a secret reach the result, the trace or an error", async () => {
    const { session } = newSession();
    await session.openApp(BANK);
    const r = await session.typeSecret("test_password", { target: { selector: { label: "Password" } } });

    expect(JSON.stringify(r)).not.toContain("s3cr3t-value-xyz");
    expect(r.target).toContain("«secret:test_password»");

    const trace = readFileSync(session.audit.tracePath, "utf8");
    expect(trace).not.toContain("s3cr3t-value-xyz");
    await session.close();
  });

  it("names the available keys when a secret is missing", async () => {
    const { session } = newSession();
    await expect(session.typeSecret("nope")).rejects.toThrowError(/No secret named/);
    await session.close();
  });

  it("observe mode blocks every input action", async () => {
    const { session } = newSession({ mode: "observe" });
    await expect(session.tap({ selector: { text: "Demo Bank" } })).rejects.toMatchObject({ code: "policy_denied" });
    const snap = await session.observe();
    expect(snap.elements.length).toBeGreaterThan(0);
    await session.close();
  });

  it("enforces the action budget", async () => {
    const { session } = newSession({ maxActionsPerSession: 2 });
    await session.pressKey("home");
    await session.pressKey("home");
    await expect(session.pressKey("home")).rejects.toMatchObject({ code: "budget_exceeded" });
    await session.close();
  });

  it("refuses to drive an app outside the session scope", async () => {
    const { session } = newSession({ allowedApps: ["com.example.demobank"] });
    await expect(session.openApp("com.mock.messages")).rejects.toMatchObject({ code: "policy_denied" });
    await session.close();
  });
});

describe("Session — audit", () => {
  it("writes one trace line per action with the resulting change", async () => {
    const { session } = newSession();
    await session.openApp(BANK);
    await session.type("ada", { target: { selector: { label: "Username" } } });

    const lines = readFileSync(session.audit.tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["session_start", "open_app", "type"]);
    expect(lines[1].ok).toBe(true);
    expect(lines[1].result.change).toContain("LoginActivity");
    expect(lines.every((l, i) => l.seq === i + 1)).toBe(true);
    await session.close();
  });

  it("records a failed resolution, so a post-mortem shows what the agent reached for", async () => {
    const { session } = newSession();
    await session.tap({ selector: { text: "Nope" } }).catch(() => {});
    const lines = readFileSync(session.audit.tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const failure = lines.find((l) => l.kind === "resolve_failed");
    expect(failure).toBeDefined();
    expect(failure.ok).toBe(false);
    expect(failure.args.target).toContain("Nope");
    await session.close();
  });
});

describe("Session — waiting", () => {
  let ctx: ReturnType<typeof newSession>;
  beforeEach(() => {
    ctx = newSession();
  });

  it("waits for an element to appear", async () => {
    const { session, device } = ctx;
    setTimeout(() => void device.launchApp(BANK), 150);
    const r = await session.waitFor({ textContains: "Sign in" }, { timeoutMs: 3000, intervalMs: 50 });
    expect(r.screen.elements).toContain("Sign in");
    await session.close();
  });

  it("waits for an element to disappear", async () => {
    const { session, device } = ctx;
    await device.launchApp(BANK);
    setTimeout(() => void device.pressKey("home"), 150);
    const r = await session.waitFor({ textContains: "Sign in", gone: true }, { timeoutMs: 3000, intervalMs: 50 });
    expect(r.screen.elements).not.toContain("Sign in");
    await session.close();
  });

  it("times out with the current screen attached", async () => {
    const { session } = ctx;
    const e = (await session
      .waitFor({ textContains: "Never appears" }, { timeoutMs: 400, intervalMs: 50 })
      .catch((x) => x)) as HarnessError;
    expect(e.code).toBe("timeout");
    expect(JSON.stringify(e.details)).toContain("Demo Bank");
    await session.close();
  });

  it("times out waiting for an OTP that never arrives", async () => {
    const { session } = ctx;
    await expect(session.waitForOtp({ timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
    await session.close();
  });

  it("finds an OTP in notifications as well as SMS", async () => {
    const { session, device } = ctx;
    device.notifications.unshift({ pkg: "com.mock.messages", title: "Acme", text: "Code 447722", timestamp: Date.now() });
    const r = await session.waitForOtp({ fromContains: "acme", timeoutMs: 3000 });
    expect(r.code).toBe("447722");
    await session.close();
  });
});

describe("Session — scroll direction", () => {
  it("drags the finger opposite to the requested content direction", async () => {
    const { session, device } = newSession();
    await session.scroll("down");
    const swipe = device.log.find((l) => l.startsWith("swipe"))!;
    const [from, to] = swipe.replace("swipe(", "").replace(")", "").split("->");
    const fromY = Number(from!.split(",")[1]);
    const toY = Number(to!.split(",")[1]);
    expect(fromY).toBeGreaterThan(toY);
    await session.close();
  });
});

describe("Session — perception unavailable", () => {
  /** A phone that can still be driven but whose screen cannot be read. */
  class BlindDevice extends MockDevice {
    blind = false;
    override async dumpUi() {
      if (this.blind) throw new HarnessError("unsupported", "Reading the screen requires WebDriverAgent");
      return super.dumpUi();
    }
  }

  function blindSession(policy: Partial<PolicyConfig> = {}) {
    const device = new BlindDevice("mock:blind");
    const session = new Session(device, {
      policy,
      secretStore: new SecretStore("/nonexistent.json"),
      approvalStore: newApprovals(),
    });
    return { device, session };
  }

  it("reports a completed action as completed, and tells the agent not to retry", async () => {
    const { device, session } = blindSession();
    device.blind = true;

    const r = await session.openUrl("https://example.com");
    expect(r.ok).toBe(true);
    expect(r.settled).toBe(false);
    expect(r.change).toContain("could not be read");
    expect(r.note).toContain("do not retry");
    expect(device.log).toContain("openUrl(https://example.com)");
    await session.close();
  });

  it("records the observation failure alongside the successful action", async () => {
    const { device, session } = blindSession();
    device.blind = true;
    await session.openUrl("https://example.com");

    const lines = readFileSync(session.audit.tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.kind === "open_url")!;
    expect(entry.ok).toBe(true);
    expect(entry.result.observeError).toContain("WebDriverAgent");
    await session.close();
  });

  it("refuses to act blind when the session is scoped to specific apps", async () => {
    const { device, session } = blindSession({ allowedApps: ["com.example.demobank"] });
    device.blind = true;
    await expect(session.pressKey("home")).rejects.toMatchObject({ code: "policy_denied" });
    await session.close();
  });

  it("refuses to screenshot when password fields cannot be located", async () => {
    const { device, session } = blindSession();
    device.blind = true;
    await expect(session.screenshot()).rejects.toThrowError(/Cannot capture safely/);
    await session.close();
  });

  it("captures unredacted only when the session explicitly opts in", async () => {
    const { device, session } = blindSession({ redactPasswordFields: false });
    device.blind = true;
    const shot = await session.screenshot();
    expect(shot.redacted).toBe(false);
    expect(shot.data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await session.close();
  });
});
