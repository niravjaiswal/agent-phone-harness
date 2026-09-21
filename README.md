# agent-phone-harness

Give an agent its own phone — no hardware required.

A uniform perception/action harness over a **virtual Android phone**, physical Android devices and iOS,
exposed via **MCP**, **HTTP/SSE** and a **CLI**, so a tool-using agent (Instinct, Claude Code, your own
loop) can finish tasks that only exist on a mobile device, end to end, without a human stepping in.

```bash
npx -y agent-phone-harness demo
```

Sixty seconds, nothing installed, no phone. Runs a full task on a simulated device: log in, collect an SMS
one-time code, attempt a money transfer that gets stopped for human approval, and hit the things the
harness refuses outright.

---

## Why

Agents stall on a specific class of task: app-only services, SMS and push one-time codes, device-bound
2FA, anything gated behind a mobile client. Web automation cannot reach these, so a human takes over and
the end-to-end property is lost.

This harness gives the agent a phone — by default a **virtual** one it creates on your machine in one
command — plus the mobile-specific side channels (SMS, notifications, deep links) that make those flows
tractable.

Design rationale and the options weighed: [`.claude/docs/agent-phone-harness-design.md`](.claude/docs/agent-phone-harness-design.md).

---

## What an agent actually sees

Perception is **accessibility-tree first**, screenshots on demand. A screen costs ~1-3k characters instead
of a 40-80k-character raw dump or an expensive image:

```
Screen: com.example.bank / .LoginActivity (1080x2340 portrait)
e1 Text "Welcome back"
  e2 TextField label="Email address" value="ada@example.com" id=email [focused] @540,470
  e3 TextField label="Password" id=password [password] @540,670
  e4 Switch label="Remember this device" id=remember [checked] @966,840
  e5 Button "Sign in" id=signin @540,1010
  e6 Text "Forgot password?" [clickable] @274,1155
```

Every mutating tool returns the **resulting** screen plus a change summary, so there is no act → observe →
observe round-trip:

```
✓ tap → e5 Button "Sign in"
screen: com.example.bank/.LoginActivity → com.example.bank/.OtpActivity, +4 elements, -6 elements
```

Target elements by **selector** (`{"text":"Continue"}`, `{"id":"signin"}`, `{"role":"TextField","index":1}`),
re-resolved at action time so it survives re-renders, or by **ref** (`e5`), revalidated by identity before
the tap fires. Ambiguous matches are an error, not a coin flip — mis-tapping a duplicate label is how money
goes to the wrong person.

---

## Quickstart

### 1. Give the agent a phone

```bash
brew install --cask android-commandlinetools    # macOS; Linux recipe printed by `doctor`
npx -y agent-phone-harness up
```

```
  installing platform-tools, emulator, system-images;android-34;google_apis_playstore;arm64-v8a
  — the system image is ~1.5 GB, this takes a few minutes
  creating virtual device "agent-phone"
  booting emulator-5554 (headless)
  waiting for Android to finish booting (first boot is slow)
  ready: android:emulator-5554
```

There is now an Android phone running as a background process. No window, no handset, no SIM, no cable.

```bash
agent-phone down        # stop it; state is preserved
agent-phone up          # bring it back, still logged into everything
agent-phone destroy     # delete it and all its state
agent-phone up --window # boot it visible, to set something up by hand
```

**State persists**, which is the whole point of a long-lived virtual phone: install your target app and log
in once, and every later task skips the login.

On Linux, or to run several phones on one box, use containers instead — no SDK on the host:

```bash
docker compose -f docker/compose.yml up -d && adb connect localhost:5555
```

### 2. Put your app on it

A fresh emulator is a blank phone. Either sideload, which avoids all Google friction:

```bash
adb -s emulator-5554 install ~/Downloads/target-app.apk
```

…or `agent-phone up --window`, sign into a Google account made for this, and install from the Play Store.

### 3. Point your agent at it

```json
{
  "mcpServers": {
    "phone": {
      "command": "npx",
      "args": ["-y", "agent-phone-harness", "mcp"]
    }
  }
}
```

If your agent runs hosted rather than on your machine, it cannot spawn a local process. Run the harness as
a server next to the phone instead, and point the agent at `https://your-host:8712/mcp`:

```bash
PHONE_API_TOKEN=$(openssl rand -hex 16) agent-phone serve --host 0.0.0.0
```

### 4. Store any passwords

```bash
agent-phone secret set target_app_password     # reads stdin, never shell history
```

The agent can ask the harness to *type* a secret. It can never read one back, and values are scrubbed from
every trace line and error message.

---

## What a virtual phone cannot do

Two real limits. Know them before you build on this.

| Limit | Consequence | Workaround |
|---|---|---|
| **No SIM** | No phone number, so a real sender's SMS code never arrives. `adb emu sms send` injects messages, which covers testing but not a real bank. | Telephony is a service, not hardware: a programmable number (Twilio/Telnyx, ~$1/mo) or IMAP email-OTP can feed the same `phone_wait_for_otp`. Not yet built — see the roadmap. |
| **Play Integrity** | Apps calling the attestation API see device integrity fail. Most banking, some fintech and gov apps hard-refuse. | None. This is the only reason the physical path exists. |

Retail, delivery, SaaS, social, productivity and most utility apps are unaffected.

---

## Physical devices

The escape hatch for attestation-gated apps. Everything above works unchanged — a handset and an emulator
are both just adb devices.

```bash
brew install --cask android-platform-tools
adb devices                    # accept the USB-debugging prompt on the phone
agent-phone doctor
```

Over the network, so the phone can sit on a shelf anywhere reachable:

```bash
adb tcpip 5555                 # once, over USB
agent-phone connect 100.83.1.4:5555
```

Optional one-time grant, which enables `phone_read_sms`:

```bash
adb shell pm grant com.android.shell android.permission.READ_SMS
```

Non-ASCII input needs [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) installed and selected, then
`PHONE_ADB_KEYBOARD=1`. Without it the harness refuses non-ASCII rather than typing garbage.

## iOS

`simctl` (simulators) and `devicectl` (physical devices) ship with Xcode and cover lifecycle, screenshots
and deep links. **Touch and perception need WebDriverAgent**, which is genuinely more work than Android:

```bash
# Simulator: run the WebDriverAgentRunner test target from Xcode, or
xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test

# Physical device: run WDA on the device, then forward the port
iproxy 8100 8100
```

Then `PHONE_WDA_URL=http://127.0.0.1:8100` (the default). Without WDA the harness still lists devices,
launches apps, opens deep links and takes screenshots — and says plainly that tapping and observing are
unavailable, rather than failing obscurely.

---

## Tools

| Tool | Notes |
|---|---|
| `phone_list_devices` | virtual, physical Android (USB/TCP), iOS (sim + device), mock |
| `phone_session_start` / `_status` / `_end` | scopes policy, budgets and the audit trail |
| `phone_observe` | element tree with refs — the cheap, precise way to see |
| `phone_screenshot` | password fields blacked out; `marks:true` for numbered boxes |
| `phone_tap`, `phone_type`, `phone_key`, `phone_swipe`, `phone_scroll`, `phone_clear_text` | input |
| `phone_batch` | **several actions in one call — the single biggest saving available** |
| `phone_type_secret` | types a stored secret; the value never enters your context |
| `phone_wait_for` | wait for something to appear or disappear |
| `phone_open_app`, `phone_stop_app`, `phone_list_apps` | app lifecycle |
| `phone_open_url`, `phone_list_deep_links` | a declared URL often replaces a whole tap sequence |
| `phone_read_sms`, `phone_read_notifications`, `phone_wait_for_otp` | the 2FA unblocker |
| `phone_clipboard` | paste long or non-ASCII text |
| `phone_install_app`, `phone_clear_app_data`, `phone_shell` | privileged; off unless the policy allows |

No tool can approve a gated action. That path is operator-only, by construction.

### Using it from TypeScript

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

const { code } = await session.waitForOtp({ digits: 6 });
await session.type(code, { target: { selector: { label: "Verification code" } } });
const result = await session.tap({ selector: { text: "Verify" } });

console.log(result.screen.elements);
await harness.close(session.id);
```

### REST, SSE and MCP over HTTP

| Endpoint | What |
|---|---|
| `POST /mcp` | the same MCP tool surface, streamable HTTP |
| `GET /devices`, `GET /doctor` | discovery |
| `POST /sessions` | open a session → `{sessionId, screen}` |
| `POST /sessions/:id/<action>` | `tap`, `type`, `batch`, `scroll`, `wait_for`, `open_url`, `deep_links`, … |
| `GET /sessions/:id/screenshot?marks=1` | PNG |
| `GET /approvals`, `POST /approvals/:id/approve` | operator-only approval flow |
| `GET /events` | SSE: approval requests, decisions, heartbeats |

The server refuses to bind anything but loopback without `PHONE_API_TOKEN` — this endpoint drives a phone.

---

## Driving it efficiently

Three things the harness does so an agent spends fewer turns and fewer device round trips.

**Batch what you can predict.** A login form is five actions and one decision. `phone_batch` runs the
sequence in a single call, re-resolving each step's selector against a fresh screen so it can never act on
stale coordinates, stopping at the first failure with exactly what ran and what did not. Measured on the
demo login flow:

| | agent turns | device dumps | screen chars returned |
|---|---|---|---|
| one call per action | 4 | 12 | 2149 |
| batched, adaptive rendering | **1** | **7** | **460** |

Every step still passes through the policy pipeline, so a batch is not a way around the approval gate — a
gated step halts the batch and hands back its `approvalId`.

**Settle work is matched to the action.** Typing into a focused field cannot start an animation, so it
costs one dump; a tap that might navigate gets a stability check; launching an app gets the long timeout.
Where a provider can cheaply answer "is a transition still running?" that probe ends the wait early — it
may only shorten the wait, never shorten the verification.

**The screen is not re-sent when you already have it.** If the tree is byte-identical the result says so in
one line; a small in-place change sends just the changed elements; navigation or a large change sends the
whole tree. Batches always end on a full render, because the agent was blind while one ran. Set
`renderMode: "full"` on the session to opt out.

**When the accessibility tree is empty** — a Flutter, canvas or game surface — the harness says so and
attaches a screenshot automatically, instead of handing back a blank screen and letting the agent guess.

---

## Safety model

An agent with a phone holding real accounts is not a browser sandbox. The harness assumes the model is
**not** trusted with irreversible actions.

**Three modes.** `observe` (read-only) · `guarded` (default — risky actions need a human) · `autonomous`
(log only; for sandboxed devices).

**Out-of-band approval.** A risky action returns `awaiting_approval` with an id and an evidence screenshot.
A human decides elsewhere:

```bash
agent-phone approvals --pending
agent-phone approve 3f9c21aa
```

The agent then retries with `approvalId`. Approvals are single-shot and session-bound. Risk is matched on
target text (pay/send/transfer/buy/order/delete/confirm/subscribe/agree) plus install, shell, clear-data
and non-allowlisted URL schemes.

**Bright lines** — refused outright, with or without approval: entering payment card numbers (Luhn-checked)
or government ID numbers, and any app in `blockedApps` (Settings by default). The harness also will not
solve CAPTCHAs, defeat device attestation, or spoof device identity.

**App scoping.** `allowedApps` confines a session to the app the task needs, so an agent cannot wander into
Settings. If perception is unavailable and the foreground app cannot be verified, a scoped session refuses
to act rather than acting blind.

**Secrets.** Referenced by key, never returned, never logged, scrubbed from every trace line and error
message. Password-flagged fields are blacked out of screenshots at full resolution *before* downscaling.

**Budgets.** Max actions and max minutes per session — a looping agent can otherwise tap a phone 100,000
times overnight.

**An action that happened is never reported as failed.** If the side effect lands but the screen cannot be
read afterwards, the result says so explicitly and tells the agent not to retry. Retrying a completed
payment is worse than a blind spot.

**Everything is recorded.** JSONL trace plus screenshot artifacts per session: `agent-phone trace <id>`.

### Running this responsibly

Use a dedicated Google account, not your personal one. Automating third-party apps may breach their terms
of service — that is the operator's call to make deliberately, per app, which is why `allowedApps` is
opt-in rather than open by default.

---

## Configuration

| Env | Meaning |
|---|---|
| `PHONE_HOME` | state dir (default `~/.agent-phone`): secrets, approvals, session traces, emulator logs |
| `PHONE_ADB` | explicit adb path |
| `ANDROID_SDK_ROOT` | explicit SDK root for `agent-phone up` |
| `PHONE_ADB_KEYBOARD=1` | route Android text through the ADBKeyboard broadcast |
| `PHONE_WDA_URL` | WebDriverAgent base URL (default `http://127.0.0.1:8100`) |
| `PHONE_API_TOKEN` | bearer token for the HTTP server; required to bind non-loopback |
| `PHONE_APPROVAL_WEBHOOK` | POSTed when an approval is needed |
| `PHONE_ALLOW_MOCK=1` | allow falling back to the built-in simulated phone when no real device is present |
| `PHONE_SECRET_<KEY>` | inject a secret without a file |
| `PHONE_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |

A starting policy is in [`config/policy.example.json`](config/policy.example.json).

The simulated phone is **never** selected automatically unless you opt in — an agent must never believe it
drove a real phone when it drove a simulation.

---

## Adding a backend

Implement `Device` and `DeviceProvider`, register it in `Harness`. Nothing above the provider layer
changes. Providers take an injectable command `Runner`, which is how the Android backend is fully
unit-tested with no hardware attached — see `tests/android-device.test.ts`.

Natural next backends: a cloud device farm, Waydroid, Corellium.

## Roadmap

Not in v1, in rough priority order:

- **Telephony as a service** — a rented number or IMAP mailbox feeding `phone_wait_for_otp`, so a virtual
  phone can complete real 2FA
- **Compatibility matrix** — which apps actually run on a virtual device
- **Device broker** — leases and routing, for running many phones across hosts
- **Resident on-device observer** — push-based screen updates instead of polling

## Development

```bash
npm install && npm run build
npm test          # 163 tests, no hardware required
npm run typecheck
```

The whole suite runs in CI with no devices attached: the mock phone covers the stack end to end, and the
Android and iOS backends are tested against fake command runners and recorded fixtures.

## License

[Apache-2.0](LICENSE). Contributions are accepted under the same terms.
