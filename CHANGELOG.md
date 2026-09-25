# Changelog

## 0.2.0

The hosted release: a cloud agent that cannot install anything can now use a
phone, with a human in the loop from their own phone.

### Added
- **Operator panel** at `/panel/`: live screen, take control / hand back,
  approvals with evidence, sessions and traces, secrets, phone number, email
  codes, notifications, policy, agent connection details, APK upload.
- **Two credentials.** Agent token and operator token; one-time panel sign-in
  links (`agent-phone panel-link`).
- **Policy ceiling.** `policy.json` caps what any session may do; agents can
  only narrow it.
- **Phone numbers for virtual phones.** Webhooks for Telnyx (Ed25519) and
  Twilio (HMAC), a relay-phone endpoint, and IMAP for email codes and Google
  Voice. `phone_wait_for_otp` reads all of them.
- **`enter:true` for one-time codes** — typed for the agent, never returned,
  hidden where the field echoes it.
- **`phone_request_human`** — the agent asks for a hand (CAPTCHA, sign-in);
  the operator takes control in the panel and hands back.
- **Notifications** to ntfy, Telegram, Slack or any webhook.
- **`agent-phone serve --public`** — a Cloudflare tunnel so a cloud agent can
  reach a phone on your Mac.
- **Container stack** (`deploy/`): redroid + harness + tunnel, with a one-command
  VM installer.
- **`/agent.md`** — instructions any agent can fetch and follow; REST
  `?format=text` returns the same compact screens MCP does.
- Device leases (one agent per phone), idle-session reaping, per-connection
  MCP sessions.
- CI: real-emulator end-to-end tests on Android 11 and 14; container smoke test;
  release workflow for GHCR and npm.

### Fixed
- An agent could approve its own gated action through the HTTP API.
- An agent could switch its session to `autonomous` and skip approval.
- The HTTP server accepted only one MCP client for its lifetime.
- MCP-over-HTTP sessions were invisible to the rest of the server.
- A secret typed into a non-password field came back in the next screen tree.
- `phone_clipboard` bypassed policy and the audit trail; a card number could
  be pasted around the bright line.
- A loopback server accepted `text/plain` bodies, which any web page can send.
- The same one-time code could be returned twice (once as SMS, once as a
  notification).

## 0.1.0

First release: Android, iOS and mock providers; MCP, HTTP and CLI; guarded
mode with out-of-band approval; secrets; audit trail; `agent-phone up`.
