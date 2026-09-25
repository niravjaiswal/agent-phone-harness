import { spawn, type ChildProcess } from "node:child_process";
import { err } from "../core/errors.js";
import { which } from "../core/exec.js";
import { logger } from "../core/logger.js";

const log = logger("tunnel");

export interface Tunnel {
  url?: string;
  stop: () => void;
}

export const CLOUDFLARED_HINT =
  "Install cloudflared: macOS `brew install cloudflared`; Linux: " +
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/**
 * The tunnel's own URL in cloudflared's output. Quick-tunnel hostnames are
 * hyphenated words; `api.trycloudflare.com` also appears — in error messages
 * about failing to create one — and must never be mistaken for it.
 */
export function findQuickTunnelUrl(output: string): string | undefined {
  return /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i.exec(output)?.[0];
}

/**
 * Expose the local server on a public HTTPS address so a cloud agent can reach
 * it — the step that makes "a phone on my Mac" usable by Instinct.
 *
 * With CLOUDFLARE_TUNNEL_TOKEN set, runs a named tunnel (stable hostname, set
 * up in the Cloudflare dashboard; pass the hostname as the public URL).
 * Otherwise a quick tunnel: no account, but a new random URL on every start.
 */
export async function startTunnel(
  localUrl: string,
  opts: { bin?: string; token?: string; timeoutMs?: number; attempts?: number } = {},
): Promise<Tunnel> {
  // Quick-tunnel creation is rate-limited and occasionally fails outright; a
  // retry a few seconds later usually succeeds.
  const attempts = opts.attempts ?? 3;
  for (let i = 1; ; i++) {
    try {
      return await startOnce(localUrl, opts);
    } catch (e) {
      if (i >= attempts || (opts.token ?? process.env.CLOUDFLARE_TUNNEL_TOKEN)) throw e;
      log.warn(`tunnel attempt ${i} failed (${(e as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

async function startOnce(
  localUrl: string,
  opts: { bin?: string; token?: string; timeoutMs?: number },
): Promise<Tunnel> {
  const bin = opts.bin ?? (await which("cloudflared"));
  if (!bin) throw err("tool_missing", "cloudflared is not installed", { hint: CLOUDFLARED_HINT });

  const token = opts.token ?? process.env.CLOUDFLARE_TUNNEL_TOKEN;
  const args = token
    ? ["tunnel", "--no-autoupdate", "run", "--token", token]
    : ["tunnel", "--no-autoupdate", "--url", localUrl];
  const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.once("exit", stop);

  if (token) {
    log.info("named Cloudflare tunnel started; its hostname is whatever you routed to this server in the dashboard");
    return { stop };
  }

  const url = await new Promise<string>((resolve, reject) => {
    let seen = "";
    const t = setTimeout(() => {
      stop();
      reject(err("timeout", "cloudflared did not report a public URL within 45s", { hint: seen.slice(-500) }));
    }, opts.timeoutMs ?? 45_000);
    const onData = (d: Buffer) => {
      seen += d.toString();
      const u = findQuickTunnelUrl(seen);
      if (u) {
        clearTimeout(t);
        resolve(u);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(t);
      reject(err("provider_error", `cloudflared exited (${code}) before a URL appeared`, { hint: seen.slice(-500) }));
    });
  });
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  // Keep draining so a full pipe never blocks cloudflared.
  child.stdout?.resume();
  child.stderr?.resume();
  child.once("exit", (code) => log.warn(`cloudflared exited (${code}); the public URL is gone`));
  return { url, stop };
}
