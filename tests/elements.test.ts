import { describe, expect, it } from "vitest";
import {
  diffSnapshots, finalizeElements, hashElements, matchesSelector,
  pruneElements, renderElements, resolveSelector, type RawElement,
} from "../src/core/elements.js";
import type { ScreenContext, Snapshot } from "../src/core/types.js";

const screen: ScreenContext = { app: "com.x", activity: ".Main", width: 1080, height: 2340, orientation: "portrait" };

const raw = (over: Partial<RawElement>): RawElement => ({
  role: "Text",
  bounds: { x: 0, y: 0, width: 100, height: 50 },
  enabled: true,
  clickable: false,
  scrollable: false,
  depth: 1,
  childCount: 0,
  ...over,
});

describe("finalizeElements", () => {
  it("assigns refs, centers and per-role indices", () => {
    const els = finalizeElements([
      raw({ role: "Button", text: "A" }),
      raw({ role: "Button", text: "B", bounds: { x: 10, y: 20, width: 100, height: 40 } }),
      raw({ role: "Text", text: "C" }),
    ]);
    expect(els.map((e) => e.ref)).toEqual(["e1", "e2", "e3"]);
    expect(els[1]!.roleIndex).toBe(1);
    expect(els[2]!.roleIndex).toBe(0);
    expect(els[1]!.center).toEqual([60, 40]);
  });

  it("collapses whitespace and truncates very long text", () => {
    const [e] = finalizeElements([raw({ text: `  hello\n   world  ${"x".repeat(200)}` })]);
    expect(e!.text!.startsWith("hello world")).toBe(true);
    expect(e!.text!.length).toBeLessThanOrEqual(121);
  });
});

describe("pruneElements", () => {
  it("drops layout scaffolding but keeps anything actionable or informative", () => {
    const els = finalizeElements([
      raw({ role: "Group" }),
      raw({ role: "Button", text: "Go", clickable: true }),
      raw({ role: "List", scrollable: true }),
      raw({ role: "Image" }),
      raw({ role: "TextField", label: "Email" }),
    ]);
    const { kept, prunedCount } = pruneElements(els, screen);
    expect(kept.map((e) => e.role)).toEqual(["Button", "List", "TextField"]);
    expect(prunedCount).toBe(2);
  });

  it("drops zero-area and fully off-screen elements", () => {
    const els = finalizeElements([
      raw({ role: "Button", text: "zero", clickable: true, bounds: { x: 0, y: 0, width: 0, height: 0 } }),
      raw({ role: "Button", text: "offscreen", clickable: true, bounds: { x: 2000, y: 100, width: 50, height: 50 } }),
      raw({ role: "Button", text: "real", clickable: true }),
    ]);
    const { kept } = pruneElements(els, screen);
    expect(kept.map((e) => e.text)).toEqual(["real"]);
  });

  it("removes a clickable wrapper whose labelled child covers the same box", () => {
    const els = finalizeElements([
      raw({ role: "Group", clickable: true, bounds: { x: 0, y: 0, width: 400, height: 100 } }),
      raw({ role: "Text", text: "Settings", clickable: true, bounds: { x: 10, y: 10, width: 380, height: 80 } }),
    ]);
    const { kept } = pruneElements(els, screen);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toBe("Settings");
  });
});

describe("renderElements", () => {
  const els = finalizeElements([
    raw({ role: "Text", text: "Welcome" }),
    raw({ role: "TextField", label: "Password", password: true, value: "hunter2", depth: 2 }),
    raw({ role: "Button", text: "Sign in", clickable: true, depth: 2, bounds: { x: 40, y: 900, width: 1000, height: 140 } }),
    raw({ role: "Button", text: "Nope", clickable: true, enabled: false, depth: 2 }),
  ]);

  it("renders a compact tree with state flags and tap centers", () => {
    const { text } = renderElements(els, screen);
    expect(text).toContain("Screen: com.x / .Main (1080x2340 portrait)");
    expect(text).toContain('e1 Text "Welcome"');
    expect(text).toContain("@540,970");
    expect(text).toContain("[disabled]");
  });

  it("never renders a password value", () => {
    const { text } = renderElements(els, screen);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("***");
  });

  it("truncates to the char budget and says so", () => {
    const { text, truncated } = renderElements(els, screen, { maxChars: 90 });
    expect(truncated).toBe(true);
    expect(text).toContain("more elements omitted");
  });
});

describe("resolveSelector", () => {
  const els = finalizeElements([
    raw({ role: "Button", text: "Continue", clickable: true }),
    raw({ role: "Text", text: "Continue" }),
    raw({ role: "Button", text: "Cancel", clickable: true }),
    raw({ role: "Button", text: "Delete", clickable: true }),
    raw({ role: "Button", text: "Delete", clickable: true }),
    raw({ role: "TextField", id: "com.x:id/email", label: "Email" }),
  ]);

  it("matches case-insensitively on trimmed text", () => {
    expect(resolveSelector(els, { text: "  cANCEL " }).element?.text).toBe("Cancel");
  });

  it("prefers the unique clickable candidate over an ambiguous text match", () => {
    const r = resolveSelector(els, { text: "Continue" });
    expect(r.element?.role).toBe("Button");
    expect(r.matches).toHaveLength(2);
  });

  it("reports ambiguity rather than guessing", () => {
    const r = resolveSelector(els, { text: "Delete" });
    expect(r.element).toBeUndefined();
    expect(r.reason).toBe("ambiguous");
  });

  it("supports index, including negative", () => {
    expect(resolveSelector(els, { text: "Delete", index: 1 }).element?.ref).toBe("e5");
    expect(resolveSelector(els, { text: "Delete", index: -1 }).element?.ref).toBe("e5");
  });

  it("matches ids by short form as well as fully qualified", () => {
    expect(resolveSelector(els, { id: "email" }).element?.label).toBe("Email");
    expect(resolveSelector(els, { id: "com.x:id/email" }).element?.label).toBe("Email");
  });

  it("returns no_match when nothing qualifies", () => {
    expect(resolveSelector(els, { text: "Nonexistent" }).reason).toBe("no_match");
  });

  it("filters on state", () => {
    expect(matchesSelector(els[0]!, { clickable: true })).toBe(true);
    expect(matchesSelector(els[1]!, { clickable: true })).toBe(false);
  });
});

describe("hashElements + diffSnapshots", () => {
  const snap = (els: RawElement[], ctx = screen): Snapshot => {
    const elements = finalizeElements(els);
    return {
      snapshotId: "s", deviceId: "d", takenAt: 0, screen: ctx, elements,
      prunedCount: 0, truncated: false, hash: hashElements(elements, ctx),
    };
  };

  it("hashes identical screens identically and different ones differently", () => {
    const a = snap([raw({ text: "x" })]);
    const b = snap([raw({ text: "x" })]);
    const c = snap([raw({ text: "y" })]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("notices a screen change and counts element churn", () => {
    const before = snap([raw({ text: "Login" })]);
    const after = snap([raw({ text: "Code" }), raw({ text: "Verify" })], { ...screen, activity: ".Otp" });
    const d = diffSnapshots(before, after);
    expect(d.changed).toBe(true);
    expect(d.appChanged).toBe(true);
    expect(d.summary).toContain(".Main");
    expect(d.summary).toContain(".Otp");
    expect(d.added).toHaveLength(2);
    expect(d.removed).toHaveLength(1);
  });

  it("reports no change for an identical screen", () => {
    const a = snap([raw({ text: "x" })]);
    expect(diffSnapshots(a, a).changed).toBe(false);
  });
});
