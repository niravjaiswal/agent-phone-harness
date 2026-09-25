# Security

agent-phone-harness hands an AI agent a phone that may hold real accounts. Its
security model assumes **the agent is not trusted with irreversible actions**,
and that anything the agent reads — a web page, an SMS, a notification — may be
trying to steer it.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
(Security → Report a vulnerability) on this repository. Expect an
acknowledgement within a week.

Especially interesting: any way for an agent to approve its own action, reach
an operator route, read a stored secret or entered code, act while a human has
control, or widen its own policy.

## What the harness enforces

| Boundary | How |
|---|---|
| Agent ≠ operator | Separate tokens. The server refuses to start if they are equal and refuses the operator token on agent routes. No MCP tool and no agent route can decide an approval. |
| Policy ceiling | `policy.json` is a ceiling. Agent-supplied policy can only narrow it (mode, capabilities, apps, budgets). A malformed file fails closed to observe-only. |
| Risky actions | Tap targets that read like paying, sending, deleting or agreeing wait for a human decision made in the panel or CLI. |
| Bright lines | Card numbers (Luhn-checked) and government ID numbers are never typed or pasted, even with approval. Settings is blocked by default. |
| Secrets | Referenced by name; never returned, logged or traced; scrubbed from screen trees, errors and screenshots even when typed into a non-password field. |
| One-time codes | `wait_for_otp` with `enter:true` types the code without returning it, and hides it where a field echoes it back. |
| Human control | While the operator has control, every device mutation from an agent fails at the device layer. |
| Webhooks | Telnyx: Ed25519 signature + 5-minute replay window. Twilio: HMAC-SHA1 over the exact public URL. Relay: its own token. |
| Browser | Panel sessions are HttpOnly, SameSite=Strict cookies; writes also require a custom header; cross-origin requests are refused; JSON bodies require a JSON content type; the panel's CSP forbids inline script and framing. Agent-influenced text is only ever rendered as text. |
| adb | Never published to the network. In the container stack only the harness reaches it. |
| Audit | Every action, approval and operator input (never typed text) is recorded. |

## What it does not do

- It does not make an agent safe to run with a phone full of accounts you
  cannot afford to lose. Use a dedicated phone and dedicated accounts.
- It does not solve CAPTCHAs, defeat Play Integrity, or spoof device identity.
- Secrets and tokens are stored in plaintext files (mode 600) on the host. Whoever
  controls the host controls the phone.
- A local user with shell access is an operator by definition: they can edit
  `policy.json` and approve actions. Do not give an agent a shell on the host
  running the harness if you rely on approvals.
- An ntfy topic is only as private as its name. Notifications carry a summary
  and a link, never screenshots or credentials.
