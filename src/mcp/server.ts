import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Harness, type HarnessOptions } from "../core/harness.js";
import { registerPhoneTools } from "./tools.js";

export function createPhoneMcpServer(opts: HarnessOptions = {}): { server: McpServer; harness: Harness } {
  const harness = new Harness(opts);
  const server = new McpServer(
    { name: "agent-phone-harness", version: "0.1.0" },
    {
      instructions:
        "Drive a real phone. Start with phone_session_start, then loop: phone_observe to see the screen, " +
        "phone_tap / phone_type to act. Every action returns the resulting screen, so you rarely need a second " +
        "observe. Target elements by selector (text/id/role) rather than ref or coordinates whenever the screen " +
        "may have changed. Prefer phone_open_url with a deep link over long tap sequences. For 2FA, use " +
        "phone_wait_for_otp. Never type passwords or codes you were given out-of-band with phone_type — use " +
        "phone_type_secret. Risky actions (paying, sending, deleting) require a human approval you cannot grant " +
        "yourself; if one is pending, stop and report it rather than looking for a way around it.",
    },
  );
  registerPhoneTools(server, harness);
  return { server, harness };
}
