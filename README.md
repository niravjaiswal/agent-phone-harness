# agent-phone-harness

Give an agent its own phone.

A uniform perception/action harness over **Android**, **iOS** and a built-in **mock phone**, exposed
over **MCP**, **HTTP/SSE** and a **CLI** — so a tool-using agent (Instinct, Claude Code, your own loop)
can finish tasks that only exist on a mobile device, end to end, without a human stepping in.

```bash
npm install && npm run build
node dist/cli.js demo          # full flow on the mock phone — no hardware needed
node dist/cli.js doctor        # what's installed, what's missing, how to fix it
```

---

## Why

Agents stall on a specific class of task: app-only services, SMS/push one-time codes, device-bound 2FA,
anything gated behind a mobile client. Web automation cannot reach these, so a human takes over and the
end-to-end property is lost. This harness gives the agent a real phone plus the mobile-specific side
channels (SMS, notifications, deep links) that make those flows tractable.

Design rationale and the options that were weighed: [`.claude/docs/agent-phone-harness-design.md`](.claude/docs/agent-phone-harness-design.md).

---

## What an agent actually sees

Perception is **accessibility-tree first**, screenshots on demand. A screen costs ~1-3k characters
instead of a 40-80k-character raw dump or an expensive image:

```
Screen: com.example.bank / .LoginActivity (1080x2340 portrait)
e1 Text "Welcome back"
  e2 TextField label="Email address" value="ada@example.com" id=email [focused] @540,470
  e3 TextField label="Password" id=password [password] @540,670
  e4 Switch label="Remember this device" id=remember [checked] @966,840
  e5 Button "Sign in" id=signin @540,1010
  e6 Text "Forgot password?" [clickable] @274,1155
```

Every mutating tool returns the **resulting** screen plus a change summary, so there is no act → observe
→ observe round-trip:

```
✓ tap → e5 Button "Sign in"
screen: com.example.bank/.LoginActivity → com.example.bank/.OtpActivity, +4 elements, -6 elements

Screen: com.example.bank / .OtpActivity (1080x2340 portrait)
...
```

Target elements by **selector** (`{"text":"Continue"}`, `{"id":"signin"}`, `{"role":"TextField","index":1}`),
which is re-resolved at action time and survives re-renders, or by **ref** (`e5`), which is revalidated by
identity before the tap fires. Ambiguous matches are an error, not a coin flip — mis-tapping a duplicate
label is how money goes to the wrong person.

---

## Quickstart

### 1. No hardware

```bash
node dist/cli.js demo
```

Runs a scripted task on the built-in mock phone: log in, collect an SMS one-time code, attempt a
transfer that gets gated on a human, and hit the refusals the harness will not cross.

### 2. Android (recommended for production)

```bash
brew install --cask android-platform-tools   # or set PHONE_ADB=/path/to/adb
adb devices                                   # accept the USB-debugging prompt on the phone

node dist/cli.js devices
node dist/cli.js observe
node dist/cli.js tap --text "Settings"
```

Over the network (this is what makes "the agent's phone" location-independent — put it on a shelf and
reach it over Tailscale):

```bash
adb tcpip 5555                      # once, over USB
node dist/cli.js connect 100.83.1.4:5555
```

Optional one-time grants on the device:

```bash
adb shell pm grant com.android.shell android.permission.READ_SMS   # enables phone_read_sms
```

Non-ASCII input needs [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) installed and selected;
then start with `PHONE_ADB_KEYBOARD=1`. Without it the harness refuses non-ASCII rather than typing
garbage.

### 3. iOS

`simctl` (simulators) and `devicectl` (physical devices) ship with Xcode and cover lifecycle,
screenshots and deep links. **Touch and perception need WebDriverAgent:**

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

## Wiring it to an agent

### MCP (stdio)

```json
{
  "mcpServers": {
    "phone": {
      "command": "node",
      "args": ["/path/to/agent-phone-harness/dist/mcp/stdio.js"],
      "env": { "PHONE_ALLOW_MOCK": "0" }
    }
  }
}
```

### MCP over HTTP, REST and SSE

```bash
PHONE_API_TOKEN=$(openssl rand -hex 16) node dist/cli.js serve --port 8712
```

| Endpoint | What |
|---|---|
| `POST /mcp` | the same MCP tool surface, streamable HTTP |
| `GET /devices`, `GET /doctor` | discovery |
| `POST /sessions` | open a session → `{sessionId, screen}` |
| `POST /sessions/:id/<action>` | `tap`, `type`, `scroll`, `wait_for`, `open_url`, `wait_for_otp`, … |
| `GET /sessions/:id/screenshot?marks=1` | PNG |
| `GET /approvals`, `POST /approvals/:id/approve` | operator-only approval flow |
| `GET /events` | SSE: approval requests, decisions, heartbeats |

The server refuses to bind anything but loopback without `PHONE_API_TOKEN` — this endpoint drives a
real phone.

### TypeScript

```ts
import { Harness } from "agent-phone-harness";

const harness = new Harness();
const session = await harness.createSession({ policy: { allowedApps: ["com.example.bank"] } });

await session.openApp("com.example.bank");
await session.type("ada@example.com", { target: { selector: { label: "Email address" } } });
await session.typeSecret("bank_password", { target: { selector: { label: "Password" } } });
await session.tap({ selector: { text: "Sign in" } });

const { code } = await session.waitForOtp({ digits: 6 });
await session.type(code, { target: { selector: { label: "Verification code" } } });
const result = await session.tap({ selector: { text: "Verify" } });

console.log(result.screen.elements);
await harness.close(session.id);
```

---

## Tools

| Tool | Notes |
|---|---|
| `phone_list_devices` | Android (USB/TCP), iOS (sim + device), mock |
| `phone_session_start` / `_status` / `_end` | scopes policy, budgets and the audit trail |
| `phone_observe` | element tree with refs — the cheap, precise way to see |
| `phone_screenshot` | password fields blacked out; `marks:true` for numbered boxes |
| `phone_tap`, `phone_type`, `phone_key`, `phone_swipe`, `phone_scroll`, `phone_clear_text` | input |
| `phone_type_secret` | types a stored secret; the value never enters your context |
| `phone_wait_for` | wait for something to appear or disappear |
| `phone_open_app`, `phone_stop_app`, `phone_list_apps` | app lifecycle |
| `phone_open_url` | **deep links skip whole navigation trees — reach for this first** |
| `phone_read_sms`, `phone_read_notifications`, `phone_wait_for_otp` | the 2FA unblocker |
| `phone_clipboard` | paste long or non-ASCII text |
| `phone_install_app`, `phone_clear_app_data`, `phone_shell` | privileged; off unless the policy allows |

No tool can approve a gated action. That path is operator-only, by construction.

---

## Safety model

An agent with a real phone holding real accounts is not a browser sandbox. The harness assumes the model
is **not** trusted with irreversible actions.

**Three modes.** `observe` (read-only) · `guarded` (default — risky actions need a human) · `autonomous`
(log only; for sandboxed devices).

**Out-of-band approval.** A risky action returns `awaiting_approval` with an id and an evidence
screenshot. A human decides elsewhere:

```bash
node dist/cli.js approvals --pending
node dist/cli.js approve 3f9c21aa
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

```bash
node dist/cli.js secret set bank_password    # value read from stdin, not argv
node dist/cli.js secret list                 # names only
```

**Budgets.** Max actions and max minutes per session — a looping agent can otherwise tap a phone 100,000
times overnight.

**An action that happened is never reported as failed.** If the side effect lands but the screen cannot be
read afterwards, the result says so explicitly and tells the agent not to retry. Retrying a completed
payment is worse than a blind spot.

**Everything is recorded.** JSONL trace plus screenshot artifacts per session:

```bash
node dist/cli.js trace 7f2a91c0
```

### Device hygiene for production

Dedicated handset, dedicated Google/Apple ID, dedicated phone number, network-isolated, MDM-enrolled so it
can be wiped. Never the operator's personal account. Automating third-party apps may violate their terms —
that is a deliberate, per-app call for the operator, which is why `allowedApps` is opt-in rather than open.

---

## Configuration

| Env | Meaning |
|---|---|
| `PHONE_HOME` | state dir (default `~/.agent-phone`): secrets, approvals, session traces |
| `PHONE_ADB` | explicit adb path |
| `PHONE_ADB_KEYBOARD=1` | route Android text through the ADBKeyboard broadcast |
| `PHONE_WDA_URL` | WebDriverAgent base URL (default `http://127.0.0.1:8100`) |
| `PHONE_API_TOKEN` | bearer token for the HTTP server; required to bind non-loopback |
| `PHONE_APPROVAL_WEBHOOK` | POSTed when an approval is needed |
| `PHONE_ALLOW_MOCK=1` | allow falling back to the mock phone when no real device is present |
| `PHONE_SECRET_<KEY>` | inject a secret without a file |
| `PHONE_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |

A starting policy is in [`config/policy.example.json`](config/policy.example.json).

The mock phone is **never** selected automatically unless you opt in — an agent must never believe it
drove a real phone when it drove a simulation.

---

## Adding a backend

Implement `Device` (~20 methods) and `DeviceProvider`, register it in `Harness`. Nothing above the provider
layer changes. Providers take an injectable command `Runner`, which is how the Android backend is fully
unit-tested with no hardware attached — see `tests/android-device.test.ts`.

Natural next backends: a cloud device farm, Redroid/Waydroid containers, Corellium.

## Development

```bash
npm test          # 121 tests, no hardware required
npm run typecheck
npm run build
```
