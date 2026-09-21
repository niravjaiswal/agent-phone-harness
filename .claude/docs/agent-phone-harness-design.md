# Agent Phone Harness — Design

**Status:** implemented (v0.1)
**Date:** 2026-09-20
**Goal:** give any tool-using agent (Instinct, Claude Code, a custom loop) a durable, safe way to drive *its own* phone end-to-end, so tasks that only exist on mobile don't bounce back to the human.

---

## 1. Problem

Agents today stall on a specific class of task:

- App-only services (rideshare driver apps, banking, carrier portals, Apple/Google wallet, gov ID apps)
- SMS / push OTP, device-bound 2FA, app-based authenticators
- Flows deliberately gated behind a mobile client (device attestation, app-only pricing)
- Anything needing a phone's identity: a number, a device attestation token, a camera, a location

Web automation cannot reach these. A human has to step in, which destroys the end-to-end property that makes agents useful.

The fix is a **phone harness**: a long-lived, agent-addressable device with a uniform tool surface over perception (what's on screen) and action (tap/type/swipe), plus the mobile-specific side channels (SMS, notifications, deep links) that make flows tractable.

---

## 2. Key insight: three separable problems

Most "agent controls phone" attempts conflate three things. Separating them is the whole design:

| Layer | Question | Varies by |
|---|---|---|
| **Transport** | how do bytes reach a device? | adb / WDA / cloud farm / container |
| **Perception+Action** | what's on screen, how do I touch it? | platform (Android vs iOS) |
| **Agent surface** | what tools does the model see? | *nothing* — must be identical everywhere |

So: one `Device` interface, many providers, one tool surface. An agent that learned to drive an Android emulator drives a real iPhone unchanged.

---

## 3. Device substrate: what should "the agent's phone" actually be?

Evaluated options:

| Option | Input/perception | Real telephony | App compat | Scale | Cost |
|---|---|---|---|---|---|
| **Physical Android + adb** | excellent (uiautomator) | yes (SIM/eSIM) | best | 1 device : 1 agent | cheap handset |
| **Android emulator (AVD)** | excellent | no (emulated SMS only) | Play Integrity blocks banking/fintech | high | free |
| **Redroid / Waydroid container** | good | no | integrity blocks more | very high | cheap |
| **Physical iPhone + WDA** | good (XCUITest) | yes | best | 1:1 | handset + Mac |
| **iOS Simulator** | good (WDA/idb) | no SMS, no App Store | only apps you can build | high | free |
| **Cloud farm** (BrowserStack/Sauce/AWS) | good | no real SIM | good | elastic | $$ per-minute |
| **Corellium** (virtual iOS) | good | no SIM | good | elastic | $$$ |

**Recommendation — virtual first.**

The project's goal is that *any* agent can be given a phone easily. That rules out
"buy a handset" as the default path. So:

1. **Default — a virtual phone on the same machine.** `agent-phone up` creates and
   boots an Android emulator with one command: no handset, no SIM, no cable. The
   harness drives it through the identical adb path, so nothing downstream knows
   the difference.
2. **Linux / many phones — containers.** redroid in Docker shares the host kernel,
   so a single box runs several independent phones, each with its own `/data` and
   its own logged-in identity.
3. **Escape hatch — a physical handset.** Only needed for the two things a virtual
   device genuinely cannot do (below). Reached by `adb connect` over a tailnet, so
   it can live anywhere.
4. **Burst — a cloud farm**, behind the same provider interface.

**The two things virtual cannot do**, and the honest workaround for each:

| Limit | Consequence | Workaround |
|---|---|---|
| **No SIM** | no real number, so a real sender's SMS code never arrives. `adb emu sms send` injects messages, which covers testing but not a real bank. | decouple telephony from the device: a programmable number (Twilio/Telnyx, ~$1/mo) or IMAP email-OTP feeds the same `wait_for_otp`. A phone number is a service, not a piece of hardware. |
| **Play Integrity** | apps calling the attestation API see `MEETS_DEVICE_INTEGRITY` fail. Most banking, some fintech and gov apps hard-refuse. | none. This is the sole reason the physical path exists. Retail, delivery, SaaS, social, productivity and most utility apps are unaffected. |

Architecturally this means `readSms` should not stay a method on `Device`. It
belongs behind a `MessageSource` the session composes — adb-backed, emulator-backed,
carrier-API-backed or IMAP-backed — so a virtual phone with a rented number has the
same 2FA capability as a handset with a SIM.

### Device hygiene (non-negotiable for production)
- Dedicated Google/Apple ID per device. Never the operator's personal account.
- Dedicated phone number (eSIM or VoIP) so OTP capture is unambiguous.
- Network-isolated (own VLAN/tailnet), MDM-enrolled so it can be remote-wiped.
- Snapshot/reset story: Android → `adb shell pm clear <pkg>` per-app, or emulator snapshot restore. Treat device state as *mutable and shared*, and design tasks to be idempotent.

---

## 4. Perception model — the part that decides success rate

Three candidate representations:

- **Pixels only** — general, but expensive (~1-2k tokens/screenshot), coordinate estimation is the #1 failure mode, no notion of "enabled" or "password field".
- **Accessibility tree only** — cheap, exact bounds, exact roles/states. Blind to purely-drawn UI (canvas, games, custom-rendered React Native without a11y props) and to visual layout intent.
- **Hybrid (chosen)** — a11y tree as the source of truth for *targets*, screenshot on demand for *judgment*, with optional set-of-marks numbering that links the two.

**Decision: a11y-first, screenshot-optional, marks to bridge.**

Concretely, every observation returns a normalized element list:

```
ref  role        text/label                 bounds            state
e7   Button      "Continue"                 (48,1180,984,144) enabled clickable
e12  TextField   label="Phone number"       (48,620,984,120)  focused
e19  Switch      "Save this device"         (840,900,144,80)  checked
```

with a rendered indented tree for the model, plus `truncated` bookkeeping. Non-informative nodes (no text, no label, not clickable, not scrollable, no state) are pruned and single-child chains collapsed — an unfiltered Android dump is 40-80k chars; filtered is 1-3k.

### Targeting: refs *and* selectors
- `ref` (`e7`) — fast, from the latest snapshot, revalidated against a fresh dump before the tap fires (bounds+identity must still match, else error rather than mis-tap).
- `selector` (`{text:"Continue"}`, `{id:"com.x:id/next"}`, `{label,role,index,textContains}`) — re-resolved at action time. Survives re-renders. **Preferred for anything after a screen transition.**

Mis-tapping a stale coordinate is the most expensive failure mode in phone automation (it can send money). Revalidation is not optional.

### Settle detection
Every action auto-waits: poll the UI hash at 250ms until two consecutive dumps match (or timeout), then return the *new* screen summary plus a diff (`+3 elements, -1, screen changed: LoginActivity → OtpActivity`). One round-trip per agent step instead of act→observe→observe. This roughly halves agent turn count.

---

## 5. Action surface

Beyond tap/swipe/type, mobile has cheats that web doesn't — exposing them is most of the leverage:

- **`open_url` / deep links** — `am start -a VIEW -d "myapp://order/123"` skips 6 taps of navigation. Biggest single accelerator.
- **`read_sms` / `read_notifications`** — OTP capture without screen-scraping the messages app. This is the feature that unblocks "agent completes signup end to end".
- **App lifecycle** — launch/stop/clear-data gives a clean slate between tasks.
- **`type_secret`** — password/OTP injection by key reference; the value never enters model context or the audit log.
- **Shell** (Android, policy-gated) — escape hatch; everything else is built on it anyway.

---

## 6. Safety — the actual hard part

An agent with a real phone holding real accounts is a materially different risk surface from a browser sandbox. Design assumptions:

1. **The model is not trusted with irreversible actions.** Risk classification runs on every action: target text matched against pay/send/transfer/buy/order/delete/confirm/subscribe/agree patterns; plus install, shell, settings, non-allowlisted URL schemes.
2. **Approval is out-of-band.** A gated action returns `awaiting_approval` with an id + evidence screenshot. The approving channel is the CLI / HTTP endpoint / webhook — never a tool the agent itself can call. An agent cannot approve itself, by construction.
3. **Three modes:** `observe` (read-only), `guarded` (default — gates risky), `autonomous` (log-only, for sandboxed devices).
4. **App scoping.** A session declares its app; taps outside the allowed package set are refused. Stops "agent wandered into Settings".
5. **Secrets never round-trip through the model.** Referenced by key, redacted in logs, and password-flagged fields are blacked out in returned screenshots.
6. **Everything is recorded.** JSONL trace + before/after PNGs per action, replayable. If an agent does something surprising at 3am you need the tape.
7. **Budgets.** Max actions/session, max session duration, idle auto-release — a looping agent can otherwise tap a phone 100k times overnight.

### Things the harness deliberately will not do
Solve CAPTCHAs, defeat device attestation/root detection, spoof device identity, or enter payment card/SSN/bank credentials. These are the bright lines between "automating my own phone" and "building fraud infrastructure". Also: automating third-party apps can violate their ToS — that's the operator's call to make explicitly, per app, which is why the app allowlist is opt-in rather than open by default.

---

## 7. Agent surface

Four front doors over the same session core:

- **MCP (stdio)** — drop into Claude Code / any MCP client. Primary.
- **MCP (HTTP)** — remote agents, Instinct-style hosted loops.
- **REST + SSE** — non-MCP agents; SSE streams device events (new SMS, screen change).
- **TypeScript SDK** — programmatic embedding.

Tool naming is flat and verb-first (`phone_tap`, `phone_observe`) because agents pattern-match on prefixes.

Result shape is uniform and always carries the post-action screen, so the agent never has to guess whether to observe again:

```json
{ "ok": true, "action": "tap", "target": "e7 Button 'Continue'",
  "settled": true, "changed": true,
  "screen": { "app": "com.x", "activity": ".OtpActivity", "elements": "..." } }
```

---

## 8. Architecture

```
            MCP stdio ── MCP http ── REST/SSE ── CLI ── SDK
                    └──────── Session core ────────┘
                                   │
              policy ─ approvals ─ secrets ─ audit ─ snapshot/settle
                                   │
                          Device interface
             ┌─────────────┬───────┴────────┬──────────────┐
          Android         iOS             Mock          (cloud)
          adb+uiauto   WDA + simctl     scripted        farm adapter
                       + devicectl       fixtures
```

`Device` is ~20 methods. Adding a backend = implementing it; nothing above changes.

---

## 9. Implementation plan

1. Core types, exec runner, errors, logging — injectable command runner so providers are unit-testable without hardware.
2. Element normalization, filtering, tree rendering, selector matching.
3. Image ops (pngjs, pure JS — no native build): decode/scale/rect/redact/set-of-marks digits.
4. Android provider: adb wrapper + uiautomator XML parse + input + lifecycle + sms/notifications.
5. iOS provider: WDA HTTP client (source/screenshot/tap/type) + simctl (sim lifecycle) + devicectl (physical lifecycle).
6. Mock provider: scripted screens, so the whole stack runs and is tested with zero hardware.
7. Policy / approvals / secrets / audit.
8. Session core with settle + diff + risk pipeline.
9. MCP server, HTTP server, CLI, doctor.
10. Tests against fixtures + mock device end-to-end.

## 10. Deferred (v0.2+)
- OCR fallback for canvas-rendered UI (Vision framework on macOS / tesseract).
- Device pool + lease broker for multi-agent fan-out.
- Emulator snapshot/restore per task.
- Camera/photo injection, location spoofing.
- Screen-recording → MP4 artifact per session.
