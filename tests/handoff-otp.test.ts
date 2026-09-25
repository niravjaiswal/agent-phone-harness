import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/core/approvals.js";
import { DeviceSmsSource, Inbox, NotificationSource } from "../src/core/messages/index.js";
import { notifyOperator } from "../src/core/notify.js";
import { SecretStore } from "../src/core/secrets.js";
import { Session } from "../src/core/session.js";
import { MockDevice } from "../src/providers/mock/index.js";

const BANK = "com.example.demobank";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function setup(opts: { inbox?: Inbox; approvals?: ApprovalStore } = {}) {
  const device = new MockDevice(`mock:${Math.random().toString(36).slice(2)}`);
  process.env.PHONE_SECRET_HANDOFF_PIN = "8675309";
  const secretStore = new SecretStore("/nonexistent.json");
  const approvalStore = opts.approvals ?? new ApprovalStore(tmp("approvals-"), false);
  const inbox = opts.inbox;
  const session = new Session(device, {
    policy: { allowedApps: [BANK, "com.mock.launcher", "com.mock.messages"] },
    secretStore,
    approvalStore,
    approvalWaitMs: 400,
    messageSources: (d) => (inbox ? [inbox] : [new DeviceSmsSource(d), new NotificationSource(d)]),
  });
  return { device, session, approvalStore };
}

async function toVerifyScreen(session: Session) {
  await session.openApp(BANK);
  await session.type("ada@example.com", { target: { selector: { label: "Username" } } });
  await session.typeSecret("handoff_pin", { target: { selector: { label: "Password" } } });
  await session.tap({ selector: { text: "Sign in" } });
}

describe("one-time codes from outside the device", () => {
  it("finds a code a webhook dropped in the inbox after the wait began", async () => {
    const inbox = new Inbox(join(tmp("inbox-"), "inbox.jsonl"));
    const { session } = setup({ inbox });
    setTimeout(() => {
      inbox.add({ id: "tw-1", origin: "twilio", from: "+15550001111", body: "Acme: 902211 is your code", timestamp: Date.now() });
    }, 300);
    const r = await session.waitForOtp({ timeoutMs: 5000, pollMs: 100 });
    expect(r.code).toBe("902211");
    expect(r.message.origin).toBe("twilio");
  });

  it("says which sources it checked when nothing arrives", async () => {
    const inbox = new Inbox(join(tmp("inbox-"), "inbox.jsonl"));
    const { session } = setup({ inbox });
    const e = await session.waitForOtp({ timeoutMs: 300, pollMs: 100 }).catch((x) => x);
    expect(e.code).toBe("timeout");
    expect(e.hint).toContain("Checked: inbox");
  });
});

describe("entering a code for the agent", () => {
  it("types the code without returning it, and hides it in the resulting tree", async () => {
    const { session, device } = setup();
    await toVerifyScreen(session);
    const r = await session.waitForOtp({
      enter: true,
      target: { selector: { label: "Verification code" } },
      timeoutMs: 5000,
      pollMs: 100,
    });
    expect(r.entered).toBe(true);
    expect(r.code).toBeUndefined();
    const code = device.expectedOtp;
    expect(JSON.stringify(r.result)).not.toContain(code);
    expect(r.result!.target).toContain("6-digit code");

    // And it worked: the code on the device is the one that was sent.
    const verified = await session.tap({ selector: { text: "Verify" } });
    expect(verified.change).toContain("HomeActivity");

    const trace = readFileSync(session.audit.tracePath, "utf8");
    expect(trace).not.toContain(code);
  });
});

describe("secrets in ordinary fields", () => {
  it("never come back in the screen tree", async () => {
    const { session } = setup();
    await session.openApp(BANK);
    // A PIN typed into a plain (non-password) field is echoed as the field's text.
    const r = await session.typeSecret("handoff_pin", { target: { selector: { label: "Username" } } });
    expect(JSON.stringify(r)).not.toContain("8675309");
    const view = session.view(await session.observe());
    expect(view.elements).not.toContain("8675309");
    expect(view.elements).toContain("«secret:handoff_pin»");
  });
});

describe("clipboard", () => {
  it("is policy-checked: a card number cannot be smuggled in through paste", async () => {
    const { session } = setup();
    await expect(session.clipboard("set", "4111 1111 1111 1111")).rejects.toMatchObject({ code: "policy_denied" });
    await expect(session.clipboard("set", "hello")).resolves.toBe("clipboard set");
    await expect(session.clipboard("get")).resolves.toBe("hello");
  });
});

describe("asking for a human", () => {
  it("returns pending, then done once the operator hands back", async () => {
    const approvals = new ApprovalStore(tmp("approvals-"), false);
    const { session } = setup({ approvals });
    const first = await session.requestHuman("Solve the CAPTCHA on the sign-up screen", { waitMs: 200 });
    expect(first.status).toBe("pending");

    const req = approvals.get(first.id)!;
    expect(req.type).toBe("handoff");
    expect(req.reason).toContain("CAPTCHA");

    setTimeout(() => approvals.decide(first.id, true, "nirav", "solved it"), 150);
    const second = await session.requestHuman("", { handoffId: first.id, waitMs: 3000 });
    expect(second).toMatchObject({ status: "done", note: "solved it" });
  });

  it("reports a decline", async () => {
    const approvals = new ApprovalStore(tmp("approvals-"), false);
    const { session } = setup({ approvals });
    setTimeout(() => {
      const p = approvals.list({ pendingOnly: true })[0]!;
      approvals.decide(p.id, false, "nirav", "not doing that");
    }, 150);
    expect(await session.requestHuman("Approve the Face ID prompt", { waitMs: 3000 })).toMatchObject({ status: "declined" });
  });

  it("will not resume someone else's handoff", async () => {
    const approvals = new ApprovalStore(tmp("approvals-"), false);
    const a = setup({ approvals });
    const b = setup({ approvals });
    const r = await a.session.requestHuman("help", { waitMs: 50 });
    await expect(b.session.requestHuman("", { handoffId: r.id, waitMs: 50 })).rejects.toThrow(/No handoff/);
  });
});

describe("operator notifications", () => {
  it("fans out to every configured channel with a panel link and no secrets", async () => {
    const hits: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ path: req.url ?? "", headers: req.headers, body });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    const results = await notifyOperator(
      { kind: "approval", id: "ab12cd34", title: "Approval needed", body: "tap: Send money", path: "/panel/#/approvals/ab12cd34" },
      {
        publicUrl: "https://phone.example.com",
        identity: {},
        sources: {},
        notify: { ntfyUrl: `${base}/topic`, slackWebhook: `${base}/slack`, webhook: `${base}/hook` },
      },
    );
    srv.close();

    expect(results.every((r) => r.ok)).toBe(true);
    const ntfy = hits.find((h) => h.path === "/topic")!;
    expect(ntfy.headers.click).toBe("https://phone.example.com/panel/#/approvals/ab12cd34");
    expect(ntfy.headers.priority).toBe("high");
    expect(JSON.parse(hits.find((h) => h.path === "/slack")!.body).text).toContain("Send money");
    expect(JSON.parse(hits.find((h) => h.path === "/hook")!.body)).toMatchObject({
      type: "approval_required",
      id: "ab12cd34",
      link: "https://phone.example.com/panel/#/approvals/ab12cd34",
    });
  });

  it("reports a failing channel instead of throwing", async () => {
    const results = await notifyOperator(
      { kind: "test", title: "t", body: "b" },
      { identity: {}, sources: {}, notify: { webhook: "http://127.0.0.1:1/nothing" } },
    );
    expect(results).toEqual([expect.objectContaining({ channel: "webhook", ok: false })]);
  });
});

describe("ending a session", () => {
  it("expires the approvals and handoffs it left pending", async () => {
    const approvals = new ApprovalStore(tmp("approvals-"), false);
    const { session } = setup({ approvals });
    const r = await session.requestHuman("help", { waitMs: 50 });
    expect(approvals.get(r.id)!.status).toBe("pending");
    await session.close();
    expect(approvals.get(r.id)).toMatchObject({ status: "expired", note: "session ended" });
  });
});
