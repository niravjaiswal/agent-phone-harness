# Using agent-phone with Instinct

Instinct runs in the cloud. It can browse and run scripts, but it cannot host a
phone: its sandbox is small and short-lived, has no hardware virtualization for
an Android emulator, and has no way to serve an always-on public address. So the
phone runs somewhere else, and Instinct gets an address and a token. Nothing is
installed on Instinct's side.

```
Instinct ──HTTPS──▶ tunnel ──▶ agent-phone ──adb──▶ Android
                                   │
                          you, in the panel (from your phone)
```

## 1. Start a phone

Pick one.

### On your Mac (quickest; the Mac must stay awake)

```bash
brew install --cask android-commandlinetools
npm install -g github:niravjaiswal/agent-phone-harness
agent-phone up               # creates and boots a virtual Android phone (~1.5 GB first time)
agent-phone serve --public   # needs cloudflared: brew install cloudflared
```

### On an always-on server (about €6/month, or free)

Any Ubuntu 22.04/24.04 or Debian 12 VM with 4 GB of RAM. ARM is cheapest. See
[hosting.md](hosting.md) for providers.

```bash
curl -fsSL https://raw.githubusercontent.com/niravjaiswal/agent-phone-harness/main/deploy/install.sh | bash
```

Either way you get this:

```
  Operator panel (one-time sign-in link, valid 15 minutes):
    https://brave-otter.trycloudflare.com/panel/#code=Xy3…

  Give your agent — Instinct and other browsing/scripting agents, paste this:
  ─────────────────────────────────────────────
  You have an Android phone you can control. Its API is at https://brave-otter.trycloudflare.com
  and your token is agt_…. Before using it, fetch https://brave-otter.trycloudflare.com/agent.md
  and follow those instructions. …
  ─────────────────────────────────────────────
```

## 2. Set the phone up (once, in the panel)

Open the panel link. It works on your phone too.

1. **Sign the phone in.** Phone tab → *Take control*. Tap and type on the live screen:
   sign in to Google (Play Store image) and to the apps the agent will use. Then
   *Hand back*. Use accounts made for this, not your personal ones.
2. **Install apps.** On the `agent-phone up` phone, use the Play Store. The container phone has
   no Play Store: upload the app's APK under *Install an app*.
3. **Store passwords.** Setup → Secrets. The agent types them by name and never sees them.
4. **Give it a number** so real SMS codes reach it: Setup → Phone number & SMS.
   A Telnyx number is about $1/month. See [telephony.md](telephony.md).
5. **Turn on notifications.** Setup → Notifications. [ntfy](https://ntfy.sh) is the quickest:
   install the app, subscribe to a long random topic, paste the topic URL.

## 3. Give Instinct the phone

Paste the block into Instinct as part of its instructions, or at the start of a task.
Instinct fetches `/agent.md`, which teaches it the API, and then works like this:

```bash
curl -s -X POST "$BASE/sessions?format=text" -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{}'
# session 3f9c21aa on Pixel 6 … phone number: +15551234567
# Screen: com.google.android.apps.nexuslauncher / .NexusLauncherActivity …

curl -s -X POST "$BASE/sessions/3f9c21aa/batch?format=text" … -d '{"steps":[
  {"action":"open_app","appId":"com.ubercab"},
  {"action":"tap","selector":{"text":"Where to?"}},
  {"action":"type","text":"SFO"}]}'
```

If Instinct supports remote MCP servers, give it `https://…/mcp` and the header
`Authorization: Bearer agt_…` instead; the tools describe themselves.

## 4. While it works

- **Risky actions come to you.** When the agent taps something like *Pay*, *Send* or *Delete*,
  it stops and you get a notification. Open it, look at the screenshot, approve or deny. The
  agent is waiting and carries on.
- **It asks for help when it should.** CAPTCHAs, "verify it's you", biometric prompts: the agent
  calls `request_human`, you get a notification, take control, fix it, and press
  *Done — hand back*.
- **You can take over any time.** *Take control* pauses the agent (its actions fail with
  `device_busy`) until you hand back.
- **Everything is recorded.** Activity tab: every session, every action, with screenshots.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Instinct's requests fail after a restart | A quick tunnel gets a new URL each time it starts. Run `agent-phone connect-info` (or `docker compose exec harness agent-phone connect-info`) and give Instinct the new block — or use a named tunnel for a permanent address ([hosting.md](hosting.md#a-permanent-address)). |
| `401` | Wrong token, or the agent token was rotated in the panel. |
| `403 … operator token` | You gave the agent the operator token. Give it the agent token. |
| `device_busy` | You have control, or another agent session holds the phone. |
| Codes never arrive | No number connected, or the sender refuses VoIP numbers ([telephony.md](telephony.md)). |
| An app refuses to run | Many banking apps refuse any virtual phone ([compatibility.md](compatibility.md)). |
