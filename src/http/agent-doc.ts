/**
 * Instructions an agent can fetch and follow on its own — the whole onboarding
 * for an agent that cannot install anything. Contains no credentials: the
 * operator hands the token over separately.
 */
export function agentDoc(base: string, identity: { phoneNumber?: string; email?: string } = {}): string {
  const id = [
    identity.phoneNumber ? `- The phone's number is **${identity.phoneNumber}** — use it when a form asks for your phone number.` : "",
    identity.email ? `- Its email address is **${identity.email}**.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `# You have a phone

An Android phone is available to you at \`${base}\`. You drive it by reading its screen as text and
acting on elements. Your operator gave you a token; send it on every request:

    Authorization: Bearer <agent token>

${id ? `${id}\n` : ""}
## Connect

**If you can use MCP tools**, connect to \`${base}/mcp\` (streamable HTTP) with that header. The tools
are named \`phone_*\` and describe themselves. Start with \`phone_session_start\`.

**Otherwise use HTTP.** Add \`?format=text\` to any call to get compact text instead of JSON.

    curl -s -X POST '${base}/sessions?format=text' \\
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'

That returns a session id and the current screen. Every action is then:

    curl -s -X POST '${base}/sessions/<id>/<action>?format=text' \\
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '<json body>'

## Reading the screen

    Screen: com.example.app / LoginActivity (1080x2340 portrait)
      e7 TextField label="Email" [focused] @540,880
      e12 Button "Sign in" @540,1180

Each line is an element: a ref (\`e7\`), a role, its text or label, flags, and a tap point. Every action
returns the screen *after* it, so you rarely need to observe separately.

Target elements by **selector** — \`{"selector":{"text":"Sign in"}}\`, \`{"selector":{"label":"Email"}}\`,
\`{"selector":{"id":"email_input"}}\` — it is re-checked against the live screen every time. A ref
(\`{"ref":"e7"}\`) works until the screen changes. Raw \`{"x":540,"y":880}\` is a last resort.

## Actions

| action | body |
|---|---|
| \`observe\` | \`{}\` |
| \`tap\` | target, optional \`durationMs\` (>500 = long press) |
| \`type\` | \`{"text":"...", ...target, "submit":true, "clear":true}\` |
| \`type_secret\` | \`{"key":"bank_password", ...target}\` — types a stored secret you never see |
| \`key\` | \`{"key":"back"}\` — back, home, recents, enter, delete, tab |
| \`scroll\` | \`{"direction":"down"}\`, optional target to scroll inside |
| \`swipe\` | \`{"fromX":..,"fromY":..,"toX":..,"toY":..}\` |
| \`wait_for\` | \`{"textContains":"Welcome"}\` or \`{"selector":{...},"gone":true}\` |
| \`open_app\` | \`{"appId":"com.example.app"}\` |
| \`open_url\` | \`{"url":"https://..."}\` — deep links skip whole navigation flows |
| \`deep_links\` | \`{"appId":"..."}\` — URLs the app declares; check before navigating by hand |
| \`list_apps\` | \`{}\` |
| \`batch\` | \`{"steps":[{"action":"tap","selector":{...}}, {"action":"type","text":"..."}]}\` |
| \`wait_for_otp\` | \`{"enter":true, "selector":{"label":"Code"}}\` — waits for a 2FA code and types it |
| \`read_messages\` | \`{}\` — recent SMS/email from every source |
| \`request_human\` | \`{"reason":"Solve the CAPTCHA"}\` — see below |
| \`screenshot\` | \`GET /sessions/<id>/screenshot\` — PNG, only when the text tree is not enough |

End with \`DELETE /sessions/<id>\`. Sessions idle for 20 minutes are closed for you.

## Work efficiently

- When you can predict several steps (a login form), send them as one \`batch\`.
- Check \`deep_links\` before tapping through menus.
- For 2FA, \`wait_for_otp\` with \`"enter":true\` and the code field as target: one call, and the code
  never has to pass through you.

## Rules

- **Risky actions need a human.** Paying, sending money, deleting, confirming: the call returns
  \`awaiting_approval\` with an \`approvalId\`. Your operator has been notified. Wait, then retry the same
  call with \`"approvalId":"..."\`. If it comes back \`denied\`, stop and report — do not look for another way.
- **Some things you must not do yourself**: CAPTCHAs, Google/Apple sign-in, biometric prompts, "verify
  it's you" walls. Call \`request_human\` with a one-line reason. It returns \`done\`, \`declined\` or
  \`pending\`; on pending call it again with the \`handoffId\`. After \`done\`, observe before continuing.
- **\`device_busy\`** means your operator has taken control of the phone. Wait a minute and retry.
- Never type passwords, card numbers or ID numbers with \`type\`. Use \`type_secret\`; ask your operator to
  store the secret if it does not exist.
- Errors carry a \`hint\`. Read it — it says what to do next.
`;
}
