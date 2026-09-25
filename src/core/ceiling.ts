import { existsSync, readFileSync, statSync } from "node:fs";
import { err } from "./errors.js";
import { logger } from "./logger.js";
import { paths } from "./paths.js";
import { DEFAULT_POLICY, type PolicyConfig, type PolicyMode } from "./policy.js";

const log = logger("policy");

/**
 * The operator's policy is a ceiling, not a default.
 *
 * An agent opening a session may pass policy fields — that is how it scopes
 * itself to the one app a task needs. Before this existed it could equally pass
 * `mode: "autonomous"` and switch off human approval for payments. Every field
 * now combines in the direction that can only reduce what the session may do.
 */

const RANK: Record<PolicyMode, number> = { observe: 0, guarded: 1, autonomous: 2 };

/** Is request pattern `p` inside ceiling pattern `c`? Both may end in `*`. */
function covers(c: string, p: string): boolean {
  if (c === p) return true;
  if (!c.endsWith("*")) return false;
  const prefix = c.slice(0, -1);
  return p.startsWith(prefix);
}

const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];

export interface ClampResult {
  policy: PolicyConfig;
  /** Human-readable notes on every request the ceiling overrode. Shown to the agent. */
  clamped: string[];
}

export function clampPolicy(ceiling: PolicyConfig, requested: Partial<PolicyConfig> = {}): ClampResult {
  const clamped: string[] = [];
  const out: PolicyConfig = { ...ceiling };

  if (requested.mode) {
    if (RANK[requested.mode] > RANK[ceiling.mode]) {
      clamped.push(`mode "${requested.mode}" exceeds the operator's ceiling; using "${ceiling.mode}"`);
    } else {
      out.mode = requested.mode;
    }
  }

  for (const flag of ["allowShell", "allowInstall", "allowClearAppData"] as const) {
    const want = requested[flag];
    if (want === undefined) continue;
    if (want && !ceiling[flag]) clamped.push(`${flag} is disabled by the operator`);
    out[flag] = want && ceiling[flag];
  }

  if (requested.redactPasswordFields === false) {
    if (ceiling.redactPasswordFields) clamped.push("redactPasswordFields cannot be turned off by the agent");
    else out.redactPasswordFields = false;
  }

  if (requested.allowedApps?.length) {
    if (!ceiling.allowedApps.length) {
      out.allowedApps = [...requested.allowedApps];
    } else {
      const ok = requested.allowedApps.filter((p) => ceiling.allowedApps.some((c) => covers(c, p)));
      const refused = requested.allowedApps.filter((p) => !ok.includes(p));
      if (refused.length) clamped.push(`apps outside the operator's allowlist were dropped: ${refused.join(", ")}`);
      if (!ok.length) {
        throw err("policy_denied", "None of the requested apps are permitted on this phone", {
          hint: `The operator allows: ${ceiling.allowedApps.join(", ")}`,
        });
      }
      out.allowedApps = ok;
    }
  }

  if (requested.allowUrlSchemes) {
    const ok = requested.allowUrlSchemes.filter((s) => ceiling.allowUrlSchemes.includes(s));
    const refused = requested.allowUrlSchemes.filter((s) => !ok.includes(s));
    if (refused.length) clamped.push(`url schemes not permitted by the operator: ${refused.join(", ")}`);
    out.allowUrlSchemes = ok;
  }

  // Additive lists only ever add restrictions.
  out.blockedApps = union(ceiling.blockedApps, requested.blockedApps);
  out.confirmPatterns = union(ceiling.confirmPatterns, requested.confirmPatterns);
  out.blockPatterns = union(ceiling.blockPatterns, requested.blockPatterns);

  for (const limit of ["maxActionsPerSession", "maxSessionMinutes"] as const) {
    const want = requested[limit];
    if (want === undefined) continue;
    if (want > ceiling[limit]) clamped.push(`${limit} capped at the operator's ${ceiling[limit]}`);
    out[limit] = Math.min(want, ceiling[limit]);
  }

  return { policy: out, clamped };
}

let cache: { file: string; mtimeMs: number; policy: PolicyConfig } | undefined;

/**
 * The operator ceiling: DEFAULT_POLICY overlaid with policy.json.
 *
 * Re-read when the file changes, so tightening the policy applies to the next
 * session without a restart. A malformed file fails closed (observe mode)
 * rather than silently falling back to the defaults it was meant to restrict.
 */
export function loadCeiling(file = paths.policy): PolicyConfig {
  if (!existsSync(file)) return { ...DEFAULT_POLICY };
  const mtimeMs = statSync(file).mtimeMs;
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.policy;
  let policy: PolicyConfig;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const clean = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_")));
    policy = { ...DEFAULT_POLICY, ...(clean as Partial<PolicyConfig>) };
    if (!(policy.mode in RANK)) throw new Error(`unknown mode "${String(policy.mode)}"`);
  } catch (e) {
    log.error(`${file} is invalid (${(e as Error).message}); failing closed to observe-only`);
    policy = { ...DEFAULT_POLICY, mode: "observe" };
  }
  cache = { file, mtimeMs, policy };
  return policy;
}
