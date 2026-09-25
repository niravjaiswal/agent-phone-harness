import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, paths } from "./paths.js";
import { logger } from "./logger.js";

const log = logger("config");

/**
 * Everything the operator configures that is not policy.
 *
 * Lives in `config.json` (mode 600) so the panel can edit it; any field can be
 * pinned by environment variable instead, which wins and is shown read-only.
 */
export interface OperatorConfig {
  /** Bearer token for agents: MCP, sessions, devices. */
  agentToken?: string;
  /** Bearer token for the human: approvals, secrets, takeover, config. Must differ from agentToken. */
  operatorToken?: string;
  /** HMAC key for panel session cookies. */
  cookieSecret?: string;
  /** Where the server is reachable from outside, e.g. https://abc.trycloudflare.com. */
  publicUrl?: string;
  /** What the agent should type when a form asks for "your phone number" or "your email". */
  identity: { phoneNumber?: string; email?: string };
  notify: NotifyConfig;
  sources: SourcesConfig;
}

export interface NotifyConfig {
  /** Generic JSON POST. */
  webhook?: string;
  /** e.g. https://ntfy.sh/my-private-topic */
  ntfyUrl?: string;
  ntfyToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Slack incoming-webhook URL. */
  slackWebhook?: string;
}

export interface ImapConfig {
  host: string;
  port?: number;
  user: string;
  /** Name of a secret holding the password (preferred), e.g. "imap_password". */
  passwordSecret?: string;
  mailbox?: string;
  /** Only read mail from senders containing this. */
  fromContains?: string;
}

export interface SourcesConfig {
  /** Bearer token a relay phone (SMS forwarder app) posts with. */
  relayToken?: string;
  /** Telnyx public key (base64, from the portal) — verifies webhook signatures. */
  telnyxPublicKey?: string;
  /** Twilio auth token — verifies X-Twilio-Signature. */
  twilioAuthToken?: string;
  imap?: ImapConfig;
}

const EMPTY = (): OperatorConfig => ({ identity: {}, notify: {}, sources: {} });

/** env var → config path. Env wins over the file. */
const ENV_MAP: [string, (c: OperatorConfig, v: string) => void][] = [
  ["PHONE_AGENT_TOKEN", (c, v) => (c.agentToken = v)],
  // v0.1 name; still honoured as the agent token.
  ["PHONE_API_TOKEN", (c, v) => (c.agentToken ??= v)],
  ["PHONE_OPERATOR_TOKEN", (c, v) => (c.operatorToken = v)],
  ["PHONE_COOKIE_SECRET", (c, v) => (c.cookieSecret = v)],
  ["PHONE_PUBLIC_URL", (c, v) => (c.publicUrl = v.replace(/\/+$/, ""))],
  ["PHONE_NUMBER", (c, v) => (c.identity.phoneNumber = v)],
  ["PHONE_EMAIL", (c, v) => (c.identity.email = v)],
  ["PHONE_APPROVAL_WEBHOOK", (c, v) => (c.notify.webhook = v)],
  ["PHONE_NTFY_URL", (c, v) => (c.notify.ntfyUrl = v)],
  ["PHONE_NTFY_TOKEN", (c, v) => (c.notify.ntfyToken = v)],
  ["PHONE_TELEGRAM_BOT_TOKEN", (c, v) => (c.notify.telegramBotToken = v)],
  ["PHONE_TELEGRAM_CHAT_ID", (c, v) => (c.notify.telegramChatId = v)],
  ["PHONE_SLACK_WEBHOOK", (c, v) => (c.notify.slackWebhook = v)],
  ["PHONE_RELAY_TOKEN", (c, v) => (c.sources.relayToken = v)],
  ["PHONE_TELNYX_PUBLIC_KEY", (c, v) => (c.sources.telnyxPublicKey = v)],
  ["PHONE_TWILIO_AUTH_TOKEN", (c, v) => (c.sources.twilioAuthToken = v)],
];

function imapFromEnv(c: OperatorConfig): void {
  const host = process.env.PHONE_IMAP_HOST;
  const user = process.env.PHONE_IMAP_USER;
  if (!host || !user) return;
  c.sources.imap = {
    host,
    user,
    ...(process.env.PHONE_IMAP_PORT ? { port: Number(process.env.PHONE_IMAP_PORT) } : {}),
    passwordSecret: process.env.PHONE_IMAP_PASSWORD_SECRET ?? "imap_password",
    ...(process.env.PHONE_IMAP_MAILBOX ? { mailbox: process.env.PHONE_IMAP_MAILBOX } : {}),
    ...(process.env.PHONE_IMAP_FROM ? { fromContains: process.env.PHONE_IMAP_FROM } : {}),
  };
}

export function readConfigFile(file = paths.config): OperatorConfig {
  if (!existsSync(file)) return EMPTY();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<OperatorConfig>;
    return {
      ...EMPTY(),
      ...raw,
      identity: { ...(raw.identity ?? {}) },
      notify: { ...(raw.notify ?? {}) },
      sources: { ...(raw.sources ?? {}) },
    };
  } catch (e) {
    log.error(`failed to parse ${file}; ignoring it`, (e as Error).message);
    return EMPTY();
  }
}

/** File + env, env winning. Cheap enough to call per request, so edits apply without a restart. */
export function loadConfig(file = paths.config): OperatorConfig {
  const c = readConfigFile(file);
  for (const [name, apply] of ENV_MAP) {
    const v = process.env[name];
    if (v) apply(c, v);
  }
  imapFromEnv(c);
  return c;
}

/** Names of env vars currently overriding config, so the panel can show those fields as locked. */
export function envOverrides(): string[] {
  const names = ENV_MAP.map(([n]) => n).filter((n) => process.env[n]);
  if (process.env.PHONE_IMAP_HOST) names.push("PHONE_IMAP_HOST");
  return names;
}

export function updateConfigFile(mutate: (c: OperatorConfig) => void, file = paths.config): OperatorConfig {
  const c = readConfigFile(file);
  mutate(c);
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  return c;
}

export const newToken = (prefix: string): string => `${prefix}_${randomBytes(24).toString("base64url")}`;

export interface ServerCredentials {
  agentToken: string;
  operatorToken: string;
  cookieSecret: string;
  /** Tokens created just now (first run) — the caller may want to print them. */
  generated: boolean;
}

/**
 * Tokens for the HTTP server: explicit > env > config file > generated.
 *
 * Generated values are persisted so the connection details an operator pasted
 * into their agent keep working across restarts.
 */
export function ensureServerCredentials(
  explicit: { agentToken?: string; operatorToken?: string } = {},
  file = paths.config,
): ServerCredentials {
  const current = loadConfig(file);
  let generated = false;
  const agentToken = explicit.agentToken ?? current.agentToken;
  const operatorToken = explicit.operatorToken ?? current.operatorToken;
  const cookieSecret = current.cookieSecret;

  const fill: Partial<OperatorConfig> = {};
  if (!agentToken) fill.agentToken = newToken("agt");
  if (!operatorToken) fill.operatorToken = newToken("op");
  if (!cookieSecret) fill.cookieSecret = randomBytes(32).toString("base64url");
  if (Object.keys(fill).length) {
    updateConfigFile((c) => Object.assign(c, fill), file);
    generated = Boolean(fill.agentToken || fill.operatorToken);
  }

  const creds = {
    agentToken: agentToken ?? fill.agentToken!,
    operatorToken: operatorToken ?? fill.operatorToken!,
    cookieSecret: cookieSecret ?? fill.cookieSecret!,
    generated,
  };
  if (creds.agentToken === creds.operatorToken) {
    throw new Error(
      "The agent token and the operator token are identical. The operator token approves the agent's " +
        "risky actions, so an agent holding it could approve itself. Set PHONE_OPERATOR_TOKEN to a different value.",
    );
  }
  return creds;
}

/** Ensure a relay token exists and return it. */
export function ensureRelayToken(file = paths.config): string {
  const c = loadConfig(file);
  if (c.sources.relayToken) return c.sources.relayToken;
  const t = newToken("rly");
  updateConfigFile((x) => (x.sources.relayToken = t), file);
  return t;
}

/** Mask a credential for display: keep a recognisable prefix and suffix. */
export function mask(v: string | undefined): string | undefined {
  if (!v) return v;
  if (v.length <= 10) return "••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}
