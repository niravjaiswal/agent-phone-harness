# Which apps work on a virtual phone

Honest status: this list is built from reports, and it is short. **Please add to it** with
the *App compatibility* issue template — it is the most useful contribution a non-coder can make.

## What decides it

Expected behaviour, not a measured matrix — the reports below are what turn it into one.

| Check an app might make | Emulator (`agent-phone up`) | Container (redroid) | Physical phone |
|---|---|---|---|
| Play Integrity: device / strong | **fails** | **fails** | passes |
| Play Integrity: basic | varies by image | expect failure | passes |
| Root / emulator detection | often detected | often detected | passes |
| Needs Google Play services | Play Store image: yes; `google_apis`: services only | **none** unless you add GApps | yes |
| Needs a SIM | no SIM ([telephony.md](telephony.md)) | no SIM | yes |
| ARM-only native code | runs (ARM host) or translated (x86 image) | ARM host: runs; x86 host: needs `libndk` | runs |
| Accessibility tree | normal | normal | normal |

Rules of thumb:

- **Usually fine:** retail, delivery, travel, social, productivity, most utilities, anything
  that works in a mobile browser too.
- **Often refuses:** banking, some fintech and payments, government ID, some games with
  anti-cheat. They call Play Integrity and stop at "device not supported".
- **Needs a human once:** anything behind a Google sign-in or a CAPTCHA. The agent calls
  `phone_request_human`; you sign in from the panel; the phone keeps the session.
- **Canvas / Flutter / game UIs** expose little to accessibility. The harness detects this and
  hands the agent a screenshot to work from, which is slower and less precise.

If an app refuses a virtual phone, the only real fix is a physical Android phone (see the
README). The harness drives it identically.

## Reports

| App | Package | Phone | Result | Reported |
|---|---|---|---|---|
| *(none yet — be the first)* | | | | |
