import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateConfigFile } from "../src/core/config.js";
import { Inbox, twilioSignature } from "../src/core/messages/index.js";
import { serve, type RunningServer } from "../src/http/server.js";

const AGENT = "agt_server_test_aaaaaaaa";
const OPERATOR = "op_server_test_bbbbbbbb";
const RELAY = "rly_server_test_cccccccc";
const { publicKey: telnyxPub, privateKey: telnyxPriv } = generateKeyPairSync("ed25519");
const TELNYX_KEY = telnyxPub.export({ format: "der", type: "spki" }).subarray(12).toString("base64");

let srv: RunningServer;
let base: string;
const inbox = new Inbox(join(mkdtempSync(join(tmpdir(), "srv-inbox-")), "inbox.jsonl"));

const call = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

beforeAll(async () => {
  updateConfigFile((c) => {
    c.sources.relayToken = RELAY;
    c.sources.telnyxPublicKey = TELNYX_KEY;
    c.sources.twilioAuthToken = "twilio-auth";
    c.identity.phoneNumber = "+15557654321";
  });
  srv = await serve({
    port: 0,
    agentToken: AGENT,
    operatorToken: OPERATOR,
    allowMockFallback: true,
    ceiling: { mode: "guarded" },
    inbox,
    publicUrl: "https://phone.example.com",
  });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  await srv.close();
});

describe("credentials", () => {
  it("refuses to start with the agent and operator tokens equal", async () => {
    await expect(serve({ port: 0, agentToken: "same-same-same", operatorToken: "same-same-same" })).rejects.toThrow(
      /identical/,
    );
  });

  it("refuses no-auth mode off loopback", async () => {
    await expect(serve({ port: 0, host: "0.0.0.0", auth: false })).rejects.toThrow(/loopback only/);
  });

  it("tells you when the operator token was given to the agent", async () => {
    const r = await call("/devices", { token: OPERATOR });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("This is the operator token");
  });

  it("keeps agents out of every operator route", async () => {
    for (const p of ["/api/operator/overview", "/api/operator/secrets", "/api/operator/connection"]) {
      expect((await call(p, { token: AGENT })).status).toBe(403);
    }
  });
});

describe("browser safety", () => {
  it("refuses cross-origin requests outright", async () => {
    const r = await call("/sessions", { method: "POST", token: AGENT, json: {}, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("refuses non-JSON bodies, which a web page could send without a preflight", async () => {
    const r = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(r.status).toBe(400);
  });

  it("serves the panel with a strict CSP and no framing", async () => {
    const r = await fetch(`${base}/panel/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("panel login", () => {
  it("exchanges the operator token for a cookie; writes also need the CSRF header", async () => {
    const bad = await call("/panel/login", { method: "POST", json: { token: AGENT } });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: string }).error).toContain("That is the agent token");

    const ok = await call("/panel/login", { method: "POST", json: { token: OPERATOR } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Plain http here: a Secure cookie would be silently dropped by the browser.
    expect(cookie).not.toContain("Secure");
    const viaTunnel = await call("/panel/login", {
      method: "POST",
      json: { token: OPERATOR },
      headers: { "x-forwarded-proto": "https" },
    });
    expect(viaTunnel.headers.get("set-cookie")).toContain("Secure");
    const jar = cookie.split(";")[0]!;

    expect((await call("/api/operator/overview", { headers: { cookie: jar } })).status).toBe(200);
    const noCsrf = await call("/api/operator/secrets/x", { method: "PUT", json: { value: "v" }, headers: { cookie: jar } });
    expect(noCsrf.status).toBe(403);
    const withCsrf = await call("/api/operator/secrets/x", {
      method: "PUT",
      json: { value: "v" },
      headers: { cookie: jar, "x-agent-phone": "1" },
    });
    expect(withCsrf.status).toBe(200);
  });

  it("rejects a forged cookie", async () => {
    const r = await call("/api/operator/overview", { headers: { cookie: `ap_op=${Date.now() + 1e9}.forged` } });
    expect(r.status).toBe(401);
  });
});

describe("agent onboarding", () => {
  it("publishes instructions an agent can read without credentials", async () => {
    const r = await fetch(`${base}/agent.md`);
    expect(r.status).toBe(200);
    const md = await r.text();
    expect(md).toContain("https://phone.example.com/mcp");
    expect(md).toContain("+15557654321");
    expect(md).not.toContain(AGENT);
  });

  it("hands the operator a paste-ready connection block", async () => {
    const r = (await (await call("/api/operator/connection", { token: OPERATOR })).json()) as {
      mcpUrl: string;
      agentToken: string;
      prompt: string;
    };
    expect(r.mcpUrl).toBe("https://phone.example.com/mcp");
    expect(r.agentToken).toBe(AGENT);
    expect(r.prompt).toContain("agent.md");
  });
});

describe("inbound SMS webhooks", () => {
  it("accepts a relay phone with the relay token and rejects anyone else", async () => {
    expect((await call("/hooks/sms/relay", { method: "POST", json: { from: "+1", text: "code 1" } })).status).toBe(401);
    const r = await call("/hooks/sms/relay", {
      method: "POST",
      token: RELAY,
      json: { from: "+15550001234", text: "Your Acme code is 551177" },
    });
    expect(r.status).toBe(200);
    expect(inbox.list().some((m) => m.body.includes("551177"))).toBe(true);
  });

  it("verifies Telnyx signatures", async () => {
    const body = JSON.stringify({
      data: { event_type: "message.received", id: "e1", payload: { id: "tx-1", text: "Code 616161", from: { phone_number: "+1555" } } },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|${body}`), telnyxPriv).toString("base64");
    const unsigned = await fetch(`${base}/hooks/sms/telnyx`, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(unsigned.status).toBe(401);
    const signed = await fetch(`${base}/hooks/sms/telnyx`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "telnyx-signature-ed25519": sig, "telnyx-timestamp": ts },
    });
    expect(signed.status).toBe(200);
    expect(inbox.list().some((m) => m.origin === "telnyx" && m.body.includes("616161"))).toBe(true);
  });

  it("verifies Twilio signatures against the public URL it was called on", async () => {
    const params = { MessageSid: "SMx", From: "+1555", To: "+15557654321", Body: "Code 727272" };
    const sig = twilioSignature("twilio-auth", "https://phone.example.com/hooks/sms/twilio", params);
    const r = await fetch(`${base}/hooks/sms/twilio`, {
      method: "POST",
      body: new URLSearchParams(params).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/xml");
    const bad = await fetch(`${base}/hooks/sms/twilio`, {
      method: "POST",
      body: new URLSearchParams({ ...params, Body: "Code 000000" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    });
    expect(bad.status).toBe(401);
  });

  it("delivers a webhook code to an agent waiting on it", async () => {
    const start = (await (
      await call("/sessions", { method: "POST", token: AGENT, json: { deviceId: "mock:hook" } })
    ).json()) as { sessionId: string };
    const waiting = call(`/sessions/${start.sessionId}/wait_for_otp`, {
      method: "POST",
      token: AGENT,
      json: { bodyContains: "Globex", timeoutMs: 8000 },
    });
    await new Promise((r) => setTimeout(r, 300));
    await call("/hooks/sms/relay", { method: "POST", token: RELAY, json: { from: "Globex", text: "Globex code: 838383" } });
    const got = (await (await waiting).json()) as { code: string; message: { origin: string } };
    expect(got.code).toBe("838383");
    expect(got.message.origin).toBe("relay");
    await call(`/sessions/${start.sessionId}`, { method: "DELETE", token: AGENT });
  });
});

describe("MCP over HTTP", () => {
  const connect = async (token = AGENT) => {
    const client = new Client({ name: "t", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return { client, transport };
  };
  const textOf = (r: unknown) =>
    ((r as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");

  it("serves several agents at once, each seeing only its own session", async () => {
    const a = await connect();
    const b = await connect();
    const sa = textOf(await a.client.callTool({ name: "phone_session_start", arguments: { deviceId: "mock:mcpA" } }));
    const sb = textOf(await b.client.callTool({ name: "phone_session_start", arguments: { deviceId: "mock:mcpB" } }));
    expect(sa).toContain("mock:mcpA");
    expect(sa).toContain("+15557654321");
    expect(sb).toContain("mock:mcpB");

    // Implicit resolution picks each client's own session.
    const status = textOf(await a.client.callTool({ name: "phone_session_status", arguments: {} }));
    expect(status).toContain("mock:mcpA");
    // And naming the other client's session does not work.
    const bId = /session (\w+) on/.exec(sb)![1]!;
    const stolen = (await a.client.callTool({ name: "phone_observe", arguments: { sessionId: bId } })) as { isError?: boolean };
    expect(stolen.isError).toBe(true);

    // A client that disconnects releases its phone.
    await a.transport.terminateSession();
    await a.client.close();
    await new Promise((r) => setTimeout(r, 100));
    const devices = textOf(await b.client.callTool({ name: "phone_list_devices", arguments: {} }));
    expect(srv.harness.list().map((s) => s.device.id)).not.toContain("mock:mcpA");
    expect(devices).toBeTruthy();
    await b.transport.terminateSession();
    await b.client.close();
  });

  it("answers a stale session id with 404 so clients re-initialize", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(404);
  });

  it("refuses the operator token", async () => {
    await expect(connect(OPERATOR)).rejects.toThrow();
  });
});

describe("operator takeover", () => {
  it("pauses the agent while a human drives, then hands back", async () => {
    const s = (await (
      await call("/sessions", {
        method: "POST",
        token: AGENT,
        json: { deviceId: "mock:takeover", policy: { allowedApps: ["com.mock.launcher", "com.example.demobank"] } },
      })
    ).json()) as { sessionId: string };
    const dev = encodeURIComponent("mock:takeover");

    // Input without control is refused — the human must take the wheel first.
    const early = await call(`/api/operator/devices/${dev}/input`, { method: "POST", token: OPERATOR, json: { type: "key", key: "home" } });
    expect(early.status).toBe(409);

    expect((await call(`/api/operator/devices/${dev}/control`, { method: "POST", token: OPERATOR, json: { action: "take" } })).status).toBe(200);
    const blocked = await call(`/sessions/${s.sessionId}/tap`, { method: "POST", token: AGENT, json: { selector: { text: "Demo Bank" } } });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("device_busy");

    const shot = await call(`/api/operator/devices/${dev}/screen.png?max=300`, { token: OPERATOR });
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(Number(shot.headers.get("x-device-width"))).toBeGreaterThan(0);

    const tap = await call(`/api/operator/devices/${dev}/input`, { method: "POST", token: OPERATOR, json: { type: "open_app", appId: "com.example.demobank" } });
    expect(tap.status).toBe(200);

    await call(`/api/operator/devices/${dev}/control`, { method: "POST", token: OPERATOR, json: { action: "release" } });
    const after = await call(`/sessions/${s.sessionId}/observe?format=text`, { method: "POST", token: AGENT, json: {} });
    expect(await after.text()).toContain("LoginActivity");
  });
});

describe("operator configuration", () => {
  it("stores secrets write-only", async () => {
    await call("/api/operator/secrets/bank_pin", { method: "PUT", token: OPERATOR, json: { value: "13579" } });
    const list = await (await call("/api/operator/secrets", { token: OPERATOR })).text();
    expect(list).toContain("bank_pin");
    expect(list).not.toContain("13579");
    expect((await call("/api/operator/secrets/bank_pin", { method: "DELETE", token: OPERATOR })).status).toBe(200);
  });

  it("masks credentials in config but lets the panel set them", async () => {
    const r = (await (
      await call("/api/operator/config", {
        method: "PATCH",
        token: OPERATOR,
        json: { notify: { telegramBotToken: "123456:ABCDEFGHIJKLMNOP", telegramChatId: "42" } },
      })
    ).json()) as { config: { notify: { telegramBotToken: string; telegramChatId: string } } };
    expect(r.config.notify.telegramBotToken).toBe("1234••••MNOP");
    expect(r.config.notify.telegramChatId).toBe("42");
  });

  it("edits the policy ceiling", async () => {
    const r = (await (
      await call("/api/operator/policy", { method: "PUT", token: OPERATOR, json: { mode: "observe" } })
    ).json()) as { policy: { mode: string } };
    expect(r.policy.mode).toBe("observe");
    await call("/api/operator/policy", { method: "PUT", token: OPERATOR, json: { mode: "guarded" } });
    const bad = await call("/api/operator/policy", { method: "PUT", token: OPERATOR, json: { mode: "yolo" } });
    expect(bad.status).toBe(400);
  });

  it("rotates the agent token; the old one stops working at once", async () => {
    const r = (await (await call("/api/operator/tokens/agent", { method: "POST", token: OPERATOR })).json()) as { agentToken: string };
    expect(r.agentToken).toMatch(/^agt_/);
    expect((await call("/devices", { token: AGENT })).status).toBe(401);
    expect((await call("/devices", { token: r.agentToken })).status).toBe(200);
  });
});
