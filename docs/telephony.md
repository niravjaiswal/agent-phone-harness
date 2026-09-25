# Giving a virtual phone a number

A virtual phone has no SIM. The fix is to receive SMS **somewhere else** and let
the harness read them there — the Android app never sees the SMS; the agent reads
the code and types it (or `phone_wait_for_otp` with `enter:true` types it for it).

```
service ──SMS──▶ number (Telnyx / Twilio / relay phone / Google Voice)
                    │ webhook or email
                    ▼
               agent-phone inbox ──▶ phone_wait_for_otp ──▶ typed into the app
```

This works for any code delivered by SMS or email. It does **not** work for apps that
bind to the SIM itself (some banking apps send an SMS *from* the device to verify it),
or for carrier "silent" verification.

## Options

| Option | Cost | Line type | Trade-off |
|---|---|---|---|
| **Telnyx** | ~$1/month + ~$0.004 per SMS + carrier fees | VoIP | Cheapest programmable number. Some senders reject VoIP. |
| **Twilio** | ~$1.15/month + ~$0.008 per SMS + carrier fees | VoIP | Same idea, bigger ecosystem. Short-code senders (5–6 digit) need a support ticket to enable, and still aren't guaranteed. |
| **Relay phone** | prepaid SIM ~$3–10/month + a spare Android | real mobile | Passes line-type checks and receives short codes. One more box to keep powered. |
| **Google Voice** | free (US) | VoIP | Needs an existing US number to claim. Read over IMAP via Gmail forwarding. |
| **Test messages** | free | — | Panel → *Send a test code*, or `agent-phone inbox add "code 123456"`. For trying the flow. |

**Start with Telnyx.** Test the exact services you care about on day one — a sender that
rejects VoIP will do so immediately. For the ones that do, add a relay phone.

> **Do not use SMS-activation rental sites.** Their numbers are recycled; the next renter
> receives your codes. That is account takeover waiting to happen.
>
> **Never let a number lapse.** A released number is reassigned, and whoever gets it can
> reset every account tied to it. Keep auto-renew on.

After connecting a number, set it in the panel (Setup → Identity → Phone number) so the
agent knows what to type when a form asks for one.

## Telnyx

1. Buy a number (Numbers → Search & Buy).
2. Messaging → Messaging Profiles → create one. Inbound webhook URL:
   `https://<your-host>/hooks/sms/telnyx` (the panel shows the exact URL).
3. Assign the number to that profile.
4. Copy your **public key** (Account Settings → Keys & Credentials → Public Key) into
   panel → Setup → Telnyx public key. Every webhook is checked against it (Ed25519, with a
   5-minute replay window); unsigned or stale requests are rejected.

## Twilio

1. Buy a number with SMS capability.
2. Phone Numbers → Manage → Active numbers → your number → Messaging configuration →
   *A message comes in*: Webhook, HTTP POST, `https://<your-host>/hooks/sms/twilio`.
3. Paste your **Auth Token** (Console → Account Info) into panel → Setup → Twilio auth token.

Twilio signs the exact URL it called. If you use a quick tunnel, its URL changes on restart;
update the webhook, or use a [permanent address](hosting.md#a-permanent-address).

## Relay phone

A spare Android phone with a real prepaid SIM, running any SMS-forwarder app that can POST to
a URL (several open-source ones exist; search F-Droid for "SMS forwarder").

- URL: `https://<your-host>/hooks/sms/relay`
- Auth: header `Authorization: Bearer <relay token>`, or `?token=<relay token>` if the app
  cannot set headers. Create the token in panel → Setup (it is separate from the agent and
  operator tokens and can only deliver messages).
- Body: JSON or form fields. Accepted names: sender as `from`, `sender`, `phone`, `number`
  or `address`; text as `body`, `text`, `message` or `content`; optional time as `timestamp`,
  `receivedStamp` or `sentStamp` (seconds or milliseconds).

```bash
curl -X POST https://<your-host>/hooks/sms/relay \
  -H "Authorization: Bearer rly_…" -H 'content-type: application/json' \
  -d '{"from":"+15551230000","text":"Your code is 123456"}'
```

## Google Voice and email codes (IMAP)

The same source reads verification **emails** — many signups send codes by email.

1. For Google Voice: Voice settings → Messages → *Forward messages to email*.
2. In Gmail, turn on 2-Step Verification and create an **app password**.
3. Panel → Setup → Email codes: host `imap.gmail.com`, your address, the app password,
   and optionally *Only senders containing* `voice.google.com`.
4. *Test connection*.

Reading is read-only (`EXAMINE` + `BODY.PEEK`): nothing in your mailbox is marked as read.
The mailbox is checked at most every 8 seconds while an agent waits for a code.

## For tests: the emulator's own SMS

An `agent-phone up` emulator accepts injected messages, which land in its real SMS inbox:

```bash
adb -s emulator-5554 emu sms send 5551234 "Your code is 123456"
```

(redroid containers have no emulator console; use the relay endpoint or a test message.)
