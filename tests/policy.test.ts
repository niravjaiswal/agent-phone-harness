import { describe, expect, it } from "vitest";
import { Policy } from "../src/core/policy.js";

describe("Policy", () => {
  const guarded = new Policy();

  it("allows benign taps", () => {
    expect(guarded.evaluate({ kind: "tap", targetText: "Next" }).risk).toBe("allow");
  });

  it("gates risky-sounding targets on a human", () => {
    for (const t of ["Confirm transfer", "Pay now", "Delete account", "Place order", "I agree", "Log out"]) {
      expect(guarded.evaluate({ kind: "tap", targetText: t }).risk, t).toBe("confirm");
    }
  });

  it("refuses payment card and government ID numbers outright", () => {
    // Valid Luhn test number.
    const card = guarded.evaluate({ kind: "type", text: "4111 1111 1111 1111" });
    expect(card.risk).toBe("deny");
    expect(card.reason).toContain("payment card");

    expect(guarded.evaluate({ kind: "type", text: "my ssn is 123-45-6789" }).risk).toBe("deny");
  });

  it("does not mistake an ordinary long number for a card", () => {
    expect(guarded.evaluate({ kind: "type", text: "1234567890123456" }).risk).toBe("allow");
    expect(guarded.evaluate({ kind: "type", text: "order 993021 shipped" }).risk).toBe("allow");
  });

  it("keeps privileged capabilities off unless enabled", () => {
    expect(guarded.evaluate({ kind: "shell", command: "ls" }).risk).toBe("deny");
    expect(guarded.evaluate({ kind: "install_app" }).risk).toBe("deny");
    expect(guarded.evaluate({ kind: "clear_app_data", appId: "com.x" }).risk).toBe("deny");

    const loose = new Policy({ allowShell: true, allowInstall: true, allowClearAppData: true });
    expect(loose.evaluate({ kind: "shell", command: "ls" }).risk).toBe("confirm");
    expect(loose.evaluate({ kind: "install_app" }).risk).toBe("confirm");
  });

  it("scopes a session to its allowed apps", () => {
    const scoped = new Policy({ allowedApps: ["com.example.bank", "com.example.other.*"] });
    expect(scoped.evaluate({ kind: "tap", appId: "com.example.bank" }).risk).toBe("allow");
    expect(scoped.evaluate({ kind: "tap", appId: "com.example.other.thing" }).risk).toBe("allow");
    expect(scoped.evaluate({ kind: "tap", appId: "com.evil.app" }).risk).toBe("deny");
  });

  it("blocks Settings by default", () => {
    expect(guarded.evaluate({ kind: "open_app", appId: "com.android.settings" }).risk).toBe("deny");
  });

  it("restricts url schemes", () => {
    expect(guarded.evaluate({ kind: "open_url", url: "https://example.com" }).risk).toBe("allow");
    expect(guarded.evaluate({ kind: "open_url", url: "file:///etc/passwd" }).risk).toBe("deny");
  });

  it("observe mode permits reads and nothing else", () => {
    const ro = new Policy({ mode: "observe" });
    expect(ro.evaluate({ kind: "observe" }).risk).toBe("allow");
    expect(ro.evaluate({ kind: "read_sms" }).risk).toBe("allow");
    expect(ro.evaluate({ kind: "tap", targetText: "Next" }).risk).toBe("deny");
  });

  it("autonomous mode skips confirmation but keeps the bright lines", () => {
    const auto = new Policy({ mode: "autonomous" });
    expect(auto.evaluate({ kind: "tap", targetText: "Confirm transfer" }).risk).toBe("allow");
    expect(auto.evaluate({ kind: "type", text: "4111111111111111" }).risk).toBe("deny");
    expect(auto.evaluate({ kind: "open_app", appId: "com.android.settings" }).risk).toBe("deny");
  });

  it("honours caller-supplied hard blocks", () => {
    const strict = new Policy({ blockPatterns: ["\\bwire\\b"] });
    expect(strict.evaluate({ kind: "tap", targetText: "Wire funds" }).risk).toBe("deny");
  });

  it("assertAllowed throws a policy_denied HarnessError", () => {
    expect(() => guarded.assertAllowed({ kind: "shell", command: "id" })).toThrowError(/denied/);
  });
});
