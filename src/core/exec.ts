import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { err } from "./errors.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes — needed for binary payloads like `adb exec-out screencap -p`. */
  stdoutBuffer: Buffer;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Pass stdin. */
  input?: string | Buffer;
  env?: Record<string, string>;
  cwd?: string;
  /** Treat non-zero exit as success (caller inspects .code). */
  allowFailure?: boolean;
}

/**
 * Injectable command runner.
 *
 * Providers take a Runner rather than calling spawn directly, which is what
 * makes them unit-testable with no hardware attached: tests pass a fake that
 * returns recorded fixture output for a given argv.
 */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const child = spawn(cmd, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
    });

    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        err("timeout", `\`${cmd} ${args.join(" ")}\` timed out after ${timeoutMs}ms`, {
          hint: "Device may be asleep or disconnected. Try `phone doctor`.",
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e.code === "ENOENT") {
        reject(
          err("tool_missing", `\`${cmd}\` not found on PATH`, {
            hint: `Install it, or point the harness at it explicitly. Run \`phone doctor\`.`,
            cause: e,
          }),
        );
        return;
      }
      reject(err("provider_error", `spawn ${cmd} failed: ${e.message}`, { cause: e }));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(out);
      const result: ExecResult = {
        code: code ?? -1,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        stdoutBuffer,
      };
      if (result.code !== 0 && !opts.allowFailure) {
        reject(
          err("provider_error", `\`${cmd} ${args.join(" ")}\` exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`, {
            details: { code: result.code },
          }),
        );
        return;
      }
      resolve(result);
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });

/** Does `cmd` exist on PATH? */
export async function which(cmd: string, run: Runner = runCommand): Promise<string | null> {
  try {
    const r = await run("/usr/bin/which", [cmd], { timeoutMs: 5000, allowFailure: true });
    const p = r.stdout.trim().split("\n")[0]?.trim();
    return r.code === 0 && p ? p : null;
  } catch {
    return null;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Launch a long-running process that outlives this call.
 *
 * `Runner` waits for exit, which is wrong for an emulator: it runs for hours.
 * Returns once the child is spawned, not once it finishes.
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; logFile?: string } = {},
): { pid: number | undefined } {
  const out = opts.logFile ? openSync(opts.logFile, "a") : "ignore";
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  child.unref();
  return { pid: child.pid };
}
