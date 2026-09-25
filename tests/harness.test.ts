import { describe, expect, it } from "vitest";
import { Harness } from "../src/core/harness.js";

const newHarness = (opts: ConstructorParameters<typeof Harness>[0] = {}) =>
  new Harness({ allowMockFallback: true, ceiling: { mode: "guarded" }, ...opts });

describe("device leases", () => {
  it("gives each phone to one session at a time", async () => {
    const h = newHarness();
    const a = await h.createSession({ deviceId: "mock:lease1" });
    await expect(h.createSession({ deviceId: "mock:lease1" })).rejects.toMatchObject({ code: "device_busy" });
    await h.close(a.id);
    const b = await h.createSession({ deviceId: "mock:lease1" });
    expect(b.id).not.toBe(a.id);
    await h.closeAll();
  });

  it("auto-pick skips a busy phone and says so when none is free", async () => {
    const h = newHarness();
    const a = await h.createSession({ platform: "mock" });
    await expect(h.createSession({ platform: "mock" })).rejects.toMatchObject({ code: "device_busy" });
    const status = await h.deviceStatus();
    expect(status.find((d) => d.id === a.device.info.id)).toMatchObject({ state: "busy", leasedBy: a.id });
    await h.closeAll();
  });

  it("reports ceiling clamps as session notes", async () => {
    const h = newHarness();
    const s = await h.createSession({ deviceId: "mock:notes", policy: { mode: "autonomous" } });
    expect(s.policy.config.mode).toBe("guarded");
    expect(s.notes.join()).toContain("exceeds the operator's ceiling");
    await h.closeAll();
  });
});

describe("session ownership", () => {
  it("hides one owner's sessions from another", async () => {
    const h = newHarness();
    const a = await h.createSession({ deviceId: "mock:ownA", owner: "agent-a" });
    await h.createSession({ deviceId: "mock:ownB", owner: "agent-b" });

    expect(h.resolve(undefined, "agent-a").id).toBe(a.id);
    expect(() => h.get(a.id, "agent-b")).toThrowError(/No session/);
    // The operator (no owner) sees everything.
    expect(h.list().length).toBe(2);
    expect(h.list("agent-a").length).toBe(1);
    await h.closeAll();
  });

  it("closes everything an owner opened when its connection goes away", async () => {
    const h = newHarness();
    await h.createSession({ deviceId: "mock:gone1", owner: "conn" });
    await h.createSession({ deviceId: "mock:gone2", owner: "conn" });
    expect(await h.closeOwned("conn")).toBe(2);
    expect(h.list()).toEqual([]);
    // Leases were released.
    await h.createSession({ deviceId: "mock:gone1" });
    await h.closeAll();
  });
});

describe("idle reaping", () => {
  it("frees a phone held by an agent that went quiet", async () => {
    const h = newHarness();
    const s = await h.createSession({ deviceId: "mock:idle" });
    expect(await h.reap(60_000, Date.now() + 30_000)).toEqual([]);
    expect(await h.reap(60_000, Date.now() + 61_000)).toEqual([s.id]);
    await h.createSession({ deviceId: "mock:idle" });
    await h.closeAll();
  });

  it("counts any lookup as activity", async () => {
    const h = newHarness();
    const s = await h.createSession({ deviceId: "mock:busy" });
    const later = Date.now() + 50_000;
    // Simulate a call arriving late in the window.
    h.get(s.id);
    expect(await h.reap(60_000, later)).toEqual([]);
    await h.closeAll();
  });
});

describe("operator control", () => {
  it("pauses agent mutations while a human has the phone, but not reads", async () => {
    const h = newHarness();
    const s = await h.createSession({ deviceId: "mock:ctl", policy: { allowedApps: ["com.mock.launcher", "com.example.demobank"] } });
    h.takeControl("mock:ctl", "nirav");

    await expect(s.tap({ selector: { text: "Demo Bank" } })).rejects.toMatchObject({ code: "device_busy" });
    await expect(s.type("x")).rejects.toMatchObject({ code: "device_busy" });
    await expect(s.observe()).resolves.toBeTruthy();

    h.releaseControl("mock:ctl");
    const r = await s.tap({ selector: { text: "Demo Bank" } });
    expect(r.change).toContain("LoginActivity");
    await h.closeAll();
  });

  it("hands the operator an unguarded device", async () => {
    const h = newHarness();
    await h.createSession({ deviceId: "mock:op" });
    h.takeControl("mock:op");
    const d = await h.operatorDevice("mock:op");
    await expect(d.tap(10, 10)).resolves.toBeUndefined();
    await h.closeAll();
  });

  it("invalidates the agent's cached screen when control returns", async () => {
    const h = newHarness();
    const s = await h.createSession({ deviceId: "mock:inv", policy: { allowedApps: ["com.mock.launcher", "com.example.demobank"] } });
    await s.observe();
    h.takeControl("mock:inv");
    // The human opens the bank app behind the agent's back.
    const d = await h.operatorDevice("mock:inv");
    await d.launchApp("com.example.demobank");
    h.releaseControl("mock:inv");
    // A selector must resolve against the new screen, not the cached launcher.
    const r = await s.type("ada", { target: { selector: { label: "Username" } } });
    expect(r.target).toContain("Username");
    await h.closeAll();
  });
});
