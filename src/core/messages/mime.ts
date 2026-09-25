/**
 * Just enough RFC 5322 / MIME to read a verification email: headers, encoded
 * words, multipart, base64 and quoted-printable. Not a general mail parser.
 */

export interface ParsedEmail {
  from: string;
  subject: string;
  date?: number;
  messageId?: string;
  text: string;
}

function splitHeadBody(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return [raw, ""];
  return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)];
}

function parseHeaders(head: string): Map<string, string> {
  const out = new Map<string, string>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!out.has(k)) out.set(k, line.slice(i + 1).trim());
  }
  return out;
}

function decodeCharset(bytes: Buffer, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^"|"$/g, "")).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function decodeQuotedPrintable(s: string, header = false): Buffer {
  const src = header ? s.replace(/_/g, " ") : s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Input is a latin1 view of raw bytes, so each char is exactly one byte.
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** =?UTF-8?B?...?= and =?UTF-8?Q?...?= */
export function decodeWords(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : decodeQuotedPrintable(data, true);
      return decodeCharset(bytes, cs);
    });
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header);
  return m?.[1] ?? m?.[2];
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

interface Part {
  type: string;
  text: string;
}

function decodeBody(body: string, headers: Map<string, string>): string {
  const enc = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const charset = param(headers.get("content-type"), "charset") ?? "utf-8";
  let bytes: Buffer;
  if (enc === "base64") bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") bytes = decodeQuotedPrintable(body);
  else bytes = Buffer.from(body, "latin1");
  return decodeCharset(bytes, charset);
}

function collectParts(raw: string, depth = 0): Part[] {
  const [head, body] = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const ctype = headers.get("content-type") ?? "text/plain";
  const type = ctype.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("multipart/") && depth < 5) {
    const boundary = param(ctype, "boundary");
    if (!boundary) return [];
    const out: Part[] = [];
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      out.push(...collectParts(chunk.replace(/^\r?\n/, ""), depth + 1));
    }
    return out;
  }
  if (!type.startsWith("text/")) return [];
  return [{ type, text: decodeBody(body, headers) }];
}

/** Parse a raw message. `raw` is read as latin1 so byte values survive until charset decoding. */
export function parseEmail(raw: Buffer | string): ParsedEmail {
  const s = typeof raw === "string" ? raw : raw.toString("latin1");
  const [head] = splitHeadBody(s);
  const headers = parseHeaders(head);
  const parts = collectParts(s);
  const plain = parts.find((p) => p.type === "text/plain");
  const html = parts.find((p) => p.type === "text/html");
  const text = plain ? plain.text.trim() : html ? htmlToText(html.text) : "";
  const date = Date.parse(headers.get("date") ?? "");
  return {
    from: decodeWords(headers.get("from") ?? ""),
    subject: decodeWords(headers.get("subject") ?? ""),
    ...(Number.isFinite(date) ? { date } : {}),
    ...(headers.get("message-id") ? { messageId: headers.get("message-id")! } : {}),
    text,
  };
}
