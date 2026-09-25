#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { approvals } from "./core/approvals.js";
import { HarnessError } from "./core/errors.js";
import { Harness } from "./core/harness.js";
import { setLogLevel, type LogLevel } from "./core/logger.js";
import { paths } from "./core/paths.js";
import { secrets } from "./core/secrets.js";
import { ensureServerCredentials, loadConfig, updateConfigFile } from "./core/config.js";
import { mintLoginCode } from "./core/login-codes.js";
import { inbox } from "./core/messages/index.js";
import { notifyOperator } from "./core/notify.js";
import { readRuntime } from "./core/runtime.js";
import { VERSION } from "./version.js";
import { AndroidProvider } from "./providers/android/index.js";
import { VirtualPhoneManager, DEFAULT_AVD } from "./virtual/index.js";
import type { Session } from "./core/session.js";
import type { Selector } from "./core/types.js";
import type { PolicyMode } from "./core/policy.js";

const program = new Command();

program
  .name("agent-phone")
  .description("Give an agent its own phone. Drive Android/iOS from the shell, or expose them over MCP/HTTP.")
  .version(VERSION)
  .option("--log <level>", "debug|info|warn|error|silent", "info")
  .hook("preAction", (cmd) => setLogLevel((cmd.opts().log as LogLevel) ?? "info"));

interface GlobalTargetOpts {
  device?: string;
  mode?: PolicyMode;
  app?: string[];
  mock?: boolean;
  /** commander sets this to false for --no-redact */
  redact?: boolean;
}

function targetOptions(cmd: Command): Command {
  return cmd
    .option("-d, --device <id>", 'device id, e.g. "android:XXXX", "ios:<udid>", "mock:demo"')
    .option("-m, --mode <mode>", "observe|guarded|autonomous", "guarded")
    .option("--app <id...>", "restrict the session to these package/bundle ids")
    .option("--mock", "allow falling back to the built-in mock phone");
}

async function withSession<T>(opts: GlobalTargetOpts, fn: (s: Session) => Promise<T>): Promise<T> {
  const harness = new Harness({ allowMockFallback: Boolean(opts.mock) });
  const session = await harness.createSession({
    ...(opts.device ? { deviceId: opts.device } : {}),
    policy: {
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.app?.length ? { allowedApps: opts.app } : {}),
      ...(opts.redact === false ? { redactPasswordFields: false } : {}),
    },
  });
  try {
    return await fn(session);
  } finally {
    await harness.close(session.id);
  }
}

function selectorFrom(o: { text?: string; contains?: string; id?: string; role?: string; index?: number }): Selector {
  const s: Selector = {};
  if (o.text) s.text = o.text;
  if (o.contains) s.textContains = o.contains;
  if (o.id) s.id = o.id;
  if (o.role) s.role = o.role;
  if (o.index !== undefined) s.index = Number(o.index);
  return s;
}

function die(e: unknown): never {
  if (e instanceof HarnessError) {
    process.stderr.write(`error [${e.code}]: ${e.message}\n`);
    if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
  } else {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.exit(1);
}

// ------------------------------------------------------------------ discovery

program
  .command("devices")
  .description("List reachable phones")
  .action(async () => {
    try {
      const devices = await new Harness().listDevices();
      if (!devices.length) {
        process.stdout.write("no devices found — run `agent-phone doctor`\n");
        return;
      }
      for (const d of devices) {
        process.stdout.write(
          `${d.id.padEnd(46)} ${d.name.padEnd(26)} ${d.platform}/${d.transport} ${d.state}` +
            `${d.osVersion ? ` os=${d.osVersion}` : ""}\n`,
        );
      }
    } catch (e) {
      die(e);
    }
  });

program
  .command("doctor")
  .description("Check tooling and report exactly what to install")
  .action(async () => {
    const reports = await new Harness().doctor();
    let allOk = true;

    process.stdout.write("\n[virtual — no hardware needed]\n");
    for (const c of await new VirtualPhoneManager().requirements()) {
      process.stdout.write(`  ${c.ok ? "ok  " : "MISS"}  ${c.name.padEnd(16)} ${c.detail}\n`);
    }
    const { avds, running } = await new VirtualPhoneManager().list();
    process.stdout.write(`  created: ${avds.join(", ") || "none"}    running: ${running.join(", ") || "none"}\n`);
    process.stdout.write("  note: emulators fail Play Integrity — banking/fintech apps may refuse to run\n");

    for (const r of reports) {
      process.stdout.write(`\n[${r.platform}]\n`);
      for (const c of r.checks) {
        if (!c.ok && r.platform !== "mock") allOk = false;
        process.stdout.write(`  ${c.ok ? "ok  " : "MISS"}  ${c.name.padEnd(16)} ${c.detail}\n`);
      }
      if (r.error) process.stdout.write(`  error: ${r.error}\n`);
      process.stdout.write(`  devices: ${r.devices.length ? r.devices.map((d) => d.id).join(", ") : "none"}\n`);
    }
    process.stdout.write(
      `\n${allOk ? "All providers ready." : "Start a phone with no hardware:  agent-phone up"}\n`,
    );
  });

// ------------------------------------------------------------------ virtual phone

program
  .command("up")
  .description("Create and boot a virtual phone — no hardware, no SIM, no cable")
  .option("--name <name>", "virtual device name", DEFAULT_AVD)
  .option("--api <n>", "Android API level", "34")
  .option("--variant <v>", "google_apis_playstore (Play Store) | google_apis (rootable)")
  .option("--window", "show the emulator window instead of running headless")
  .option("--wipe", "start from a clean state")
  .option("--no-install", "fail instead of downloading missing SDK packages")
  .action(async (o) => {
    try {
      const phone = await new VirtualPhoneManager().up({
        name: o.name,
        api: Number(o.api),
        ...(o.variant ? { variant: o.variant } : {}),
        headless: !o.window,
        wipe: Boolean(o.wipe),
        noInstall: o.install === false,
        onProgress: (m) => process.stderr.write(`  ${m}\n`),
      });
      process.stdout.write(`${phone.deviceId}\n`);
      process.stderr.write(
        `\nAn agent can use it now. Nothing else to configure.\n` +
          `  try it:   agent-phone observe -d ${phone.deviceId}\n` +
          `  stop it:  agent-phone down\n`,
      );
    } catch (e) {
      die(e);
    }
  });

program
  .command("down")
  .description("Shut down running virtual phones")
  .option("-d, --device <id>", "only this one")
  .action(async (o) => {
    try {
      const stopped = await new VirtualPhoneManager().down({ ...(o.device ? { serial: o.device } : {}) });
      process.stdout.write(stopped.length ? `stopped ${stopped.join(", ")}\n` : "nothing running\n");
    } catch (e) {
      die(e);
    }
  });

program
  .command("destroy")
  .description("Delete a virtual phone and all of its state")
  .option("--name <name>", "virtual device name", DEFAULT_AVD)
  .action(async (o) => {
    try {
      await new VirtualPhoneManager().destroy(o.name);
      process.stdout.write(`deleted ${o.name}\n`);
    } catch (e) {
      die(e);
    }
  });

program
  .command("connect <hostPort>")
  .description("adb connect to a phone over the network (e.g. a Tailscale address)")
  .action(async (hostPort: string) => {
    try {
      const id = await new AndroidProvider().connect(hostPort);
      process.stdout.write(`${id}\n`);
    } catch (e) {
      die(e);
    }
  });

// ------------------------------------------------------------------ perception

targetOptions(program.command("observe").description("Print the current screen as an element tree"))
  .option("--bounds", "show full bounds instead of tap centers")
  .option("--max-chars <n>", "render budget", "6000")
  .action(async (o) => {
    try {
      await withSession(o, async (s) => {
        const snap = await s.observe();
        const view = s.view(snap, { maxChars: Number(o.maxChars), bounds: Boolean(o.bounds) });
        process.stdout.write(`${view.elements}\n`);
      });
    } catch (e) {
      die(e);
    }
  });

targetOptions(program.command("shot").description("Save a screenshot"))
  .option("-o, --out <file>", "output path", "screen.png")
  .option("--marks", "draw numbered boxes on interactive elements")
  .option("--max-size <n>", "longest edge in px", "1000")
  .option("--no-redact", "capture even when password fields cannot be located (needs no accessibility tree)")
  .action(async (o) => {
    try {
      await withSession({ ...o, redact: o.redact }, async (s) => {
        const shot = await s.screenshot({ marks: Boolean(o.marks), maxSize: Number(o.maxSize) });
        writeFileSync(o.out, shot.data);
        process.stdout.write(`${o.out} (${shot.width}x${shot.height})\n`);
      });
    } catch (e) {
      die(e);
    }
  });

// ------------------------------------------------------------------ actions

targetOptions(program.command("tap").description("Tap an element"))
  .option("--text <t>", "exact visible text")
  .option("--contains <t>", "substring of visible text")
  .option("--id <id>", "resource-id / identifier")
  .option("--role <r>", "Button, TextField, Cell ...")
  .option("--index <n>", "which match to take")
  .option("--ref <ref>", "ref from a previous observe (same process only)")
  .option("--at <x,y>", "raw coordinates")
  .action(async (o) => {
    try {
      await withSession(o, async (s) => {
        const target = o.at
          ? { point: o.at.split(",").map(Number) as [number, number] }
          : { selector: selectorFrom(o) };
        const r = await s.tap(target);
        process.stdout.write(`${r.change}\n\n${r.screen.elements}\n`);
      });
    } catch (e) {
      die(e);
    }
  });

targetOptions(program.command("type <text>").description("Type text into the focused field (or --id/--text target)"))
  .option("--text-target <t>", "focus the element with this text first")
  .option("--id <id>", "focus the element with this id first")
  .option("--submit", "press enter afterwards")
  .action(async (text: string, o) => {
    try {
      await withSession(o, async (s) => {
        const sel = selectorFrom({ text: o.textTarget, id: o.id });
        const r = await s.type(text, {
          ...(Object.keys(sel).length ? { target: { selector: sel } } : {}),
          submit: Boolean(o.submit),
        });
        process.stdout.write(`${r.change}\n`);
      });
    } catch (e) {
      die(e);
    }
  });

targetOptions(program.command("key <name>").description("Press back|home|recents|enter|delete|..."))
  .action(async (name: string, o) => {
    try {
      await withSession(o, async (s) => {
        const r = await s.pressKey(name as never);
        process.stdout.write(`${r.change}\n`);
      });
    } catch (e) {
      die(e);
    }
  });

targetOptions(program.command("open <appId>").description("Launch an app by package/bundle id")).action(
  async (appId: string, o) => {
    try {
      await withSession(o, async (s) => {
        const r = await s.openApp(appId);
        process.stdout.write(`${r.change}\n\n${r.screen.elements}\n`);
      });
    } catch (e) {
      die(e);
    }
  },
);

targetOptions(program.command("url <url>").description("Open a URL or deep link")).action(async (url: string, o) => {
  try {
    await withSession(o, async (s) => {
      const r = await s.openUrl(url);
      process.stdout.write(`${r.change}\n\n${r.screen.elements}\n`);
    });
  } catch (e) {
    die(e);
  }
});

targetOptions(program.command("apps").description("List installed apps"))
  .option("--third-party", "only non-system apps")
  .action(async (o) => {
    try {
      await withSession(o, async (s) => {
        const apps = await s.device.listApps();
        for (const a of apps.filter((x) => !o.thirdParty || !x.system)) {
          process.stdout.write(`${a.id}${a.name ? `  (${a.name})` : ""}${a.system ? "  [system]" : ""}\n`);
        }
      });
    } catch (e) {
      die(e);
    }
  });

targetOptions(program.command("sms").description("Read recent messages from the device and every connected source"))
  .option("--limit <n>", "how many", "10")
  .action(async (o) => {
    try {
      await withSession(o, async (s) => {
        const r = await s.readMessages({ limit: Number(o.limit) });
        for (const m of r.messages) {
          process.stdout.write(`[${new Date(m.receivedAt).toISOString()}] (${m.origin}) ${m.from}: ${m.body}\n`);
        }
        for (const e of r.errors) process.stderr.write(`could not read ${e.source}: ${e.error}\n`);
      });
    } catch (e) {
      die(e);
    }
  });

targetOptions(program.command("otp").description("Wait for a one-time code and print it"))
  .option("--from <s>", "filter by sender")
  .option("--body <s>", "filter by message content")
  .option("--digits <n>", "exact code length, if known")
  .option("--timeout <ms>", "how long to wait", "60000")
  .action(async (o) => {
    try {
      await withSession(o, async (s) => {
        const r = await s.waitForOtp({
          ...(o.from ? { fromContains: o.from } : {}),
          ...(o.body ? { bodyContains: o.body } : {}),
          ...(o.digits ? { digits: Number(o.digits) } : {}),
          timeoutMs: Number(o.timeout),
        });
        process.stdout.write(`${r.code}\n`);
      });
    } catch (e) {
      die(e);
    }
  });

// ------------------------------------------------------------------ approvals

program
  .command("approvals")
  .description("List approval requests raised by running sessions")
  .option("--pending", "only pending")
  .action((o) => {
    const list = approvals.list({ pendingOnly: Boolean(o.pending) });
    if (!list.length) {
      process.stdout.write("none\n");
      return;
    }
    for (const a of list) {
      process.stdout.write(
        `${a.id}  ${a.status.padEnd(9)} ${a.type === "handoff" ? "HANDOFF " : ""}session=${a.sessionId}  ${a.summary}\n` +
          `        reason: ${a.reason}\n` +
          (a.evidence ? `        evidence: ${a.evidence}\n` : ""),
      );
    }
  });

program
  .command("approve <id>")
  .description("Approve a gated action, or mark a handoff done (operator only — agents cannot call this)")
  .option("--note <text>", "note recorded in the audit trail")
  .action((id: string, o) => {
    const r = approvals.decide(id, true, process.env.USER ?? "operator", o.note);
    if (!r) die(new HarnessError("bad_request", `no approval ${id}`));
    process.stdout.write(`${r.id}: ${r.status}\n`);
  });

program
  .command("deny <id>")
  .description("Deny a gated action")
  .option("--note <text>", "reason")
  .action((id: string, o) => {
    const r = approvals.decide(id, false, process.env.USER ?? "operator", o.note);
    if (!r) die(new HarnessError("bad_request", `no approval ${id}`));
    process.stdout.write(`${r.id}: ${r.status}\n`);
  });

// ------------------------------------------------------------------ secrets

const secret = program.command("secret").description("Manage secrets the agent can type but never read");

secret
  .command("list")
  .description("List secret names (never values)")
  .action(() => {
    secrets.reload();
    const keys = secrets.keys();
    process.stdout.write(keys.length ? `${keys.join("\n")}\n` : "none\n");
  });

secret
  .command("set <key>")
  .description("Store a secret; the value is read from stdin so it never lands in shell history")
  .action(async (key: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    const value: string = await new Promise((resolve) => {
      rl.question(`value for "${key}": `, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
    if (!value) die(new HarnessError("bad_request", "empty value"));
    secrets.set(key, value);
    process.stdout.write(`stored "${key}" in ${paths.secrets} (mode 600)\n`);
  });

// ------------------------------------------------------------------ trace

program
  .command("trace <sessionId>")
  .description("Replay a session's audit trail")
  .action((sessionId: string) => {
    const file = `${paths.sessions}/${sessionId}/trace.jsonl`;
    if (!existsSync(file)) die(new HarnessError("bad_request", `no trace at ${file}`));
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as {
        seq: number; ts: number; kind: string; ok: boolean;
        args?: { label?: string }; result?: { change?: string }; error?: string;
      };
      process.stdout.write(
        `${String(e.seq).padStart(3)} ${new Date(e.ts).toISOString()} ${e.ok ? "ok " : "ERR"} ` +
          `${e.kind.padEnd(16)} ${e.args?.label ?? ""} ${e.result?.change ? `→ ${e.result.change}` : ""}${e.error ? ` :: ${e.error}` : ""}\n`,
      );
    }
  });

// ------------------------------------------------------------------ servers

/** Where a human should point a browser: the public URL if there is one, else local. */
function serverBase(): string | undefined {
  const rt = readRuntime();
  return loadConfig().publicUrl ?? rt?.publicUrl ?? rt?.localUrl;
}

function connectionBlock(base: string, agentToken: string, panelLink: string): string {
  const prompt =
    `You have an Android phone you can control. Its API is at ${base} and your token is ${agentToken}. ` +
    `Before using it, fetch ${base}/agent.md and follow those instructions. Send the token as ` +
    "`Authorization: Bearer <token>` on every request.";
  const rule = "─".repeat(64);
  return [
    "",
    "  Operator panel (one-time sign-in link, valid 15 minutes):",
    `    ${panelLink}`,
    "",
    "  Give your agent — MCP clients:",
    `    URL     ${base}/mcp`,
    `    Header  Authorization: Bearer ${agentToken}`,
    "",
    "  Give your agent — Instinct and other browsing/scripting agents, paste this:",
    `  ${rule}`,
    prompt.replace(/(.{1,90})(\s|$)/g, "  $1\n").trimEnd(),
    `  ${rule}`,
    "",
    "  The agent token is safe to give an agent. Never give it the operator token",
    "  (`agent-phone token` shows both).",
    "",
  ].join("\n");
}

program
  .command("serve")
  .description("Run the HTTP server: operator panel, MCP over HTTP, REST, SMS webhooks")
  .option("-p, --port <n>", "port", "8712")
  .option("--host <h>", "bind address", "127.0.0.1")
  .option("--public", "expose it on a public HTTPS URL through a Cloudflare tunnel, so cloud agents can reach it")
  .option("--public-url <url>", "the public URL, if you already route one here (named tunnel, reverse proxy)")
  .option("--no-auth", "no tokens at all — loopback only, for local development")
  .option("--mock", "allow the built-in mock phone")
  .action(async (o) => {
    try {
      const { serve } = await import("./http/server.js");
      const s = await serve({
        port: Number(o.port),
        host: o.host,
        allowMockFallback: Boolean(o.mock),
        ...(o.auth === false ? { auth: false } : {}),
        ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
        android: { useAdbKeyboard: process.env.PHONE_ADB_KEYBOARD === "1" },
      });
      let stopTunnel: (() => void) | undefined;
      if (o.public) {
        if (o.auth === false) die(new HarnessError("bad_request", "--public requires authentication; drop --no-auth"));
        const { startTunnel } = await import("./http/tunnel.js");
        process.stderr.write("starting a Cloudflare tunnel…\n");
        const t = await startTunnel(s.localUrl);
        stopTunnel = t.stop;
        if (t.url) s.setPublicUrl(t.url);
      }
      const base = s.publicUrl() ?? s.localUrl;
      if (s.agentToken) {
        process.stdout.write(connectionBlock(base, s.agentToken, `${base}/panel/#code=${mintLoginCode()}`));
        if (!o.public && !s.publicUrl()) {
          process.stdout.write(
            "\n  This address only works on this machine. Add --public to reach it from a cloud agent.\n\n",
          );
        }
      } else {
        process.stdout.write(`\n  No authentication. Panel: ${base}/panel/   MCP: ${base}/mcp\n\n`);
      }
      const shutdown = async () => {
        stopTunnel?.();
        await s.close().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (e) {
      die(e);
    }
  });

program
  .command("connect-info")
  .description("Print how to connect an agent and sign in to the panel, for a server that is already running")
  .option("--wait <seconds>", "wait this long for a public URL to appear (tunnels take a few seconds)", "0")
  .action(async (o) => {
    const deadline = Date.now() + Number(o.wait) * 1000;
    let base = serverBase();
    while ((!base || base.startsWith("http://127.")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      base = serverBase();
    }
    if (!base) die(new HarnessError("bad_request", "No running server found", { hint: "Start one with `agent-phone serve`." }));
    try {
      const c = ensureServerCredentials();
      process.stdout.write(connectionBlock(base, c.agentToken, `${base}/panel/#code=${mintLoginCode()}`));
    } catch (e) {
      die(e);
    }
  });

program
  .command("panel-link")
  .description("Print a one-time sign-in link for the operator panel")
  .option("--base <url>", "server URL, if it cannot be detected")
  .action((o) => {
    const base = o.base ?? serverBase();
    if (!base) die(new HarnessError("bad_request", "No running server found", { hint: "Start one with `agent-phone serve`, or pass --base." }));
    process.stdout.write(`${base}/panel/#code=${mintLoginCode()}\n`);
  });

program
  .command("token")
  .description("Show the agent and operator tokens (creating them on first use)")
  .action(() => {
    try {
      const c = ensureServerCredentials();
      process.stdout.write(
        `agent token     ${c.agentToken}\n    give this to your agent\n` +
          `operator token  ${c.operatorToken}\n    for you only — it approves the agent's actions\n`,
      );
    } catch (e) {
      die(e);
    }
  });

program
  .command("identity")
  .description("Set the number and email the agent should give when a form asks")
  .option("--number <e164>", "e.g. +15551234567")
  .option("--email <address>")
  .action((o) => {
    const c = updateConfigFile((x) => {
      if (o.number !== undefined) x.identity.phoneNumber = o.number || undefined;
      if (o.email !== undefined) x.identity.email = o.email || undefined;
    });
    process.stdout.write(`number: ${c.identity.phoneNumber ?? "(none)"}\nemail:  ${c.identity.email ?? "(none)"}\n`);
  });

const inboxCmd = program.command("inbox").description("Messages delivered by webhooks (SMS providers, relay phones)");
inboxCmd
  .command("list", { isDefault: true })
  .option("--limit <n>", "how many", "20")
  .action((o) => {
    const list = inbox.list({ limit: Number(o.limit) });
    if (!list.length) process.stdout.write("empty\n");
    for (const m of list) {
      process.stdout.write(`[${new Date(m.receivedAt).toISOString()}] (${m.origin}) ${m.from}: ${m.body}\n`);
    }
  });
inboxCmd
  .command("add <body>")
  .description("Drop a test message in, as if a provider had delivered it")
  .option("--from <sender>", "sender", "Test")
  .action((body: string, o) => {
    const m = inbox.add({ id: `test-${Date.now()}`, origin: "test", from: o.from, body, timestamp: Date.now() });
    process.stdout.write(m ? "added\n" : "duplicate\n");
  });

program
  .command("notify-test")
  .description("Send a test notification to every configured channel")
  .action(async () => {
    const results = await notifyOperator({ kind: "test", title: "agent-phone test", body: "Notifications are working.", path: "/panel/" });
    if (!results.length) process.stdout.write("no channels configured (panel → Setup → Notifications)\n");
    for (const r of results) process.stdout.write(`${r.channel.padEnd(9)} ${r.ok ? "sent" : `FAILED: ${r.error}`}\n`);
  });

program
  .command("mcp")
  .description("Run the MCP server on stdio (for Claude Code, Instinct, any MCP client)")
  .action(async () => {
    await import("./mcp/stdio.js");
  });

// ------------------------------------------------------------------ demo

program
  .command("demo")
  .description("Run an end-to-end task on the built-in mock phone: login, SMS OTP, gated transfer")
  .option("--autonomous", "skip the human approval gate (shows the transfer completing)")
  .action(async (o) => {
    const { runDemo } = await import("./demo.js");
    await runDemo({ autonomous: Boolean(o.autonomous) }).catch(die);
  });

program.parseAsync(process.argv).catch(die);
