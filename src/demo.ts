import { ApprovalStore, approvals as defaultApprovals } from "./core/approvals.js";
import { Harness } from "./core/harness.js";
import { SecretStore } from "./core/secrets.js";
import { HarnessError } from "./core/errors.js";

/**
 * End-to-end demo on the built-in mock phone.
 *
 * Walks the exact flow that motivates the project — log in, collect an SMS
 * one-time code, then attempt a money transfer that must be gated on a human —
 * with no hardware attached.
 */

const BANK = "com.example.demobank";

const out = (s: string) => process.stdout.write(`${s}\n`);
const step = (n: number, s: string) => out(`\n── ${n}. ${s} ${"─".repeat(Math.max(0, 54 - s.length))}`);

/** Stands in for a human hitting `phone approve <id>` in another terminal. */
function simulatedOperator(store: ApprovalStore, delayMs = 800): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const a of store.list({ pendingOnly: true })) {
      out(`   [operator] approving ${a.id}: ${a.summary}  (reason: ${a.reason})`);
      store.decide(a.id, true, "demo-operator", "approved by the demo's simulated human");
    }
  }, delayMs);
  timer.unref();
  return timer;
}

export async function runDemo(opts: { autonomous?: boolean } = {}): Promise<void> {
  process.env.PHONE_SECRET_DEMO_PASSWORD = "correct-horse-battery-staple";
  const secretStore = new SecretStore("/nonexistent-demo-secrets.json");

  const harness = new Harness({ allowMockFallback: true });
  const session = await harness.createSession({
    deviceId: "mock:demo",
    secretStore,
    approvalStore: defaultApprovals,
    approvalWaitMs: 15_000,
    policy: {
      mode: opts.autonomous ? "autonomous" : "guarded",
      allowedApps: [BANK, "com.mock.launcher", "com.mock.messages"],
    },
  });

  const operator = opts.autonomous ? undefined : simulatedOperator(defaultApprovals);

  try {
    out(`Session ${session.id} on ${session.device.info.name} (mode=${session.policy.config.mode})`);

    step(1, "look at the home screen");
    const first = await session.observe();
    out(session.view(first).elements);

    step(2, "open the bank app");
    out(short(await session.openApp(BANK)));

    step(3, "fill the login form (password comes from the secret store)");
    out(short(await session.type("ada@example.com", { target: { selector: { label: "Username" } } })));
    out(short(await session.typeSecret("demo_password", { target: { selector: { label: "Password" } } })));

    step(4, "sign in — this triggers the SMS one-time code");
    out(short(await session.tap({ selector: { text: "Sign in" } })));

    step(5, "collect the one-time code from SMS, without a human");
    const otp = await session.waitForOtp({ digits: 6, bodyContains: "verification code", timeoutMs: 10_000 });
    out(`   code: ${otp.code}  (from ${"from" in otp.message ? otp.message.from : otp.message.pkg})`);

    step(6, "enter the code and verify");
    await session.type(otp.code, { target: { selector: { label: "Verification code" } } });
    out(short(await session.tap({ selector: { text: "Verify" } })));

    step(7, 'tap "Send money" — risky wording, so the harness gates it');
    out(short(await session.tap({ selector: { text: "Send money" } })));

    step(8, "fill the transfer form");
    out(short(await session.type("Grace Hopper", { target: { selector: { label: "Recipient" } } })));
    out(short(await session.type("25.00", { target: { selector: { label: "Amount" } } })));

    step(9, "bright lines the harness refuses outright, approval or not");
    await expectRefusal("type a payment card number", () =>
      session.type("4111 1111 1111 1111", { target: { selector: { label: "Recipient" } } }),
    );
    await expectRefusal("wander into Settings", () => session.openApp("com.android.settings"));

    step(10, "confirm the transfer — gated again, because money moves");
    out(short(await session.tap({ selector: { text: "Confirm transfer" } })));

    const stats = session.stats();
    out(`\nDone. ${stats.actions} actions in ${(stats.uptimeMs / 1000).toFixed(1)}s.`);
    out(`Audit trail: ${stats.tracePath}`);
    out(`Replay it with: phone trace ${session.id}`);
  } finally {
    if (operator) clearInterval(operator);
    await harness.close(session.id);
  }
}

async function expectRefusal(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    out(`   ✗ ${what}: NOT refused — that is a bug`);
  } catch (e) {
    if (e instanceof HarnessError) out(`   ✓ ${what}: refused (${e.code}) — ${e.message}`);
    else throw e;
  }
}

function short(r: { action: string; target?: string; change: string; screen: { app?: string; activity?: string } }): string {
  return `   ${r.action} ${r.target ?? ""} → ${r.change}`;
}
