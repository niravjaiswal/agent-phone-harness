import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clampPolicy, loadCeiling } from "../src/core/ceiling.js";
import { DEFAULT_POLICY, type PolicyConfig } from "../src/core/policy.js";

const ceiling = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY, ...over });

describe("operator policy ceiling", () => {
  it("never lets an agent raise its own mode", () => {
    const r = clampPolicy(ceiling({ mode: "guarded" }), { mode: "autonomous" });
    expect(r.policy.mode).toBe("guarded");
    expect(r.clamped[0]).toContain("exceeds the operator's ceiling");
  });

  it("lets an agent lower its mode", () => {
    expect(clampPolicy(ceiling({ mode: "autonomous" }), { mode: "observe" }).policy.mode).toBe("observe");
  });

  it("uses the ceiling as the default when the agent asks for nothing", () => {
    const r = clampPolicy(ceiling({ mode: "autonomous", allowShell: true }), {});
    expect(r.policy.mode).toBe("autonomous");
    expect(r.policy.allowShell).toBe(true);
    expect(r.clamped).toEqual([]);
  });

  it("ANDs capability flags", () => {
    const r = clampPolicy(ceiling({ allowShell: false, allowInstall: true }), { allowShell: true, allowInstall: false });
    expect(r.policy.allowShell).toBe(false);
    expect(r.policy.allowInstall).toBe(false);
    expect(r.clamped).toContain("allowShell is disabled by the operator");
  });

  it("will not let an agent turn off password redaction", () => {
    expect(clampPolicy(ceiling(), { redactPasswordFields: false }).policy.redactPasswordFields).toBe(true);
  });

  it("intersects app allowlists, glob-aware", () => {
    const r = clampPolicy(ceiling({ allowedApps: ["com.bank.*"] }), {
      allowedApps: ["com.bank.app", "com.bank.*", "com.evil.app"],
    });
    expect(r.policy.allowedApps).toEqual(["com.bank.app", "com.bank.*"]);
    expect(r.clamped.join()).toContain("com.evil.app");
  });

  it("refuses a session whose requested apps are all outside the allowlist", () => {
    expect(() => clampPolicy(ceiling({ allowedApps: ["com.bank.app"] }), { allowedApps: ["com.other"] })).toThrowError(
      /None of the requested apps/,
    );
  });

  it("scopes an unscoped ceiling to what the agent asked for", () => {
    expect(clampPolicy(ceiling(), { allowedApps: ["com.x"] }).policy.allowedApps).toEqual(["com.x"]);
  });

  it("unions blocklists and patterns, so the agent can only add restrictions", () => {
    const r = clampPolicy(ceiling({ blockedApps: ["a"], blockPatterns: ["x"] }), {
      blockedApps: ["b"],
      blockPatterns: [],
    });
    expect(r.policy.blockedApps).toEqual(["a", "b"]);
    expect(r.policy.blockPatterns).toEqual(["x"]);
  });

  it("takes the smaller budget", () => {
    const r = clampPolicy(ceiling({ maxActionsPerSession: 100 }), { maxActionsPerSession: 9999 });
    expect(r.policy.maxActionsPerSession).toBe(100);
    expect(clampPolicy(ceiling({ maxActionsPerSession: 100 }), { maxActionsPerSession: 5 }).policy.maxActionsPerSession).toBe(5);
  });

  it("intersects url schemes", () => {
    expect(clampPolicy(ceiling({ allowUrlSchemes: ["https"] }), { allowUrlSchemes: ["https", "intent"] }).policy.allowUrlSchemes).toEqual([
      "https",
    ]);
  });
});

describe("loading the ceiling", () => {
  const dir = mkdtempSync(join(tmpdir(), "ceiling-"));

  it("falls back to the defaults when there is no file", () => {
    expect(loadCeiling(join(dir, "missing.json")).mode).toBe("guarded");
  });

  it("reads policy.json, ignoring _comment keys", () => {
    const f = join(dir, "p1.json");
    writeFileSync(f, JSON.stringify({ _comment: "x", mode: "autonomous", allowShell: true }));
    const c = loadCeiling(f);
    expect(c.mode).toBe("autonomous");
    expect(c.allowShell).toBe(true);
    expect((c as unknown as Record<string, unknown>)._comment).toBeUndefined();
  });

  it("fails closed to observe-only when the file is broken", () => {
    const f = join(dir, "p2.json");
    writeFileSync(f, "{ not json");
    expect(loadCeiling(f).mode).toBe("observe");
    const g = join(dir, "p3.json");
    writeFileSync(g, JSON.stringify({ mode: "yolo" }));
    expect(loadCeiling(g).mode).toBe("observe");
  });
});
