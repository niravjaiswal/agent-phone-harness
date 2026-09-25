import { err } from "./errors.js";

export type PolicyMode = "observe" | "guarded" | "autonomous";

export type ActionKind =
  | "observe"
  | "screenshot"
  | "tap"
  | "long_press"
  | "swipe"
  | "scroll"
  | "type"
  | "type_secret"
  | "key"
  | "clear_text"
  | "open_app"
  | "stop_app"
  | "clear_app_data"
  | "install_app"
  | "open_url"
  | "read_sms"
  | "read_notifications"
  | "clipboard_get"
  | "clipboard_set"
  | "shell"
  | "handoff";

export interface ActionDescriptor {
  kind: ActionKind;
  /** Visible text/label of the thing being touched — the main risk signal. */
  targetText?: string;
  appId?: string;
  url?: string;
  text?: string;
  command?: string;
}

export interface PolicyConfig {
  mode: PolicyMode;
  /** Package/bundle ids the session may drive. Empty = any. Supports `*` suffix globs. */
  allowedApps: string[];
  blockedApps: string[];
  allowShell: boolean;
  allowInstall: boolean;
  allowClearAppData: boolean;
  /** URL schemes `open_url` may use. */
  allowUrlSchemes: string[];
  /** Regex sources: matching target text requires human approval. */
  confirmPatterns: string[];
  /** Regex sources: matching target text is refused outright, approval or not. */
  blockPatterns: string[];
  maxActionsPerSession: number;
  maxSessionMinutes: number;
  /** Black out password-flagged fields in any returned screenshot. */
  redactPasswordFields: boolean;
}

export const DEFAULT_POLICY: PolicyConfig = {
  mode: "guarded",
  allowedApps: [],
  blockedApps: [
    "com.android.settings",
    "com.apple.Preferences",
    "com.android.vending:billing",
  ],
  allowShell: false,
  allowInstall: false,
  allowClearAppData: false,
  allowUrlSchemes: ["https", "http", "tel", "sms", "mailto", "geo", "intent"],
  confirmPatterns: [
    "\\b(pay|paying|payment|pay now)\\b",
    "\\b(send money|transfer|wire|venmo|zelle)\\b",
    "\\b(buy|purchase|place order|order now|checkout|check out)\\b",
    "\\b(subscribe|start (free )?trial|upgrade plan)\\b",
    "\\b(delete|remove|erase|wipe|deactivate|close account|unsubscribe)\\b",
    "\\b(confirm|authori[sz]e|approve|accept|agree|i agree|continue to pay)\\b",
    "\\b(sign out|log ?out)\\b",
  ],
  blockPatterns: [],
  maxActionsPerSession: 500,
  maxSessionMinutes: 60,
  redactPasswordFields: true,
};

export type Risk = "allow" | "confirm" | "deny";

export interface Decision {
  risk: Risk;
  reason: string;
}

const READ_ONLY: ActionKind[] = [
  "observe",
  "screenshot",
  "read_sms",
  "read_notifications",
  "clipboard_get",
];

/** Digit runs that look like a payment card (13-19 digits passing Luhn). */
function looksLikeCard(text: string): boolean {
  for (const m of text.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (luhn(digits)) return true;
  }
  return false;
}

function luhn(d: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const SSN = /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/;

function globMatch(pattern: string, value: string): boolean {
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

export class Policy {
  readonly config: PolicyConfig;
  private confirmRe: RegExp[];
  private blockRe: RegExp[];

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = { ...DEFAULT_POLICY, ...config };
    this.confirmRe = this.config.confirmPatterns.map((p) => new RegExp(p, "i"));
    this.blockRe = this.config.blockPatterns.map((p) => new RegExp(p, "i"));
  }

  /**
   * Classify an action. `deny` is terminal; `confirm` routes to an out-of-band
   * human approval that the agent itself cannot grant.
   */
  evaluate(a: ActionDescriptor): Decision {
    const c = this.config;

    // --- hard bright lines, regardless of mode ---
    // Clipboard is checked too: set-then-paste would otherwise be a way around the bright line.
    if ((a.kind === "type" || a.kind === "clipboard_set") && a.text) {
      if (looksLikeCard(a.text)) {
        return { risk: "deny", reason: "text looks like a payment card number; the harness never enters card details" };
      }
      if (SSN.test(a.text)) {
        return { risk: "deny", reason: "text looks like a government ID number; the harness never enters those" };
      }
    }
    for (const re of this.blockRe) {
      if (a.targetText && re.test(a.targetText)) {
        return { risk: "deny", reason: `target matches blocked pattern ${re.source}` };
      }
    }

    if (READ_ONLY.includes(a.kind)) return { risk: "allow", reason: "read-only" };

    if (c.mode === "observe") {
      return { risk: "deny", reason: "session is in observe mode; no input actions permitted" };
    }

    // --- capability gates ---
    if (a.kind === "shell" && !c.allowShell) {
      return { risk: "deny", reason: "shell disabled by policy (set allowShell to enable)" };
    }
    if (a.kind === "install_app" && !c.allowInstall) {
      return { risk: "deny", reason: "app install disabled by policy" };
    }
    if (a.kind === "clear_app_data" && !c.allowClearAppData) {
      return { risk: "deny", reason: "clearing app data disabled by policy (destructive)" };
    }
    if (a.kind === "open_url" && a.url) {
      const scheme = a.url.split(":")[0]?.toLowerCase() ?? "";
      if (!c.allowUrlSchemes.includes(scheme)) {
        return { risk: "deny", reason: `url scheme "${scheme}" not in allowUrlSchemes` };
      }
    }

    // --- app scoping: stops "agent wandered into Settings" ---
    const app = a.appId;
    if (app) {
      if (c.blockedApps.some((p) => globMatch(p, app))) {
        return { risk: "deny", reason: `app ${app} is blocked by policy` };
      }
      if (c.allowedApps.length && !c.allowedApps.some((p) => globMatch(p, app))) {
        return { risk: "deny", reason: `app ${app} is not in this session's allowedApps` };
      }
    }

    if (c.mode === "autonomous") return { risk: "allow", reason: "autonomous mode" };

    // --- guarded: risky-looking targets need a human ---
    if (a.kind === "install_app" || a.kind === "shell" || a.kind === "clear_app_data") {
      return { risk: "confirm", reason: `${a.kind} is privileged` };
    }
    if (a.targetText) {
      for (const re of this.confirmRe) {
        const m = re.exec(a.targetText);
        if (m) {
          // Name the words, not the regex: a human reads this on their phone.
          return { risk: "confirm", reason: `the target says "${m[0]}", which can move money, delete data or commit you to something` };
        }
      }
    }
    return { risk: "allow", reason: "no risk signal" };
  }

  assertAllowed(a: ActionDescriptor): void {
    const d = this.evaluate(a);
    if (d.risk === "deny") {
      throw err("policy_denied", `Action "${a.kind}" denied: ${d.reason}`, {
        hint: "Adjust the session policy, or have a human perform this step.",
        details: { action: a.kind, reason: d.reason },
      });
    }
  }
}

export function loadPolicyFromJson(raw: unknown): Partial<PolicyConfig> {
  if (!raw || typeof raw !== "object") return {};
  return raw as Partial<PolicyConfig>;
}
