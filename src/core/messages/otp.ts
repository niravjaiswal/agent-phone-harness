/**
 * Pull a one-time code out of a message.
 *
 * A bare "first run of six digits" regex takes the order number, the amount,
 * or the year. Candidates are scored by proximity to the words services put
 * next to codes, and the best one wins.
 */

const KEYWORDS =
  /\b(code|otp|passcode|pass code|pin|verification|verify|one[- ]?time|security|log ?in|sign[- ]?in|2fa|two[- ]factor|confirm(ation)?|authenticat\w*)\b/gi;

export interface OtpCandidate {
  code: string;
  index: number;
  score: number;
}

export function otpCandidates(text: string, opts: { digits?: number } = {}): OtpCandidate[] {
  const found = new Map<string, OtpCandidate>();
  const add = (code: string, index: number) => {
    if (opts.digits ? code.length !== opts.digits : code.length < 4 || code.length > 8) return;
    if (!found.has(`${index}:${code}`)) found.set(`${index}:${code}`, { code, index, score: 0 });
  };

  // "123456" or "G-123456", but not a piece of a longer number, a price, a
  // decimal, a date or a phone number ("555-1234", "555 123 4567").
  for (const m of text.matchAll(/(?<![\d$€£¥+.,/])(?<!\d[- ])(\d{4,8})(?!\d|[.,]\d|\/\d|[- ]\d)/g)) {
    add(m[1]!, m.index!);
  }
  // "123-456" / "123 456" — some services split codes for readability.
  for (const m of text.matchAll(/(?<![\d$€£¥+.,])(?<!\d[- ])(\d{3,4})[- ](\d{3,4})(?!\d|[.,]\d|[- ]\d)/g)) {
    add(m[1]! + m[2]!, m.index!);
  }

  const keywordAt = [...text.matchAll(KEYWORDS)].map((k) => k.index!);
  for (const c of found.values()) {
    const near = keywordAt.some((k) => Math.abs(k - c.index) <= 40);
    if (near) c.score += 3;
    if (c.code.length === 6) c.score += 1;
    if (c.code.length === 4 && /^(19|20)\d\d$/.test(c.code)) c.score -= 3; // a year
    const before = text.slice(Math.max(0, c.index - 12), c.index).toLowerCase();
    if (/(order|ref|invoice|#|no\.|number)\s*:?\s*$/.test(before)) c.score -= 3;
  }
  return [...found.values()].sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * The best code in `text`, or undefined. With `digits` the length is trusted
 * and the best-placed candidate wins; without it a candidate needs some
 * evidence (a nearby keyword or the canonical six digits).
 */
export function findOtp(text: string, opts: { digits?: number } = {}): string | undefined {
  const best = otpCandidates(text, opts)[0];
  if (!best) return undefined;
  if (!opts.digits && best.score < 1) return undefined;
  return best.code;
}
