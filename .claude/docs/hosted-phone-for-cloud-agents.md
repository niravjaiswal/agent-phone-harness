# Hosted phone for cloud agents (Instinct)

Status: implemented in v0.2 · 2026-09-24 — see v0.2-plan.md for what shipped and what moved to CI

## The constraint

Instinct's cloud machine runs browsers, scripts and messaging clients. It cannot
install software and cannot run nested virtualization. So **the phone cannot live
where the agent lives.** Everything below follows from that one fact.

## Decision

Ship a **phone host appliance**: Android (redroid) + the harness + an operator
panel + an HTTPS tunnel, as one compose stack on an ordinary Linux VM. The agent
gets a URL and a token. Nothing is installed on the agent side.

### Harness goes next to the phone, not next to the agent

The alternative — harness in the agent sandbox, adb over the internet to a remote
phone — is wrong on every axis:

- **Latency.** One action is several uiautomator dumps (baseline, settle polling).
  Over a WAN each dump pays a round trip. Co-located, polling stays local and the
  agent pays one round trip per tool call.
- **Security.** adb over TCP has no transport encryption; a public 5555 is a
  device anyone can own. Port 5555 is never published.
- **Secrets.** Stored next to the phone, they never transit the agent.
- **Feasibility.** The sandbox cannot install Node anyway.

### redroid, not the emulator

- Container, not VM: no KVM, no nested virtualization, so it runs on standard
  cloud VMs. Lighter, several per host.
- Costs: needs the binder kernel module and a privileged container. That rules out
  PaaS (Railway, Render, Fly, Cloud Run) — a real VM is required.
- Prefer an ARM64 host. Most apps ship arm64 native libraries; x86 redroid images
  may lack ARM translation and some apps will crash.

## Prerequisites — security, must land first (done)

Both are latent today and become exploitable the moment the HTTP server faces an
agent that can run scripts and browse untrusted pages (i.e. Instinct).

1. **Split agent and operator credentials.** `POST /approvals/:id/approve` in
   `src/http/server.ts` accepts the same `PHONE_API_TOKEN` as `/mcp`. An agent
   holding that token can approve its own gated action with one curl. This breaks
   the core guarantee in `approvals.ts` ("an agent cannot approve its own action"):
   no *MCP tool* reaches `decide`, but a REST route on the same token does.
   Fix: agent token for `/mcp` + session routes; separate operator token for
   approvals, secrets, takeover, panel.
2. **Operator-set policy ceiling.** `phone_session_start` lets the agent pass
   `mode: "autonomous"`, `allowShell`, `allowInstall`; `POST /sessions` accepts an
   arbitrary `policy`. The agent can opt out of approval gating. Bright lines
   (cards, SSNs, blocked apps) still hold, but pay/send/delete gating does not.
   Fix: server-side ceiling from operator config; agent arguments may only narrow.
   This affects local stdio mode too, not just hosting.

## Build list

1. **Compose stack.** Add a `harness` service beside redroid, connecting over the
   docker network (`redroid:5555`, unpublished). Add a `cloudflared` sidecar for
   public HTTPS without port forwarding.
2. **Operator panel** (operator token). Live screen (screenshot poll, ~1 fps),
   click/type takeover, pending approvals, secrets form, sessions + traces.
   Replaces every CLI-only operation. Needed because an Instinct user has no
   terminal, and first-run steps (Google sign-in, CAPTCHAs) need human hands —
   the harness must never solve those itself.
3. **Approval push.** Webhook on `approval_requested` → ntfy / Telegram / etc.,
   linking to the panel. Approve from your real phone.
4. **Bootstrap script.** One command on a fresh Ubuntu ARM VM: docker, binder
   module, generate both tokens, compose up, print the connection block.
5. **Connection block.** MCP URL + agent token. REST cheat sheet as fallback for
   agents that only run scripts.
6. **Later: hosted multi-tenant.** Device broker/leases, per-tenant isolation,
   billing, abuse controls. Only if demand justifies owning that.

## Target user experience

1. Rent a small ARM VM (≈4 GB RAM).
2. Run one command. It prints a panel URL and an Instinct connection block.
3. Open the panel once; sign the phone into Google, install the apps you need.
4. Paste the block into Instinct.
5. Risky actions ping your real phone for approval.

## Open questions

- **Does Instinct accept a custom MCP server URL?** If yes, `/mcp`. If not, REST
  via scripts. The server already serves both, so this changes docs, not code.
- **Tunnel identity.** A cloudflared quick tunnel needs no account but its URL
  changes on every restart, breaking the pasted config. A named tunnel needs a
  Cloudflare account and domain. Tailscale Funnel is the alternative.
- **Running it as a service** means owning abuse: virtual phones are a
  bulk-account-creation vector.

## Unchanged

No SIM and Play Integrity failure are properties of virtual phones, not of where
they are hosted. Hosting fixes reachability, nothing else.
