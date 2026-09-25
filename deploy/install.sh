#!/usr/bin/env bash
# One command from a fresh Linux VM to a phone your agent can use.
#
#   curl -fsSL https://raw.githubusercontent.com/niravjaiswal/agent-phone-harness/main/deploy/install.sh | bash
#
# or from a clone:  ./deploy/install.sh
#
# What it does, in order, and nothing else:
#   1. installs Docker if it is missing (distro packages)
#   2. loads the binder kernel module Android needs, and makes that stick across reboots
#   3. fetches this repository (if not run from a clone)
#   4. starts the phone, the harness and a Cloudflare tunnel
#   5. prints the panel sign-in link and what to give your agent
#
# Tested targets: Ubuntu 22.04 / 24.04 and Debian 12, x86_64 or arm64.
# Env: AGENT_PHONE_DIR (default ~/agent-phone-harness), AGENT_PHONE_REF (default main),
#      CLOUDFLARE_TUNNEL_TOKEN + PHONE_PUBLIC_URL for a named tunnel, NO_TUNNEL=1 to skip it.
set -euo pipefail

REPO="https://github.com/niravjaiswal/agent-phone-harness.git"
DIR="${AGENT_PHONE_DIR:-$HOME/agent-phone-harness}"
REF="${AGENT_PHONE_REF:-main}"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux hosts. On a Mac, use: agent-phone up && agent-phone serve --public"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "Run as root, or install sudo."
  SUDO="sudo"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU architecture $(uname -m); redroid needs x86_64 or arm64." ;;
esac
say "host: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") ($ARCH)"

# ---- 1. docker ------------------------------------------------------------------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "installing Docker"
  command -v apt-get >/dev/null || die "No apt-get. Install Docker and the compose plugin yourself, then re-run."
  $SUDO apt-get update -qq
  if ! $SUDO apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1; then
    # Debian ships compose v2 as docker-compose-plugin only from Docker's own repo.
    $SUDO apt-get install -y -qq docker.io >/dev/null
    if ! docker compose version >/dev/null 2>&1; then
      die "Docker is installed but the compose plugin is not. Follow https://docs.docker.com/engine/install/ and re-run."
    fi
  fi
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; fi
$DOCKER info >/dev/null 2>&1 || die "Docker is installed but not running."

# ---- 2. binder --------------------------------------------------------------------
# Android's IPC. redroid shares the host kernel, so the host must provide it.
have_binder() { grep -q binder /proc/filesystems 2>/dev/null || [ -e /dev/binder ] || lsmod 2>/dev/null | grep -q binder_linux; }
if ! have_binder; then
  say "loading the binder kernel module"
  if ! $SUDO modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null; then
    if command -v apt-get >/dev/null; then
      $SUDO apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null 2>&1 || true
    fi
    $SUDO modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null \
      || die "This kernel has no binder module ($(uname -r)). Use an Ubuntu 22.04/24.04 image with the stock kernel, or see docs/hosting.md#kernels."
  fi
  echo "binder_linux" | $SUDO tee /etc/modules-load.d/agent-phone.conf >/dev/null
  echo 'options binder_linux devices="binder,hwbinder,vndbinder"' | $SUDO tee /etc/modprobe.d/agent-phone.conf >/dev/null
fi
# Android 12+ uses memfd; ashmem only matters for older images and is optional.
$SUDO modprobe ashmem_linux 2>/dev/null || true

# ---- 3. source ----------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/compose.yml" ] && [ -f "$HERE/../Dockerfile" ]; then
  DIR="$(cd "$HERE/.." && pwd)"
else
  command -v git >/dev/null || $SUDO apt-get install -y -qq git >/dev/null
  if [ -d "$DIR/.git" ]; then
    say "updating $DIR"
    git -C "$DIR" fetch -q origin "$REF" && git -C "$DIR" checkout -q "$REF" && git -C "$DIR" pull -q --ff-only || warn "could not update; using what is there"
  else
    say "fetching agent-phone-harness into $DIR"
    git clone -q --branch "$REF" "$REPO" "$DIR"
  fi
fi
cd "$DIR/deploy"

# ---- 4. start -------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    [ -n "${PHONE_PUBLIC_URL:-}" ] || die "A named tunnel needs PHONE_PUBLIC_URL (the hostname you routed to it)."
    sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=named/' .env
    printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\nPHONE_PUBLIC_URL=%s\n' "$CLOUDFLARE_TUNNEL_TOKEN" "$PHONE_PUBLIC_URL" >> .env
  elif [ "${NO_TUNNEL:-}" = "1" ]; then
    sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=/' .env
  fi
  chmod 600 .env
fi

say "building and starting (the first run downloads Android, about 1.5 GB)"
$DOCKER compose up -d --build

say "waiting for the harness"
for _ in $(seq 1 60); do
  if $DOCKER compose exec -T harness node -e "fetch('http://127.0.0.1:8712/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 2
done

say "waiting for Android to boot"
booted=""
for _ in $(seq 1 90); do
  if $DOCKER compose exec -T harness sh -c 'adb -s phone:5555 shell getprop sys.boot_completed 2>/dev/null' | grep -q 1; then booted=1; break; fi
  sleep 2
done
[ -n "$booted" ] || warn "Android has not finished booting yet; it will appear in the panel when it does. Logs: docker compose -f $DIR/deploy/compose.yml logs phone"

WAIT=0
grep -q '^COMPOSE_PROFILES=quick' .env && WAIT=60
$DOCKER compose exec -T harness agent-phone connect-info --wait "$WAIT"

cat <<MSG
  Manage it:
    cd $DIR/deploy
    docker compose logs -f harness      # what the harness is doing
    docker compose exec harness agent-phone panel-link   # a fresh sign-in link
    docker compose down                 # stop (the phone's data is kept)

MSG
