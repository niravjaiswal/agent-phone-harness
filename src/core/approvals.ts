import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureDir } from "./paths.js";
import { sleep } from "./exec.js";
import { logger } from "./logger.js";
import { notifyOperator } from "./notify.js";
import type { ActionDescriptor } from "./policy.js";

const log = logger("approvals");

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  /**
   * approval — the agent wants to do something risky; a human says yes or no.
   * handoff  — the agent needs a human to do something (CAPTCHA, sign-in); a human does it and hands back.
   */
  type?: "approval" | "handoff";
  sessionId: string;
  deviceId?: string;
  createdAt: number;
  expiresAt: number;
  action: ActionDescriptor;
  summary: string;
  reason: string;
  /** Path to the evidence screenshot taken immediately before the gated action. */
  evidence?: string;
  status: ApprovalStatus;
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
}

/**
 * Out-of-band human approval for risky actions.
 *
 * File-backed on purpose: an operator running `agent-phone approve <id>` in another
 * terminal, an HTTP call, or a webhook consumer can all decide, with no daemon
 * and no shared process. Critically, *no MCP tool is wired to `decide`* — an
 * agent cannot approve its own action.
 */
export class ApprovalStore {
  constructor(
    private dir: string = paths.approvals,
    /** Push to the operator's configured channels. Off for throwaway stores (tests). */
    private notifications = true,
  ) {
    ensureDir(this.dir);
  }

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  create(input: {
    sessionId: string;
    type?: "approval" | "handoff";
    deviceId?: string;
    action: ActionDescriptor;
    summary: string;
    reason: string;
    evidence?: string;
    ttlMs?: number;
  }): ApprovalRequest {
    const now = Date.now();
    const req: ApprovalRequest = {
      id: randomUUID().slice(0, 8),
      type: input.type ?? "approval",
      sessionId: input.sessionId,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? 5 * 60_000),
      action: input.action,
      summary: input.summary,
      reason: input.reason,
      evidence: input.evidence,
      status: "pending",
    };
    writeFileSync(this.file(req.id), JSON.stringify(req, null, 2), { mode: 0o600 });
    if (req.type === "handoff") {
      log.warn(`agent asked for a human [${req.id}]: ${req.reason}`);
      log.warn(`when done: agent-phone approve ${req.id}    to decline: agent-phone deny ${req.id}`);
    } else {
      log.warn(`approval required [${req.id}]: ${req.summary} — ${req.reason}`);
      log.warn(`approve with: agent-phone approve ${req.id}    deny with: agent-phone deny ${req.id}`);
    }
    if (this.notifications) void this.notify(req);
    return req;
  }

  get(id: string): ApprovalRequest | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    try {
      const r = JSON.parse(readFileSync(f, "utf8")) as ApprovalRequest;
      if (r.status === "pending" && Date.now() > r.expiresAt) {
        r.status = "expired";
        writeFileSync(f, JSON.stringify(r, null, 2), { mode: 0o600 });
      }
      return r;
    } catch {
      return undefined;
    }
  }

  list(opts: { pendingOnly?: boolean } = {}): ApprovalRequest[] {
    if (!existsSync(this.dir)) return [];
    const out: ApprovalRequest[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const r = this.get(f.replace(/\.json$/, ""));
      if (!r) continue;
      if (opts.pendingOnly && r.status !== "pending") continue;
      out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Operator-only. Never exposed as an agent-callable tool. */
  decide(id: string, approved: boolean, by = "operator", note?: string): ApprovalRequest | undefined {
    const r = this.get(id);
    if (!r) return undefined;
    if (r.status !== "pending") return r;
    r.status = approved ? "approved" : "denied";
    r.decidedAt = Date.now();
    r.decidedBy = by;
    r.note = note;
    writeFileSync(this.file(id), JSON.stringify(r, null, 2), { mode: 0o600 });
    return r;
  }

  /** Delete decided or expired requests older than `maxAgeMs`. Pending ones are never touched. */
  prune(maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const r of this.list()) {
      if (r.status === "pending") continue;
      if (now - (r.decidedAt ?? r.expiresAt) > maxAgeMs) {
        rmSync(this.file(r.id), { force: true });
        n++;
      }
    }
    return n;
  }

  /**
   * Expire everything a session left pending. Once the session is gone nobody
   * will retry with the id, so a card asking the operator to decide is noise.
   */
  expireForSession(sessionId: string): number {
    let n = 0;
    for (const r of this.list({ pendingOnly: true })) {
      if (r.sessionId !== sessionId) continue;
      r.status = "expired";
      r.decidedAt = Date.now();
      r.note = "session ended";
      writeFileSync(this.file(r.id), JSON.stringify(r, null, 2), { mode: 0o600 });
      n++;
    }
    return n;
  }

  async waitFor(id: string, timeoutMs?: number): Promise<ApprovalRequest> {
    const start = Date.now();
    for (;;) {
      const r = this.get(id);
      if (!r) throw new Error(`approval ${id} vanished`);
      if (r.status !== "pending") return r;
      const deadline = timeoutMs ? start + timeoutMs : r.expiresAt;
      if (Date.now() > deadline) {
        return { ...r, status: "expired" };
      }
      await sleep(500);
    }
  }

  private async notify(req: ApprovalRequest): Promise<void> {
    const handoff = req.type === "handoff";
    await notifyOperator({
      kind: handoff ? "handoff" : "approval",
      id: req.id,
      sessionId: req.sessionId,
      title: handoff ? "Your agent needs a hand" : "Approval needed",
      body: handoff ? req.reason : `${req.summary} — ${req.reason}`,
      path: `/panel/#/approvals/${req.id}`,
      expiresAt: req.expiresAt,
    });
  }
}

export const approvals = new ApprovalStore();
