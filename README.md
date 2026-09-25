# agent-phone-harness

Give an AI agent its own phone — no hardware required.

A virtual Android phone your agent drives by reading its screen as text, plus the parts that make
real tasks finish: **a phone number for 2FA codes**, **your approval for anything risky, from your
own phone**, a way for the agent to **ask you for a hand**, and a record of everything it did.
Works with agents that run on your machine (Claude Code, Cursor — over MCP) and agents that run in
the cloud and cannot install anything (Instinct — over HTTPS).

```bash
npx -y github:niravjaiswal/agent-phone-harness demo
```

A minute, nothing to set up, no phone: a full task on a simulated device — sign in, read an SMS code,
try to send money, get stopped for approval, hit the things the harness refuses outright.

---

## Pick your path

**Your agent runs on your machine** (Claude Code, Cursor, your own loop):

```bash
brew install --cask android-commandlinetools          # Linux: `agent-phone doctor` prints the recipe
npm install -g github:niravjaiswal/agent-phone-harness
agent-phone up                                         # a headless Android phone, ~1.5 GB first time
```

```json
{ "mcpServers": { "phone": { "command": "agent-phone", "args": ["mcp"] } } }
```

**Your agent runs in the cloud** (Instinct, hosted agents) — it needs an address, not a process:

```bash
agent-phone up && agent-phone serve --public           # on your Mac; needs `brew install cloudflared`
# or, on any Ubuntu VM, always on:
curl -fsSL https://raw.githubusercontent.com/niravjaiswal/agent-phone-harness/main/deploy/install.sh | bash
```

Both print an operator-panel sign-in link and a block to paste into your agent.
Walkthrough: **[docs/instinct.md](docs/instinct.md)** · Hosting: **[docs/hosting.md](docs/hosting.md)**

---

## What an agent actually sees

Accessibility tree first, screenshots on demand. A screen costs ~1–3k characters instead of an image:

```
Screen: com.example.bank / .LoginActivity (1080x2340 portrait)
e1 Text "Welcome back"
  e2 TextField label="Email address" value="ada@example.com" id=email [focused] @540,470
  e3 TextField label="Password" id=password [password] @540,670
  e5 Button "Sign in" id=signin @540,1010
```

Every action returns the **resulting** screen, so there is no act → observe round trip:

```
✓ tap → Button "Sign in"
screen: com.example.bank/.LoginActivity → com.example.bank/.OtpActivity, +4 elements, -6 elements
```

Target by **selector** (`{"text":"Continue"}`, `{"label":"Email"}`, `{"id":"signin"}`), re-resolved
against the live screen every time, or by **ref** (`e5`), revalidated before the tap fires. Ambiguous
matches are an error, not a coin flip — mis-tapping a duplicate label is how money goes to the wrong person.

---

## The operator panel

`/panel/` on the server. Built for your phone, since that is where approval requests reach you.

| Tab | |
|---|---|
| **Phone** | Live screen. *Take control* pauses the agent and lets you tap, swipe and type — sign in to Google, solve a CAPTCHA — then *Hand back*. Install an app from its APK. |
| **Approvals** | What the agent was stopped from doing, with the screen at that moment. Approve, deny, or leave a note. Requests for help land here too. |
| **Activity** | Every session and every action, with screenshots. What you did in the panel, too (never what you typed). |
| **Connect agent** | The MCP URL, the agent token, and a paste-ready block for browsing agents. |
| **Setup** | Phone number and SMS webhooks, email codes, notifications (ntfy, Telegram, Slack, webhook), secrets, and what the agent is allowed to do. |

Sign in with a one-time link (`agent-phone panel-link`) or the operator token.

---

## A number for 2FA

A virtual phone has no SIM, so SMS codes are received elsewhere and read by the harness:

| | Cost | |
|---|---|---|
| **Telnyx** or **Twilio** number | ~$1/month | webhook, signature-verified |
| **Relay phone** — spare Android + prepaid SIM | ~$3–10/month | passes "no VoIP" checks, gets short codes |
| **Google Voice / email** over IMAP | free | also catches emailed codes |

```
phone_wait_for_otp {"enter": true, "selector": {"label": "Verification code"}}
→ code from +15550001111 (telnyx) entered
```

With `enter:true` the code is typed for the agent and never returned to it — and hidden where the field
echoes it back. Setup: **[docs/telephony.md](docs/telephony.md)**.

---

## When the agent needs you

**Risky actions wait for you.** Tapping *Pay*, *Send*, *Transfer*, *Delete*, *Confirm*, *Subscribe*…
stops the action and notifies you with a link. Approve from your phone; the agent carries on. Neither the
agent's tools nor its token can approve anything.

**The agent can ask for a hand.** A CAPTCHA, a Google sign-in, a "verify it's you" screen:

```
phone_request_human {"reason": "Solve the CAPTCHA on the sign-up screen"}
→ pending — the owner has been notified (handoffId 3f9c21aa)
…
→ done — the human finished. Observe the screen before continuing.
```

**You can take over any time.** While you have control, the agent's actions fail with `device_busy`.

---

## What a virtual phone cannot do

| Limit | Consequence | Workaround |
|---|---|---|
| **No SIM** | Codes sent by SMS never reach it on their own. | Connect a number ([telephony.md](docs/telephony.md)). Apps that bind to the SIM itself still will not work. |
| **Play Integrity** | Apps that check device integrity refuse to run — most banking, some fintech, government ID. | A physical Android phone; the harness drives it identically. |
| **No Play Store** (container phone) | Apps must be installed from their APK. | Panel → *Install an app*, or use `agent-phone up`, whose image has the Play Store. |

Retail, delivery, travel, social and productivity apps are generally fine.
**[docs/compatibility.md](docs/compatibility.md)** collects reports.

---

## Tools

| Tool | Notes |
|---|---|
| `phone_session_start` / `_status` / `_end` | one task, one phone; tells the agent its number and email |
| `phone_observe` | element tree with refs — the cheap, precise way to see |
| `phone_screenshot` | password fields and typed secrets blacked out; `marks:true` numbers the targets |
| `phone_tap`, `phone_type`, `phone_key`, `phone_swipe`, `phone_scroll`, `phone_clear_text` | input |
| `phone_batch` | **several actions in one call — the biggest saving available** |
| `phone_type_secret` | types a stored secret; the value never enters the agent's context |
| `phone_wait_for_otp` | a code from SMS, a connected number, email or a notification; `enter:true` types it |
| `phone_request_human` | hand off to the owner and wait |
| `phone_wait_for` | wait for something to appear or disappear |
| `phone_open_app`, `phone_stop_app`, `phone_list_apps` | apps |
| `phone_open_url`, `phone_list_deep_links` | a declared URL often replaces a whole tap sequence |
| `phone_read_sms`, `phone_read_notifications`, `phone_clipboard` | side channels |
| `phone_install_app`, `phone_clear_app_data`, `phone_shell` | privileged; off unless the policy allows |
| `phone_list_devices`, `phone_list_secrets` | discovery |

### HTTP

The server behind `agent-phone serve` and the container stack. Agents that cannot use MCP read
**`/agent.md`** and use REST; add `?format=text` to get the same compact screens MCP returns.

| Route | Who | |
|---|---|---|
| `POST /mcp` | agent | MCP over streamable HTTP; each connection owns its sessions |
| `POST /sessions`, `POST /sessions/:id/<action>`, `DELETE /sessions/:id` | agent | `tap`, `type`, `batch`, `wait_for_otp`, `request_human`, … |
| `GET /sessions/:id/screenshot` | agent | PNG |
| `GET /agent.md` | anyone | instructions an agent can follow on its own; no credentials in it |
| `/panel/`, `/api/operator/*`, `/events` | operator | panel, approvals, takeover, secrets, config, live events |
| `POST /hooks/sms/{telnyx,twilio,relay}` | provider | signature- or token-verified inbound SMS |

Two tokens: the **agent token** (safe to give an agent) and the **operator token** (never). The server
refuses to start if they match and refuses the operator token on agent routes.

### From TypeScript

```ts
import { Harness } from "agent-phone-harness";

const harness = new Harness();
const session = await harness.createSession({ policy: { allowedApps: ["com.example.bank"] } });

await session.batch([
  { action: "open_app", appId: "com.example.bank" },
  { action: "type", selector: { label: "Email address" }, text: "ada@example.com" },
  { action: "type_secret", selector: { label: "Password" }, key: "bank_password" },
  { action: "tap", selector: { text: "Sign in" } },
]);
await session.waitForOtp({ enter: true, target: { selector: { label: "Verification code" } } });
const result = await session.tap({ selector: { text: "Verify" } });
console.log(result.screen.elements);
await harness.close(session.id);
```

---

## Driving it efficiently

**Batch what you can predict.** `phone_batch` runs a login form in one call, re-resolving each step's
selector against a fresh screen, stopping at the first failure with exactly what ran. On the demo login:

| | agent turns | device dumps | screen chars returned |
|---|---|---|---|
| one call per action | 4 | 12 | 2149 |
| batched, adaptive rendering | **1** | **7** | **460** |

Every step still passes through policy, so a gated step halts the batch and hands back its `approvalId`.

**Settle work matches the action.** Typing into a focused field costs one dump; a tap that might navigate
gets a stability check; launching an app gets the long timeout.

**The screen is not re-sent when the agent already has it.** Unchanged → one line; a small change → just
the changed elements; navigation → the whole tree.

**An empty accessibility tree** (Flutter, canvas, games) is detected and a screenshot is attached, instead
of an empty screen and a guess.

---

## Safety model

The harness assumes the model is **not** trusted with irreversible actions, and that anything it reads may
be trying to steer it. Full model: **[SECURITY.md](SECURITY.md)**.

- **Modes**: `observe` (read-only) · `guarded` (default: risky actions need you) · `autonomous` (sandbox
  phones only).
- **The policy is a ceiling.** `~/.agent-phone/policy.json` (or panel → Setup) caps every session. An agent
  may ask for less — `allowedApps` to scope itself to one app — never more.
- **Bright lines**, refused even with approval: typing or pasting payment card numbers (Luhn-checked) or
  government ID numbers; apps in `blockedApps` (Settings by default). The harness does not solve CAPTCHAs,
  defeat attestation or spoof device identity.
- **Secrets** are referenced by name, never returned, never logged, and scrubbed from screen trees,
  errors and screenshots — including when typed into a field that echoes them.
- **Budgets**: max actions and minutes per session. Idle sessions release the phone after 20 minutes.
- **An action that happened is never reported as failed.** If the screen cannot be read afterwards the
  result says so and tells the agent not to retry — retrying a completed payment is worse than a blind spot.
- **Everything is recorded**: `agent-phone trace <id>` or panel → Activity.

Use dedicated accounts, not your personal ones. Automating third-party apps may breach their terms of
service — that is the operator's call to make deliberately, per app.

---

## Physical devices and iOS

Everything above works unchanged on a real Android phone — the escape hatch for apps that refuse virtual ones.

```bash
brew install --cask android-platform-tools
adb devices                           # accept the USB-debugging prompt
adb tcpip 5555 && agent-phone connect 100.83.1.4:5555    # optional: over the network
adb shell pm grant com.android.shell android.permission.READ_SMS   # optional: SMS on the device
```

Non-ASCII typing needs [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) and `PHONE_ADB_KEYBOARD=1`.

**iOS**: `simctl`/`devicectl` cover lifecycle, screenshots and deep links; touch and perception need
[WebDriverAgent](https://github.com/appium/WebDriverAgent) (`PHONE_WDA_URL`, default
`http://127.0.0.1:8100`). Without it the harness says plainly what is unavailable.

---

## CLI

```bash
agent-phone up | down | destroy        # the virtual phone
agent-phone serve [--public]           # panel + MCP + REST + webhooks
agent-phone mcp                        # MCP on stdio
agent-phone panel-link | token | connect-info
agent-phone approvals | approve <id> | deny <id>
agent-phone secret set <name> | secret list
agent-phone identity --number +15551234567 --email me@example.com
agent-phone inbox | inbox add "code 123456" | notify-test
agent-phone observe | tap --text Continue | type "hello" | otp | trace <id>
agent-phone doctor | devices | demo
```

Environment variables for everything are listed in [docs/hosting.md](docs/hosting.md#configuration);
`PHONE_HOME` (default `~/.agent-phone`) holds tokens, secrets, approvals and traces.

---

## Development

```bash
npm install          # builds too
npm test             # ~260 tests, no device needed
npm run dev -- serve --mock      # the panel against the simulated phone
npm run e2e:android  # against a real emulator or phone
```

CI runs the suite on Node 20 and 22, builds and smoke-tests the container image, and runs the end-to-end
check on real Android 11 and 14 emulators. See [CONTRIBUTING.md](CONTRIBUTING.md).

To add a backend (a device farm, Waydroid), implement `Device` and `DeviceProvider` and register it in
`Harness`; nothing above the provider layer changes.

## Roadmap

- **Compatibility matrix** from real reports ([docs/compatibility.md](docs/compatibility.md))
- **Hosted multi-tenant service** — per-tenant isolation and billing, for people who do not want a VM
- **Resident on-device observer** — push-based screen updates instead of polling
- **iOS in the container path**, as far as Apple's tooling allows

## License

[Apache-2.0](LICENSE). Contributions are accepted under the same terms.
