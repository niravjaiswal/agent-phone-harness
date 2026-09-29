# agent-phone-harness

Give an AI agent its own phone — a virtual one, or a spare one from your drawer.

A phone your agent drives by reading its screen as text, plus the parts that make real tasks finish:
**a phone number for 2FA codes**, **your approval for anything risky, from your own phone**, a way
for the agent to **ask you for a hand**, and a record of everything it did. Works with agents that
run on your machine (Claude Code, Cursor — over MCP) and agents that run in the cloud and cannot run
a phone themselves (Instinct — over HTTPS).

The phone can be a **virtual Android phone** (no hardware), **a real Android phone** you plug in, or
**an iPhone** (partial support, needs a Mac). [Which phone?](#which-phone)

```bash
npx -y github:niravjaiswal/agent-phone-harness demo
```

A minute, nothing to set up, no phone: a full task on a simulated device — sign in, read an SMS code,
try to send money, get stopped for approval, hit the things the harness refuses outright.

---

## Which phone?

| | Virtual Android | Your own Android phone | Your own iPhone |
|---|---|---|---|
| **Status** | Supported, tested in CI | Supported — the same code as the virtual phone; CI cannot plug in real hardware | **Partial, not yet tested on a real iPhone** |
| **You need** | A Mac, or Linux with KVM | The phone, a USB cable, a computer beside it | A Mac with Xcode 15+, [WebDriverAgent](#an-iphone) on the phone |
| **Harness on a cloud VM** | Yes ([hosting.md](docs/hosting.md)) | Not packaged — run it on a computer beside the phone | No — Apple's tools run only on macOS |
| **Banking, Play Integrity, root detection** | Refused by many such apps | Works on a stock, unrooted phone | Works — it is a real device |
| **SMS codes** | Through a connected number | **Its own SIM**, read on the phone | Through a connected number — iOS lets no app read SMS |
| **Screen, tap, type, swipe, screenshots** | Yes | Yes | Yes, through WebDriverAgent |
| **Notifications, clipboard, deep-link list, shell, clear app data** | Yes | Yes | No |
| **Back key** | Yes | Yes | No — iOS has none; the agent taps the on-screen back button |
| **Installing apps** | Play Store image, or APK | Play Store, or APK | App Store, or a signed `.ipa` |
| **Upkeep** | None | Keep it charged, unlocked, on USB or Wi‑Fi | Re-sign WebDriverAgent every 7 days on a free Apple ID (yearly on a paid one) |

**Choose virtual** unless an app refuses it. **Choose a spare Android phone** for banking-grade apps, a
real SIM number, or when you have no Mac and no Linux with KVM. **Choose an iPhone** only if the app
is iPhone-only and you have a Mac that stays on. Setup for both real phones:
[Your own phone](#your-own-phone).

---

## Pick your path

The paths below use the virtual phone. With a real phone plugged in, skip `agent-phone up`: the
harness finds it on its own. Everything else is the same.

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

A virtual phone has no SIM, so SMS codes are received elsewhere and read by the harness. (A real
Android phone with a SIM needs none of this: the harness reads codes [straight off the phone](#a-spare-android-phone).)

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
| **Play Integrity** | Apps that check device integrity refuse to run — most banking, some fintech, government ID. | [A spare Android phone](#a-spare-android-phone); the harness drives it identically. |
| **No Play Store** (container phone) | Apps must be installed from their APK. | Panel → *Install an app*, or use `agent-phone up`, whose image has the Play Store. |

Retail, delivery, travel, social and productivity apps are generally fine.
**[docs/compatibility.md](docs/compatibility.md)** collects reports.

---

## Your own phone

Everything in this README — the panel, approvals, one-time codes, takeover, traces — works the same on
a real phone. The harness talks to Android through adb and to iPhones through WebDriverAgent; nothing
above that layer knows the difference.

### A spare Android phone

Supported. It uses exactly the code the virtual phone uses. **Tested:** Android 11 and 14 (in CI, on
emulators). **Expected to work, untested:** Android 7–10. Where an older phone lacks a command, the
tool that needs it says `unsupported` instead of guessing.

**Prepare the phone once:**

1. Settings → About phone → tap *Build number* seven times to unlock Developer options.
2. Developer options → turn on **USB debugging** and **Stay awake**. Xiaomi phones also need
   **USB debugging (Security settings)**, or taps and typing are silently ignored.
3. Set the screen lock to *None* or *Swipe*. The harness will not enter a PIN, so a locked phone
   stops the agent at the lock screen.
4. Sign in with a dedicated Google account, not your personal one, and install the apps the agent needs.

**Connect it:**

```bash
brew install --cask android-platform-tools   # Linux: sudo apt install adb
adb devices          # accept the "Allow USB debugging?" prompt on the phone
agent-phone devices  # lists it as android:<serial>, transport usb
```

That is all an agent on the same machine needs: run `agent-phone mcp` (or `serve`) and it uses the phone.
You do not need `agent-phone up`. If the virtual phone is running too, a session takes the first free
one; pass a `deviceId` to choose.

**Codes from its own SIM.** A phone with a SIM receives SMS codes itself; no Twilio or Telnyx number
is needed. Let the harness read them once:

```bash
adb shell pm grant com.android.shell android.permission.READ_SMS
```

Some phones refuse that grant. Then `phone_wait_for_otp` reads the code from the notification instead.

**Typing non-English text** needs [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) installed and
`PHONE_ADB_KEYBOARD=1`.

**For a cloud agent** (Instinct), the harness has to run on a computer beside the phone that stays
on: a Mac, an old laptop, or a Raspberry Pi 4/5 running Linux.

```bash
agent-phone serve --public       # prints the panel link and the block to paste into your agent
```

The quick tunnel's URL changes on every restart. For a permanent one, route a hostname to
`http://localhost:8712` in Cloudflare (see [hosting.md](docs/hosting.md#a-permanent-address)) and run
`CLOUDFLARE_TUNNEL_TOKEN=… agent-phone serve --public --public-url https://phone.example.com`.
Keep the computer awake, and run the server under launchd, systemd or tmux so it survives a restart;
no service file ships yet.

**Over Wi‑Fi instead of a cable.** Plug in once, then:

```bash
adb tcpip 5555                          # repeat after every phone reboot
agent-phone connect 100.83.1.4:5555     # the phone's Tailscale (or LAN) address
PHONE_ADB_CONNECT=100.83.1.4:5555 agent-phone serve --public   # reconnects if it drops
```

> **Security:** adb over the network is unencrypted and gives full control of the phone. Only use it
> on your LAN or a Tailscale network, and never forward port 5555 to the internet. Android 11's
> *Wireless debugging* also works, but its port changes whenever it is toggled, so the harness cannot
> reconnect on its own.

**Not packaged yet:** the phone at home and the harness on a cloud VM, joined over Tailscale. The pieces
exist (`PHONE_ADB_CONNECT` takes any address), but `deploy/install.sh` always starts its own virtual
phone. Until that ships, run the harness beside the phone.

### An iPhone

**Partial, and not yet tested on a real iPhone** — the iOS code is covered by unit tests only. Expect
to hit bugs; reports are welcome ([docs/compatibility.md](docs/compatibility.md)).

| Works | Does not work |
|---|---|
| Reading the screen, tap, swipe, type, Home, Return, volume keys | Reading SMS or notifications — iOS lets no app do this |
| Screenshots, and the panel's live screen and takeover | Clipboard, shell, clearing app data, listing deep links |
| Opening and stopping apps, opening URLs, installing a signed `.ipa` | Listing installed apps (simulators only) |
| Approvals, policy, secrets, `phone_request_human`, traces | Back key — iOS has none; the agent taps the on-screen button |
| | Running in a container or on a Linux VM — Apple's tools need macOS |

**You need** a Mac with Xcode 15 or newer, the iPhone on USB, and an Apple ID.

1. Plug the iPhone in, tap *Trust*, and turn on Settings → Privacy & Security → **Developer Mode**
   (the switch appears after the first connection to Xcode; the phone restarts).
2. Build [WebDriverAgent](https://github.com/appium/WebDriverAgent) onto the phone. It is the
   on-phone server that reads the screen and performs taps:

   ```bash
   git clone https://github.com/appium/WebDriverAgent && cd WebDriverAgent
   open WebDriverAgent.xcodeproj   # WebDriverAgentRunner → Signing & Capabilities: pick your team,
                                   # and change the bundle id if Xcode says it is taken
   xcrun devicectl list devices    # note the iPhone's identifier
   xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
     -destination 'id=<udid>' test   # leave this running; WebDriverAgent stops when it does
   ```

   On the first run, trust your certificate on the phone (Settings → General → VPN & Device
   Management), and on iOS 17 or newer turn on Settings → Developer → **Enable UI Automation**.
3. Forward WebDriverAgent's port to the Mac, and check:

   ```bash
   brew install libimobiledevice && iproxy 8100 8100   # leave running
   agent-phone doctor                                   # WebDriverAgent: reachable
   ```

The harness uses `http://127.0.0.1:8100`; set `PHONE_WDA_URL` to change it. Without WebDriverAgent
it can still install and launch apps, and every other tool says plainly that it needs WebDriverAgent.

**What to expect:**

- **Re-signing.** On a free Apple ID, Xcode's signature expires after 7 days and WebDriverAgent stops
  launching; rebuild it (step 2). A paid developer account ($99/year) lasts a year.
- **One iOS device at a time**, since there is one WebDriverAgent address.
- **Android wins ties.** With an Android phone attached too, a session gets the Android one unless it
  asks for `"platform": "ios"` or a `deviceId`.
- **An unplugged iPhone still shows as available** if it was ever paired. Unplug-aware listing is not
  done yet; pass a `deviceId` if you have more than one paired.
- **SMS codes** need a connected number ([telephony.md](docs/telephony.md)) or email. Untested
  alternative: a Shortcuts automation on the iPhone (*When I get a message* → *Get Contents of URL*)
  that POSTs the message to the [relay endpoint](docs/telephony.md#relay-phone).
- **For a cloud agent**, run `agent-phone serve --public` on the Mac, as for Android above. The Mac,
  `xcodebuild` and `iproxy` all have to stay running.

**iOS simulators** work the same way, with WebDriverAgent built for the simulator
(`-destination 'platform=iOS Simulator,name=iPhone 16'`) and no port forwarding. They share the
simulator's limits: no SIM and no App Store.

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
| `phone_open_url`, `phone_list_deep_links` | a declared URL often replaces a whole tap sequence; the list is Android only |
| `phone_read_sms`, `phone_read_notifications`, `phone_clipboard` | side channels; Android only |
| `phone_install_app`, `phone_clear_app_data`, `phone_shell` | privileged; off unless the policy allows; the last two Android only |
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
- **Your phone at home, the harness on a VM** — a packaged Tailscale setup for a real phone
- **iPhone verified on real hardware**, and unplug-aware device listing

## License

[Apache-2.0](LICENSE). Contributions are accepted under the same terms.
