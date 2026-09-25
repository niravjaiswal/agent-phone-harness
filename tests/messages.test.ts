import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectMessages, findOtp, ImapSource, Inbox, parseEmail, parseRelay, parseTelnyx, parseTwilio,
  twilioSignature, verifyRelay, verifyTelnyx, verifyTwilio, WebhookAuthError,
  type InboundMessage, type MessageSource,
} from "../src/core/messages/index.js";

describe("one-time code extraction", () => {
  const cases: [string, string | undefined, number?][] = [
    ["Demo Bank: your verification code is 123456. Do not share it.", "123456"],
    ["G-482913 is your Google verification code.", "482913"],
    ["Your Uber code: 4821. Never share this code.", "4821"],
    ["Order #884213 shipped. Your login code is 552019", "552019"],
    ["Call 555-123-4567 for help. Code: 918273", "918273"],
    ["Your code is 123-456", "123456"],
    ["You paid $1234.56 on 2026", undefined],
    ["Meeting at 2026-09-24", undefined],
    ["Use 7731 to sign in", "7731", 4],
    ["Your one-time code is 30491824", "30491824", 8],
    ["Balance 1,234,567 as of today", undefined],
  ];
  for (const [text, want, digits] of cases) {
    it(`${JSON.stringify(text)} → ${want ?? "nothing"}`, () => {
      expect(findOtp(text, digits ? { digits } : {})).toBe(want);
    });
  }
});

describe("Telnyx webhooks", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
  const body = JSON.stringify({
    data: {
      event_type: "message.received",
      id: "evt-1",
      payload: {
        id: "msg-1",
        text: "Your code is 424242",
        from: { phone_number: "+15551230000" },
        to: [{ phone_number: "+15559990000" }],
        received_at: "2026-09-24T10:00:00Z",
      },
    },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64");

  it("accepts a correctly signed event", () => {
    expect(() => verifyTelnyx(body, { signature: sig, timestamp: ts }, pubB64)).not.toThrow();
    expect(parseTelnyx(body)).toMatchObject({ id: "msg-1", origin: "telnyx", from: "+15551230000", to: "+15559990000" });
  });

  it("rejects a tampered body", () => {
    expect(() => verifyTelnyx(body.replace("424242", "000000"), { signature: sig, timestamp: ts }, pubB64)).toThrow(
      WebhookAuthError,
    );
  });

  it("rejects a replay outside the tolerance window", () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const oldSig = sign(null, Buffer.from(`${old}|${body}`), privateKey).toString("base64");
    expect(() => verifyTelnyx(body, { signature: oldSig, timestamp: old }, pubB64)).toThrow(/tolerance/);
  });

  it("ignores events that are not inbound messages", () => {
    expect(parseTelnyx(JSON.stringify({ data: { event_type: "message.finalized", payload: {} } }))).toBeUndefined();
  });
});

describe("Twilio webhooks", () => {
  const url = "https://phone.example.com/hooks/sms/twilio";
  const params = { MessageSid: "SM1", From: "+15551230000", To: "+15559990000", Body: "Code 919191" };

  it("verifies a signature over the exact URL and sorted params", () => {
    const sig = twilioSignature("authtoken", url, params);
    expect(() => verifyTwilio("authtoken", url, params, sig)).not.toThrow();
    expect(() => verifyTwilio("authtoken", `${url}?x=1`, params, sig)).toThrow(/does not verify/);
    expect(() => verifyTwilio("wrong", url, params, sig)).toThrow(WebhookAuthError);
    expect(() => verifyTwilio("authtoken", url, params, undefined)).toThrow(/missing/);
  });

  it("parses the form fields", () => {
    expect(parseTwilio(params)).toMatchObject({ id: "SM1", origin: "twilio", from: "+15551230000", body: "Code 919191" });
  });
});

describe("relay phone webhooks", () => {
  it("requires the relay token", () => {
    expect(() => verifyRelay("rly_abc", "rly_abc")).not.toThrow();
    expect(() => verifyRelay("rly_abc", "nope")).toThrow(/bad relay token/);
    expect(() => verifyRelay(undefined, "anything")).toThrow(/no relay token/);
  });

  it("accepts the field names common forwarder apps use", () => {
    expect(parseRelay({ from: "+1555", text: "code 1234", sentStamp: 1_758_700_000 })).toMatchObject({
      from: "+1555",
      body: "code 1234",
      timestamp: 1_758_700_000_000,
    });
    expect(parseRelay({ sender: "BANK", message: "hi", timestamp: "2026-09-24T10:00:00Z" }).timestamp).toBe(
      Date.parse("2026-09-24T10:00:00Z"),
    );
  });
});

describe("inbox", () => {
  const fresh = (opts = {}) => new Inbox(join(mkdtempSync(join(tmpdir(), "inbox-")), "inbox.jsonl"), opts);

  it("drops provider retries of the same message", () => {
    const box = fresh();
    const m = { id: "x", origin: "twilio" as const, from: "a", body: "b", timestamp: Date.now() };
    expect(box.add(m)).toBeTruthy();
    expect(box.add(m)).toBeUndefined();
    expect(box.list()).toHaveLength(1);
  });

  it("filters by arrival time and enforces retention", () => {
    const box = fresh({ maxCount: 3 });
    for (let i = 0; i < 10; i++) {
      box.add({ id: String(i), origin: "relay", from: "a", body: String(i), timestamp: 0, receivedAt: Date.now() - (10 - i) * 1000 });
    }
    expect(box.list({ sinceMs: Date.now() - 3500 }).map((m) => m.id)).toEqual(["9", "8", "7"]);
    box.compact();
    expect(box.list({ limit: 100 })).toHaveLength(3);
  });

  it("notifies listeners", () => {
    const box = fresh();
    const seen: string[] = [];
    box.onMessage((m) => seen.push(m.id));
    box.add({ id: "n1", origin: "test", from: "a", body: "b", timestamp: Date.now() });
    expect(seen).toEqual(["n1"]);
  });
});

describe("message hub", () => {
  it("reports a broken source without hiding the others", async () => {
    const good: MessageSource = {
      name: "good",
      read: async () => [{ id: "1", origin: "relay", from: "x", body: "code 111111", timestamp: 0, receivedAt: Date.now() } as InboundMessage],
    };
    const bad: MessageSource = { name: "imap", read: async () => Promise.reject(new Error("auth failed")) };
    const r = await collectMessages([good, bad], { sinceMs: 0, limit: 10 });
    expect(r.messages).toHaveLength(1);
    expect(r.errors).toEqual([{ source: "imap", error: "auth failed" }]);
  });
});

describe("email parsing", () => {
  it("decodes encoded-word subjects and quoted-printable bodies", () => {
    const raw =
      "From: =?UTF-8?B?QWNtZSDinJM=?= <no-reply@acme.test>\r\n" +
      "Subject: =?UTF-8?Q?Your_code_=E2=80=94_778899?=\r\n" +
      "Date: Wed, 24 Sep 2026 10:00:00 +0000\r\n" +
      "Message-ID: <m1@acme.test>\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
      "Hello =E2=80=94 your code is 778899.=\r\nThanks";
    const e = parseEmail(raw);
    expect(e.from).toBe("Acme ✓ <no-reply@acme.test>");
    expect(e.subject).toBe("Your code — 778899");
    expect(e.text).toBe("Hello — your code is 778899.Thanks");
    expect(e.messageId).toBe("<m1@acme.test>");
  });

  it("prefers text/plain in multipart and falls back to stripped HTML", () => {
    const multi =
      'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n' +
      "--b1\r\nContent-Type: text/html\r\n\r\n<p>HTML <b>654321</b></p>\r\n" +
      "--b1\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
      `${Buffer.from("Plain 123456").toString("base64")}\r\n--b1--\r\n`;
    expect(parseEmail(multi).text).toBe("Plain 123456");

    const htmlOnly =
      "Content-Type: text/html\r\n\r\n<style>.x{}</style><div>Your code:&nbsp;<b>246810</b></div><br>Bye &amp; thanks";
    expect(parseEmail(htmlOnly).text).toBe("Your code: 246810\nBye & thanks");
  });
});

/** A scripted IMAP server: enough protocol to prove the client reads without marking anything seen. */
describe("IMAP source", () => {
  let server: Server;
  let port: number;
  const commands: string[] = [];
  const now = new Date();
  const internal = `${now.getUTCDate()}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getUTCMonth()]}-${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")} +0000`;
  const mail = (from: string, subject: string, body: string) =>
    `From: ${from}\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@t>\r\nContent-Type: text/plain\r\n\r\n${body}`;
  const box = [
    mail("Voice <voice-noreply@google.com>", "New text message from (555) 123-0000", "Your Acme code is 313131"),
    mail("News <news@example.com>", "Weekly digest", "nothing to see"),
  ];

  beforeAll(async () => {
    server = createServer((sock: Socket) => {
      sock.write("* OK fake IMAP ready\r\n");
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          commands.push(line);
          const [tag, verb] = line.split(" ");
          if (verb === "LOGIN") {
            sock.write(line.includes('"hunter2"') ? `${tag} OK logged in\r\n` : `${tag} NO bad credentials\r\n`);
          } else if (verb === "EXAMINE") {
            sock.write(`* ${box.length} EXISTS\r\n${tag} OK [READ-ONLY] done\r\n`);
          } else if (verb === "SEARCH") {
            sock.write(`* SEARCH ${box.map((_, n) => n + 1).join(" ")}\r\n${tag} OK\r\n`);
          } else if (verb === "FETCH") {
            for (const [n, m] of box.entries()) {
              sock.write(`* ${n + 1} FETCH (INTERNALDATE "${internal}" BODY[] {${Buffer.byteLength(m)}}\r\n${m})\r\n`);
            }
            sock.write(`${tag} OK\r\n`);
          } else if (verb === "LOGOUT") {
            sock.write(`* BYE\r\n${tag} OK\r\n`);
            sock.end();
          } else {
            sock.write(`${tag} BAD unknown\r\n`);
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it("reads recent mail read-only and filters by sender", async () => {
    const src = new ImapSource(
      { host: "127.0.0.1", port, user: "me@example.com", fromContains: "google.com" },
      () => "hunter2",
      { tls: false, minIntervalMs: 0 },
    );
    const msgs = await src.read({ sinceMs: Date.now() - 3600_000, limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ origin: "imap", subject: "New text message from (555) 123-0000" });
    expect(findOtp(msgs[0]!.body)).toBe("313131");
    expect(commands.some((c) => c.includes("EXAMINE"))).toBe(true);
    expect(commands.some((c) => c.includes("BODY.PEEK[]"))).toBe(true);
    expect(commands.some((c) => /\bSELECT\b/.test(c))).toBe(false);
  });

  it("reports bad credentials without echoing the password", async () => {
    const src = new ImapSource({ host: "127.0.0.1", port, user: "me" }, () => "wrong", { tls: false, minIntervalMs: 0 });
    const e = await src.read({ sinceMs: 0, limit: 5 }).catch((x: Error) => x);
    expect((e as Error).message).toContain("LOGIN failed");
    expect((e as Error).message).not.toContain("wrong");
  });

  it("does not hammer the server between polls", async () => {
    const before = commands.filter((c) => c.includes("LOGIN")).length;
    const src = new ImapSource({ host: "127.0.0.1", port, user: "me" }, () => "hunter2", { tls: false, minIntervalMs: 60_000 });
    await src.read({ sinceMs: Date.now() - 3600_000, limit: 10 });
    await src.read({ sinceMs: Date.now() - 3600_000, limit: 10 });
    expect(commands.filter((c) => c.includes("LOGIN")).length - before).toBe(1);
  });
});
