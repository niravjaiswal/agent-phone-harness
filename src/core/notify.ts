import { loadConfig, type NotifyConfig, type OperatorConfig } from "./config.js";
import { logger } from "./logger.js";
import { readRuntime } from "./runtime.js";

const log = logger("notify");

/**
 * Tell the operator something needs them.
 *
 * Messages carry a link to the panel and a one-line summary — never the
 * evidence screenshot and never a credential. Push services are third parties,
 * and an ntfy topic is only as private as its name.
 */
export interface NotifyEvent {
  kind: "approval" | "handoff" | "test";
  id?: string;
  title: string;
  body: string;
  /** Relative panel path, e.g. "/panel/#/approvals/3f9c21aa". */
  path?: string;
  sessionId?: string;
  expiresAt?: number;
}

export interface ChannelResult {
  channel: string;
  ok: boolean;
  error?: string;
}

export function panelBase(cfg: OperatorConfig = loadConfig()): string | undefined {
  return cfg.publicUrl ?? readRuntime()?.publicUrl ?? readRuntime()?.localUrl;
}

export function configuredChannels(n: NotifyConfig): string[] {
  const out: string[] = [];
  if (n.ntfyUrl) out.push("ntfy");
  if (n.telegramBotToken && n.telegramChatId) out.push("telegram");
  if (n.slackWebhook) out.push("slack");
  if (n.webhook) out.push("webhook");
  return out;
}

async function post(url: string, body: string, headers: Record<string, string>): Promise<void> {
  const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

export async function notifyOperator(ev: NotifyEvent, cfg: OperatorConfig = loadConfig()): Promise<ChannelResult[]> {
  const n = cfg.notify;
  const base = panelBase(cfg);
  const link = base && ev.path ? `${base}${ev.path}` : undefined;
  const text = `${ev.title}\n${ev.body}${link ? `\n${link}` : ""}`;
  const jobs: [string, () => Promise<void>][] = [];

  if (n.ntfyUrl) {
    jobs.push([
      "ntfy",
      () =>
        post(n.ntfyUrl!, `${ev.body}`, {
          // ntfy headers must be latin1; keep titles plain.
          Title: ev.title.replace(/[^\x20-\x7e]/g, ""),
          Priority: ev.kind === "test" ? "default" : "high",
          Tags: ev.kind === "handoff" ? "raising_hand" : ev.kind === "approval" ? "warning" : "white_check_mark",
          ...(link ? { Click: link, Actions: `view, Open panel, ${link}` } : {}),
          ...(n.ntfyToken ? { Authorization: `Bearer ${n.ntfyToken}` } : {}),
        }),
    ]);
  }
  if (n.telegramBotToken && n.telegramChatId) {
    jobs.push([
      "telegram",
      () =>
        post(
          `https://api.telegram.org/bot${n.telegramBotToken}/sendMessage`,
          JSON.stringify({
            chat_id: n.telegramChatId,
            text,
            disable_web_page_preview: true,
            // Telegram refuses buttons pointing at non-public URLs.
            ...(link?.startsWith("https://")
              ? { reply_markup: { inline_keyboard: [[{ text: "Open panel", url: link }]] } }
              : {}),
          }),
          { "content-type": "application/json" },
        ),
    ]);
  }
  if (n.slackWebhook) {
    jobs.push(["slack", () => post(n.slackWebhook!, JSON.stringify({ text }), { "content-type": "application/json" })]);
  }
  if (n.webhook) {
    jobs.push([
      "webhook",
      () =>
        post(
          n.webhook!,
          JSON.stringify({
            type: ev.kind === "approval" ? "approval_required" : ev.kind === "handoff" ? "handoff_requested" : "test",
            id: ev.id,
            sessionId: ev.sessionId,
            title: ev.title,
            summary: ev.body,
            expiresAt: ev.expiresAt,
            link,
          }),
          { "content-type": "application/json" },
        ),
    ]);
  }

  const results = await Promise.all(
    jobs.map(async ([channel, run]): Promise<ChannelResult> => {
      try {
        await run();
        return { channel, ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log.warn(`${channel} notification failed`, error);
        return { channel, ok: false, error };
      }
    }),
  );
  return results;
}
