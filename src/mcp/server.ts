import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Harness, type HarnessOptions, type Owner } from "../core/harness.js";
import { VERSION } from "../version.js";
import { registerPhoneTools } from "./tools.js";

export const INSTRUCTIONS =
  "Drive a real phone. Start with phone_session_start, then loop: phone_observe to see the screen, " +
  "phone_tap / phone_type to act. Every action returns the resulting screen, so you rarely need a second " +
  "observe. Target elements by selector (text/id/role) rather than ref or coordinates whenever the screen " +
  "may have changed.\n\n" +
  "Two habits make you much faster. First, when you can predict two or more steps — a login form, a " +
  "wizard, entering a code and submitting — send them together with phone_batch instead of one call per " +
  "tap. Second, before navigating by hand, call phone_list_deep_links: opening a declared URL usually " +
  "replaces a whole sequence of taps.\n\n" +
  "For 2FA, call phone_wait_for_otp with enter:true and the code field as target. Never type passwords or " +
  "codes you were given out-of-band with phone_type — use phone_type_secret. Risky actions (paying, " +
  "sending, deleting) require a human approval you cannot grant yourself; if one is pending, stop and " +
  "report it rather than looking for a way around it. For anything only a human should do — a CAPTCHA, a " +
  "Google sign-in, a biometric prompt — call phone_request_human instead of attempting it.";

export interface PhoneMcpOptions extends HarnessOptions {
  /** Share an existing harness (the HTTP server does, so the panel sees MCP sessions). */
  harness?: Harness;
  owner?: Owner;
}

export function createPhoneMcpServer(opts: PhoneMcpOptions = {}): { server: McpServer; harness: Harness } {
  const harness = opts.harness ?? new Harness(opts);
  const server = new McpServer({ name: "agent-phone-harness", version: VERSION }, { instructions: INSTRUCTIONS });
  registerPhoneTools(server, harness, { ...(opts.owner ? { owner: opts.owner } : {}) });
  return { server, harness };
}
