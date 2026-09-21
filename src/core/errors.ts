export type ErrorCode =
  | "device_unreachable"
  | "device_not_found"
  | "tool_missing"
  | "timeout"
  | "stale_ref"
  | "no_match"
  | "ambiguous"
  | "unsupported"
  | "policy_denied"
  | "awaiting_approval"
  | "budget_exceeded"
  | "session_not_found"
  | "bad_request"
  | "provider_error";

export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  /** Actionable next step for the agent — this is what makes recovery possible. */
  readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "HarnessError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toJSON() {
    return { ok: false, code: this.code, error: this.message, hint: this.hint, details: this.details };
  }
}

export const err = (
  code: ErrorCode,
  message: string,
  opts?: { hint?: string; details?: Record<string, unknown>; cause?: unknown },
) => new HarnessError(code, message, opts ?? {});
