export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let current: LogLevel = (process.env.PHONE_LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(l: LogLevel) {
  current = l;
}

/**
 * Always writes to stderr — stdout is reserved for the MCP stdio transport and
 * for machine-readable CLI output.
 */
function emit(level: LogLevel, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < ORDER[current]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) process.stderr.write(`${line} ${safe(extra)}\n`);
  else process.stderr.write(`${line}\n`);
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
  };
}
