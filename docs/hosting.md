# Hosting a phone

Running the phone on an always-on Linux machine, so a cloud agent can use it
while your laptop is closed.

```
                  ┌──────────────────────── your VM ────────────────────────┐
Agent ──HTTPS──▶  │ tunnel ──▶ harness :8712 ──adb (compose network)──▶ phone │
You (panel) ───▶  │            (panel, MCP, REST, SMS webhooks)       redroid │
                  └──────────────────────────────────────────────────────────┘
```

- **phone** — Android in a container ([redroid](https://github.com/remote-android/redroid-doc)).
  It shares the host kernel, so no nested virtualization: it runs on ordinary cloud VMs.
- **harness** — this project. Talks to the phone over the compose network; adb is never
  exposed.
- **tunnel** — Cloudflare, so the harness is reachable over HTTPS without opening ports.

## Requirements

- Linux with the **binder** kernel module. Ubuntu 22.04/24.04 and Debian 12 with their stock
  kernels have it (Ubuntu in `linux-modules-extra`). The installer loads it.
- **4 GB RAM**, 2 vCPU, 20 GB disk for one phone.
- **x86_64 or arm64.** ARM is cheaper and runs ARM-only apps natively. On x86_64,
  apps that ship only ARM code will not start unless you add a translation layer
  (redroid documents `libndk`).
- A real VM. Container platforms (Fly, Railway, Render, Cloud Run) cannot load kernel
  modules or run privileged containers.

## Where to run it

Prices change; these are rough, for one phone.

| Provider | Machine | Roughly |
|---|---|---|
| Oracle Cloud | Always Free Ampere A1 (arm64) | free, if you can get capacity |
| Hetzner | CAX11 (arm64, 4 GB) | ~€4/month |
| AWS | t4g.medium (arm64, 4 GB) | ~$25/month |
| Any | 4 GB Ubuntu VM | $5–25/month |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/niravjaiswal/agent-phone-harness/main/deploy/install.sh | bash
```

It installs Docker if needed, loads binder (and persists it across reboots), fetches the
repository to `~/agent-phone-harness`, starts the stack, waits for Android to boot and prints
the panel link and the agent connection block. First run downloads Android (~1.5 GB).

By hand:

```bash
git clone https://github.com/niravjaiswal/agent-phone-harness && cd agent-phone-harness/deploy
cp .env.example .env
docker compose up -d --build
docker compose exec harness agent-phone connect-info --wait 60
```

## A permanent address

The default quick tunnel needs no account, but its URL changes whenever the tunnel restarts —
and your agent's instructions, and your Twilio webhook, point at the old one.

For a stable hostname, create a tunnel in the Cloudflare dashboard (Zero Trust → Networks →
Tunnels), route a hostname on your domain to `http://harness:8712`, and:

```bash
CLOUDFLARE_TUNNEL_TOKEN=eyJ… PHONE_PUBLIC_URL=https://phone.example.com ./deploy/install.sh
```

Or in an existing `deploy/.env`: `COMPOSE_PROFILES=named`, plus those two variables.

**Your own reverse proxy** works too: set `COMPOSE_PROFILES=` (empty) and
`PHONE_PUBLIC_URL`, and proxy to `127.0.0.1:8712`. Caddy:

```
phone.example.com {
  reverse_proxy 127.0.0.1:8712
}
```

## Operating it

```bash
cd ~/agent-phone-harness/deploy
docker compose ps
docker compose logs -f harness
docker compose exec harness agent-phone panel-link     # fresh one-time sign-in link
docker compose exec harness agent-phone token          # both tokens
docker compose exec harness agent-phone approvals --pending
```

**Upgrade:** `git pull && docker compose up -d --build`. Phone data, tokens, secrets and
traces live in the `phone-data` and `harness-data` volumes and survive upgrades.

**Back up** those two volumes to keep the phone's logged-in state.

**Reach the panel without the tunnel:** `ssh -L 8712:127.0.0.1:8712 your-vm`, then
http://127.0.0.1:8712/panel/.

## More than one phone

Copy the `phone` service as `phone-2` with its own volume, and list both for the harness:

```yaml
  phone-2:
    image: redroid/redroid:${REDROID_TAG:-14.0.0-latest}
    privileged: true
    volumes: [phone-2-data:/data]
    command: [androidboot.redroid_width=1080, androidboot.redroid_height=2340, androidboot.redroid_dpi=420, androidboot.redroid_gpu_mode=guest]
  harness:
    environment:
      PHONE_ADB_CONNECT: phone:5555,phone-2:5555
```

Each phone is leased to one agent session at a time; an agent that asks for any phone
gets a free one.

## Configuration

Everything below can also be set in the panel; environment variables win and show as locked.

| Variable | Meaning |
|---|---|
| `PHONE_AGENT_TOKEN`, `PHONE_OPERATOR_TOKEN` | Pin the tokens (generated otherwise). Must differ. |
| `PHONE_PUBLIC_URL` | The public base URL, if not discovered from the tunnel |
| `PHONE_NUMBER`, `PHONE_EMAIL` | The identity the agent is told to use |
| `PHONE_NTFY_URL`, `PHONE_NTFY_TOKEN` | ntfy notifications |
| `PHONE_TELEGRAM_BOT_TOKEN`, `PHONE_TELEGRAM_CHAT_ID` | Telegram notifications |
| `PHONE_SLACK_WEBHOOK`, `PHONE_APPROVAL_WEBHOOK` | Slack / generic webhook notifications |
| `PHONE_TELNYX_PUBLIC_KEY`, `PHONE_TWILIO_AUTH_TOKEN`, `PHONE_RELAY_TOKEN` | Inbound SMS verification |
| `PHONE_IMAP_HOST`, `PHONE_IMAP_USER`, `PHONE_IMAP_PORT`, `PHONE_IMAP_MAILBOX`, `PHONE_IMAP_FROM` | Email codes; the password is the secret `imap_password` |
| `PHONE_ADB_CONNECT` | Network phones to keep connected |
| `PHONE_TUNNEL_METRICS` | cloudflared metrics URL, used to discover the quick-tunnel address |
| `PHONE_SECRET_<NAME>` | Inject a secret |
| `REDROID_TAG`, `PHONE_WIDTH`, `PHONE_HEIGHT`, `PHONE_DPI` | Android version and screen |

## Kernels

If the installer says the kernel has no binder module:

- Ubuntu: `sudo apt install linux-modules-extra-$(uname -r)` then re-run.
- Provider-customised kernels (some "minimal" images) omit it. Switch the VM to the provider's
  standard Ubuntu image.
- Check with `grep binder /proc/filesystems` or `ls /dev/binder*`.

## Security notes

- adb is not published; only the harness reaches the phone.
- The harness port is bound to loopback on the VM; the world reaches it only through the tunnel.
- Tokens, secrets and the panel's cookie key live in the `harness-data` volume in plaintext
  (mode 600). Treat the VM as holding the keys to every account on the phone.
- See [SECURITY.md](../SECURITY.md) for the full model.
