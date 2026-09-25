# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/niravjaiswal/agent-phone-harness
cd agent-phone-harness
npm install          # also builds
npm test             # ~250 tests, no device needed
npm run dev -- demo  # the end-to-end demo on the mock phone
```

To try the panel against the mock phone:

```bash
npm run dev -- serve --mock      # prints a one-time panel link
```

With an emulator or phone attached, `npm run e2e:android` runs the real-device
check that CI runs against Android 11 and 14.

## Layout

| Path | What |
|---|---|
| `src/core/` | Session pipeline, policy + ceiling, approvals, secrets, messages/OTP, notifications, audit |
| `src/providers/` | Android (adb), iOS (WebDriverAgent/simctl), mock |
| `src/mcp/` | MCP tool surface and text rendering |
| `src/http/` | HTTP server: agent REST, MCP over HTTP, operator API, SMS webhooks, tunnel |
| `src/panel/` | Operator panel — plain HTML/CSS/JS, no build step |
| `src/virtual/` | `agent-phone up`: Android SDK + emulator provisioning |
| `deploy/` | Container stack and VM installer |
| `tests/` | Vitest; providers are tested against a fake command runner |

## Ground rules

- **Safety properties need tests.** If a change touches approvals, the ceiling,
  secrets, redaction or authentication, add a test that would fail if the
  property broke.
- **No new runtime dependencies** without a strong reason. The current set is
  five packages.
- **Panel code never uses `innerHTML`** with anything that is not a literal.
- **Providers take a `Runner`**, so they can be tested without hardware.
- Error messages carry a `hint` telling an agent what to do next.

## Compatibility reports

Knowing which apps work on a virtual phone is the most useful thing a
non-coder can contribute. Use the "App compatibility" issue template.

## Commits

Conventional-commit style (`feat(core): …`, `fix(http): …`, `docs: …`).
