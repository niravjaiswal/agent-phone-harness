import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "../src/http/server.js";

/** The REST front door, for agents that do not speak MCP. */
describe("HTTP API", () => {
  let base: string;
  let stop: () => Promise<void>;
  let sessionId: string;
  const TOKEN = "test-token-123";

  const req = async (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    const s = await serve({ port: 0, host: "127.0.0.1", token: TOKEN, allowMockFallback: true });
    base = `http://127.0.0.1:${s.port}`;
    stop = s.close;
  });

  afterAll(async () => {
    await stop();
  });

  it("serves health without a token", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("rejects an unauthenticated request to everything else", async () => {
    expect((await fetch(`${base}/devices`)).status).toBe(401);
    expect((await fetch(`${base}/devices`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("lists devices", async () => {
    const body = (await (await req("/devices")).json()) as { devices: { id: string }[] };
    expect(body.devices.some((d) => d.id === "mock:demo")).toBe(true);
  });

  it("reports doctor findings", async () => {
    const body = (await (await req("/doctor")).json()) as { reports: { platform: string }[] };
    expect(body.reports.map((r) => r.platform)).toEqual(["android", "ios", "mock"]);
  });

  it("creates a session and returns the first screen", async () => {
    const r = await post("/sessions", {
      deviceId: "mock:demo",
      policy: { allowedApps: ["com.example.demobank", "com.mock.launcher"] },
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { sessionId: string; screen: { elements: string } };
    sessionId = body.sessionId;
    expect(body.screen.elements).toContain("Demo Bank");
  });

  it("taps by selector and returns the resulting screen", async () => {
    const body = (await (
      await post(`/sessions/${sessionId}/tap`, { selector: { text: "Demo Bank" } })
    ).json()) as { ok: boolean; change: string; screen: { elements: string } };
    expect(body.ok).toBe(true);
    expect(body.change).toContain("LoginActivity");
    expect(body.screen.elements).toContain("Sign in");
  });

  it("serves a PNG screenshot", async () => {
    const r = await req(`/sessions/${sessionId}/screenshot?marks=1`);
    expect(r.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("maps harness errors onto sensible status codes", async () => {
    const notFound = await post(`/sessions/${sessionId}/tap`, { selector: { text: "Nope" } });
    expect(notFound.status).toBe(400);
    expect((await notFound.json()) as { code: string }).toMatchObject({ code: "no_match" });

    const denied = await post(`/sessions/${sessionId}/shell`, { command: "id" });
    expect(denied.status).toBe(403);

    const missing = await req(`/sessions/nope-not-real`);
    expect(missing.status).toBe(404);
  });

  it("streams events over SSE", async () => {
    const ctrl = new AbortController();
    const r = await req("/events", { signal: ctrl.signal });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: hello");
    ctrl.abort();
  });

  it("lets an operator approve a gated action out of band", async () => {
    // Drive to a screen with a risky control.
    await post(`/sessions/${sessionId}/type`, { selector: { label: "Username" }, text: "ada" });
    await post(`/sessions/${sessionId}/type`, { selector: { label: "Password" }, text: "pw" });
    await post(`/sessions/${sessionId}/tap`, { selector: { text: "Sign in" } });
    const otp = (await (
      await post(`/sessions/${sessionId}/wait_for_otp`, { digits: 6, timeoutMs: 8000 })
    ).json()) as { code: string };
    await post(`/sessions/${sessionId}/type`, { selector: { label: "Verification code" }, text: otp.code });
    await post(`/sessions/${sessionId}/tap`, { selector: { text: "Verify" } });

    const gated = post(`/sessions/${sessionId}/tap`, { selector: { text: "Send money" } });

    // Meanwhile an operator lists and approves.
    let approvalId: string | undefined;
    for (let i = 0; i < 40 && !approvalId; i++) {
      await new Promise((res) => setTimeout(res, 100));
      const list = (await (await req("/approvals?pending=1")).json()) as { approvals: { id: string }[] };
      approvalId = list.approvals[0]?.id;
    }
    expect(approvalId).toBeTruthy();
    const decided = await post(`/approvals/${approvalId}/approve`, { by: "test", note: "ok" });
    expect(decided.status).toBe(200);

    const body = (await (await gated).json()) as { ok?: boolean; change?: string };
    expect(body.ok).toBe(true);
    expect(body.change).toContain("SendMoneyActivity");
  }, 40_000);

  it("closes the session", async () => {
    const r = await req(`/sessions/${sessionId}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect((await req(`/sessions/${sessionId}`)).status).toBe(404);
  });
});
