import { loadConfig } from "../core/config.js";
import { HarnessError } from "../core/errors.js";
import { secrets } from "../core/secrets.js";
import type { ActionResult, BatchResult, Session } from "../core/session.js";

/**
 * Text renderings shared by the MCP tools and the REST `?format=text` mode, so
 * an agent driving over curl sees exactly what an MCP agent sees.
 *
 * Everything leaving the harness passes through `scrub` as a last line of
 * defence: a secret that slipped into an element's text, an error message or
 * an error's details is replaced before it reaches the model.
 */

export const scrub = (s: string): string => secrets.redact(s);

const MODE_NOTE: Record<string, string> = {
  unchanged: "",
  partial: "\n(only the changed elements are shown; everything else is as in the previous screen)",
  full: "",
};

export function renderScreen(screen: ActionResult["screen"]): string {
  const barren = screen.barren
    ? "\n\nNOTE: this screen exposes almost no accessibility data (a canvas/Flutter/game surface). " +
      "Element selectors will not work here — call phone_screenshot and tap by x/y coordinates."
    : "";
  return `${screen.elements}${screen.truncated ? "\n(tree truncated)" : ""}${MODE_NOTE[screen.mode] ?? ""}${barren}`;
}

export function renderAction(r: ActionResult): string {
  const head = `✓ ${r.action}${r.target ? ` → ${r.target}` : ""}`;
  const meta = [r.change, r.settled ? null : "NOT SETTLED — UI still animating"].filter(Boolean).join(" | ");
  const note = r.note ? `\n${r.note}` : "";
  const extra = r.data !== undefined ? `\n\n${JSON.stringify(r.data, null, 2)}` : "";
  return scrub(`${head}\n${meta}${note}\n\n${renderScreen(r.screen)}${extra}`);
}

export function renderBatch(r: BatchResult): string {
  const lines = r.steps.map((st) => {
    const head = `${st.ok ? "✓" : "✗"} ${st.index}. ${st.action}${st.target ? ` → ${st.target}` : ""}`;
    if (st.ok) return `${head}${st.change ? `  (${st.change})` : ""}`;
    return (
      `${head}\n     ${st.code ? `[${st.code}] ` : ""}${st.error}${st.hint ? `\n     hint: ${st.hint}` : ""}` +
      `${st.approvalId ? `\n     approvalId: ${st.approvalId}` : ""}`
    );
  });
  const summary =
    `${r.ok ? "batch complete" : "batch stopped"}: ${r.completed}/${r.total} steps` +
    `${r.stoppedAt !== undefined ? ` (stopped at step ${r.stoppedAt})` : ""}`;
  const remaining =
    r.stoppedAt !== undefined
      ? `\n\n${r.total - r.completed} step(s) were not attempted. Re-send them once the problem above is resolved.`
      : "";
  return scrub(`${summary}\n${lines.join("\n")}${remaining}\n\n${renderScreen(r.screen)}`);
}

/** What an agent should know about the phone's identity and where codes will arrive. */
export function identityBlock(session: Session): string {
  const cfg = loadConfig();
  const lines: string[] = [];
  if (cfg.identity.phoneNumber) lines.push(`phone number: ${cfg.identity.phoneNumber} (use this when a form asks for your number)`);
  if (cfg.identity.email) lines.push(`email: ${cfg.identity.email}`);
  const where = ["SMS on the device", "notifications"];
  if (cfg.sources.telnyxPublicKey || cfg.sources.twilioAuthToken || cfg.sources.relayToken) where.push("the connected number");
  if (cfg.sources.imap) where.push(`the mailbox ${cfg.sources.imap.user}`);
  lines.push(`one-time codes are collected from: ${where.join(", ")} — use phone_wait_for_otp`);
  if (session.device.info.transport === "emulator" && !cfg.identity.phoneNumber) {
    lines.push("this is a virtual phone with no SIM and no number configured: real SMS cannot reach it");
  }
  return lines.join("\n");
}

export function renderHandoff(r: { id: string; status: "done" | "declined" | "pending"; note?: string }): string {
  if (r.status === "done") return scrub(`done — the human finished${r.note ? `: ${r.note}` : ""}. Observe the screen before continuing.`);
  if (r.status === "declined") {
    return scrub(`declined${r.note ? `: ${r.note}` : ""}. Do not try to work around this; report it and stop.`);
  }
  return (
    `pending — the owner has been notified (handoffId ${r.id}). Call request_human again with ` +
    `handoffId="${r.id}" to keep waiting. Do not act on the phone meanwhile.`
  );
}

/** Errors carry a `hint` precisely so an agent can recover without a human. */
export function renderError(e: unknown): string {
  if (e instanceof HarnessError) {
    return scrub(
      JSON.stringify(
        {
          error: e.message,
          code: e.code,
          ...(e.hint ? { hint: e.hint } : {}),
          ...(e.details ? { details: e.details } : {}),
        },
        null,
        2,
      ),
    );
  }
  return scrub(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2));
}
