import { mkdtempSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/core/approvals.js";
import { Auth, crossOrigin, loopbackHost } from "../src/http/auth.js";
import { clientIp } from "../src/http/util.js";

const req = (peer: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

describe("client address", () => {
  it("believes forwarded headers only from our own tunnel or a sibling container", () => {
    expect(clientIp(req("172.18.0.4", { "x-forwarded-for": "203.0.113.9, 172.18.0.4" }))).toBe("203.0.113.9");
    expect(clientIp(req("127.0.0.1", { "cf-connecting-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(req("203.0.113.50", { "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.50");
  });
});

describe("login throttling", () => {
  it("is per visitor, so an attacker behind the tunnel cannot lock the operator out", () => {
    const auth = new Auth({ agentToken: "a-token-1", operatorToken: "o-token-2", cookieSecret: "k" });
    const attacker = req("172.18.0.4", { "x-forwarded-for": "203.0.113.9" });
    const operator = req("172.18.0.4", { "x-forwarded-for": "198.51.100.1" });
    for (let i = 0; i < 12; i++) auth.recordFailure(attacker);
    expect(auth.throttled(attacker)).toBe(true);
    expect(auth.throttled(operator)).toBe(false);
  });
});

describe("cookies", () => {
  it("round-trip, and die when the operator token rotates", () => {
    const a = new Auth({ agentToken: "a-token-1", operatorToken: "o-token-2", cookieSecret: "k" });
    const c = a.issueCookie();
    expect(a.identify(req("127.0.0.1", { cookie: `ap_op=${encodeURIComponent(c)}` })).principal).toBe("operator");
    const rotated = new Auth({ agentToken: "a-token-1", operatorToken: "o-token-3", cookieSecret: "k" });
    expect(rotated.identify(req("127.0.0.1", { cookie: `ap_op=${encodeURIComponent(c)}` })).principal).toBe("none");
  });

  it("expire", () => {
    const a = new Auth({ agentToken: "a1-token", operatorToken: "o1-token", cookieSecret: "k", cookieTtlMs: -1 });
    expect(a.identify(req("127.0.0.1", { cookie: `ap_op=${encodeURIComponent(a.issueCookie())}` })).principal).toBe("none");
  });
});

describe("origin and host checks", () => {
  it("flags cross-origin and opaque origins", () => {
    expect(crossOrigin(req("127.0.0.1", { host: "phone.example.com", origin: "https://phone.example.com" }))).toBe(false);
    expect(crossOrigin(req("127.0.0.1", { host: "phone.example.com", origin: "https://evil.example" }))).toBe(true);
    expect(crossOrigin(req("127.0.0.1", { host: "phone.example.com", origin: "null" }))).toBe(true);
    expect(crossOrigin(req("127.0.0.1", { host: "phone.example.com" }))).toBe(false);
  });

  it("accepts only loopback Host headers in no-auth mode (DNS rebinding)", () => {
    expect(loopbackHost(req("127.0.0.1", { host: "127.0.0.1:8712" }))).toBe(true);
    expect(loopbackHost(req("127.0.0.1", { host: "localhost:8712" }))).toBe(true);
    expect(loopbackHost(req("127.0.0.1", { host: "rebind.evil.example:8712" }))).toBe(false);
  });
});

describe("approval history", () => {
  it("prunes old decisions but never a pending request", () => {
    const store = new ApprovalStore(mkdtempSync(join(tmpdir(), "prune-")), false);
    const action = { kind: "tap" as const, targetText: "Pay" };
    const old = store.create({ sessionId: "s1", action, summary: "a", reason: "r" });
    store.decide(old.id, true);
    const pending = store.create({ sessionId: "s1", action, summary: "b", reason: "r" });
    const removed = store.prune(1000, Date.now() + 10_000);
    expect(removed).toBe(1);
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(pending.id)?.status).toBe("pending");
  });
});
