import { createHash } from "node:crypto";
import type { Rect, ScreenContext, Selector, Snapshot, UiElement } from "./types.js";

/** What a provider produces before the harness assigns refs/indices. */
export type RawElement = Omit<UiElement, "ref" | "center" | "roleIndex">;

const MAX_TEXT = 120;

export function rectCenter(b: Rect): [number, number] {
  return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
}

export function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

/**
 * Assign refs, centers and per-role indices.
 *
 * roleIndex is what makes `{role:"TextField", index:1}` a stable selector on
 * screens where nothing has usable text (common in RN/Flutter apps).
 */
export function finalizeElements(raw: RawElement[]): UiElement[] {
  const perRole = new Map<string, number>();
  return raw.map((e, i) => {
    const n = perRole.get(e.role) ?? 0;
    perRole.set(e.role, n + 1);
    return {
      ...e,
      text: clip(e.text),
      label: clip(e.label),
      value: clip(e.value),
      ref: `e${i + 1}`,
      roleIndex: n,
      center: rectCenter(e.bounds),
    };
  });
}

/** Zero-area or off-screen elements can never be interacted with. */
export function isVisible(e: { bounds: Rect }, screen?: { width: number; height: number }): boolean {
  const b = e.bounds;
  if (b.width <= 0 || b.height <= 0) return false;
  if (!screen) return true;
  if (b.x >= screen.width || b.y >= screen.height) return false;
  if (b.x + b.width <= 0 || b.y + b.height <= 0) return false;
  return true;
}

/**
 * True if the element carries information an agent can act on or reason about.
 *
 * An unfiltered Android dump is 40-80k chars of layout scaffolding; keeping only
 * informative nodes lands at 1-3k without losing targets.
 */
export function isInformative(e: RawElement | UiElement): boolean {
  if (e.clickable || e.scrollable) return true;
  if (e.text || e.label || e.value) return true;
  if (e.checked !== undefined || e.selected || e.focused) return true;
  if (/TextField|SecureTextField|EditText|Switch|Checkbox|Slider|SeekBar|Picker/i.test(e.role)) return true;
  return false;
}

export interface PruneResult {
  kept: UiElement[];
  prunedCount: number;
}

export function pruneElements(
  elements: UiElement[],
  screen?: { width: number; height: number },
): PruneResult {
  const kept: UiElement[] = [];
  for (const e of elements) {
    if (!isVisible(e, screen)) continue;
    if (!isInformative(e)) continue;
    kept.push(e);
  }
  // Drop a clickable container when a clickable descendant covers ~the same box
  // and carries the label — otherwise every row appears twice.
  const filtered = kept.filter((e, i) => {
    if (!e.clickable || e.text || e.label) return true;
    const inner = kept.find(
      (o, j) => j !== i && o.clickable && (o.text || o.label) && containsRect(e.bounds, o.bounds) && area(o.bounds) > area(e.bounds) * 0.6,
    );
    return !inner;
  });
  return { kept: filtered, prunedCount: elements.length - filtered.length };
}

const area = (b: Rect) => b.width * b.height;
const containsRect = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

export interface RenderOptions {
  /** Include `@x,y` tap centers for clickable elements. Default true. */
  coords?: boolean;
  /** Character budget for the rendered tree. Default 6000. */
  maxChars?: number;
  /** Include full bounds rather than centers. Default false. */
  bounds?: boolean;
}

/**
 * Render elements as an indented tree for the model.
 *
 * Depths are compressed: only kept elements contribute levels, so a 14-deep
 * ViewGroup chain renders as one indent step.
 */
export function renderElements(
  elements: UiElement[],
  screen: ScreenContext,
  opts: RenderOptions = {},
): { text: string; truncated: boolean } {
  const coords = opts.coords !== false;
  const maxChars = opts.maxChars ?? 6000;

  const depths = [...new Set(elements.map((e) => e.depth))].sort((a, b) => a - b);
  const depthRank = new Map(depths.map((d, i) => [d, i]));

  const head =
    `Screen: ${screen.app ?? "unknown"}${screen.activity ? ` / ${screen.activity}` : ""} ` +
    `(${screen.width}x${screen.height} ${screen.orientation ?? "portrait"})`;

  const lines: string[] = [head];
  let truncated = false;
  let used = head.length;

  for (const e of elements) {
    const indent = "  ".repeat(Math.min(depthRank.get(e.depth) ?? 0, 8));
    const parts: string[] = [`${e.ref} ${e.role}`];
    if (e.text) parts.push(JSON.stringify(e.text));
    if (e.label && e.label !== e.text) parts.push(`label=${JSON.stringify(e.label)}`);
    if (e.value && e.value !== e.text) parts.push(`value=${JSON.stringify(e.password ? "***" : e.value)}`);
    if (e.id) parts.push(`id=${shortId(e.id)}`);

    const flags: string[] = [];
    if (!e.enabled) flags.push("disabled");
    if (e.focused) flags.push("focused");
    if (e.checked === true) flags.push("checked");
    if (e.checked === false) flags.push("unchecked");
    if (e.selected) flags.push("selected");
    if (e.password) flags.push("password");
    if (e.scrollable) flags.push("scrollable");
    if (e.clickable && !/Button|Cell|Tab|Link/i.test(e.role)) flags.push("clickable");
    if (flags.length) parts.push(`[${flags.join(" ")}]`);

    if (opts.bounds) parts.push(`@${e.bounds.x},${e.bounds.y},${e.bounds.width},${e.bounds.height}`);
    else if (coords && (e.clickable || e.scrollable)) parts.push(`@${e.center[0]},${e.center[1]}`);

    const line = `${indent}${parts.join(" ")}`;
    if (used + line.length + 1 > maxChars) {
      truncated = true;
      lines.push(`… ${elements.length - (lines.length - 1)} more elements omitted (raise maxChars or scroll)`);
      break;
    }
    used += line.length + 1;
    lines.push(line);
  }

  return { text: lines.join("\n"), truncated };
}

/** com.example.app:id/login_button -> login_button */
function shortId(id: string): string {
  const i = id.lastIndexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function matchesSelector(e: UiElement, s: Selector): boolean {
  if (s.text !== undefined && norm(e.text) !== norm(s.text)) return false;
  if (s.textContains !== undefined && !norm(e.text).includes(norm(s.textContains))) return false;
  if (s.label !== undefined && norm(e.label) !== norm(s.label)) return false;
  if (s.labelContains !== undefined && !norm(e.label).includes(norm(s.labelContains))) return false;
  if (s.id !== undefined && !(norm(e.id) === norm(s.id) || shortId(e.id ?? "").toLowerCase() === norm(s.id))) return false;
  if (s.idContains !== undefined && !norm(e.id).includes(norm(s.idContains))) return false;
  if (s.role !== undefined && norm(e.role) !== norm(s.role)) return false;
  if (s.value !== undefined && norm(e.value) !== norm(s.value)) return false;
  if (s.clickable !== undefined && e.clickable !== s.clickable) return false;
  if (s.enabled !== undefined && e.enabled !== s.enabled) return false;
  return true;
}

export interface ResolveResult {
  /** Single unambiguous match, if any. */
  element?: UiElement;
  /** All matches, in document order. */
  matches: UiElement[];
  /** Why resolution failed, if it did. */
  reason?: "no_match" | "ambiguous";
}

/**
 * Resolve a selector against a snapshot.
 *
 * Ambiguity is an error rather than "take the first" — mis-tapping a duplicate
 * label is the failure mode that sends money to the wrong person.
 */
export function resolveSelector(elements: UiElement[], s: Selector): ResolveResult {
  const matches = elements.filter((e) => matchesSelector(e, s));
  if (matches.length === 0) return { matches, reason: "no_match" };

  if (s.index !== undefined) {
    const i = s.index < 0 ? matches.length + s.index : s.index;
    const el = matches[i];
    return el ? { element: el, matches } : { matches, reason: "no_match" };
  }

  if (matches.length === 1) return { element: matches[0]!, matches };

  // Prefer a unique clickable candidate before giving up.
  const clickable = matches.filter((m) => m.clickable);
  if (clickable.length === 1) return { element: clickable[0]!, matches };

  return { matches, reason: "ambiguous" };
}

/** Significant-state hash — used for settle detection and change diffs. */
export function hashElements(elements: UiElement[], screen: ScreenContext): string {
  const h = createHash("sha1");
  h.update(`${screen.app ?? ""}|${screen.activity ?? ""}|${screen.width}x${screen.height}`);
  for (const e of elements) {
    h.update(
      `\n${e.role}|${e.text ?? ""}|${e.label ?? ""}|${e.value ?? ""}|${e.id ?? ""}|` +
        `${e.bounds.x},${e.bounds.y},${e.bounds.width},${e.bounds.height}|` +
        `${e.enabled ? 1 : 0}${e.checked === true ? 1 : 0}${e.selected ? 1 : 0}`,
    );
  }
  return h.digest("hex").slice(0, 16);
}

const key = (e: UiElement) => `${e.role}|${e.text ?? ""}|${e.label ?? ""}|${e.id ?? ""}`;

export interface SnapshotDiff {
  changed: boolean;
  appChanged: boolean;
  added: UiElement[];
  removed: UiElement[];
  summary: string;
}

export function diffSnapshots(before: Snapshot | undefined, after: Snapshot): SnapshotDiff {
  if (!before) {
    return { changed: true, appChanged: true, added: after.elements, removed: [], summary: "initial screen" };
  }
  if (before.hash === after.hash) {
    return { changed: false, appChanged: false, added: [], removed: [], summary: "no change" };
  }
  const beforeKeys = new Map<string, number>();
  for (const e of before.elements) beforeKeys.set(key(e), (beforeKeys.get(key(e)) ?? 0) + 1);
  const afterKeys = new Map<string, number>();
  for (const e of after.elements) afterKeys.set(key(e), (afterKeys.get(key(e)) ?? 0) + 1);

  const added = after.elements.filter((e) => (beforeKeys.get(key(e)) ?? 0) === 0);
  const removed = before.elements.filter((e) => (afterKeys.get(key(e)) ?? 0) === 0);

  const appChanged =
    before.screen.app !== after.screen.app || before.screen.activity !== after.screen.activity;

  const bits: string[] = [];
  if (appChanged) {
    bits.push(
      `screen: ${before.screen.app ?? "?"}${before.screen.activity ? `/${before.screen.activity}` : ""}` +
        ` → ${after.screen.app ?? "?"}${after.screen.activity ? `/${after.screen.activity}` : ""}`,
    );
  }
  if (added.length) bits.push(`+${added.length} elements`);
  if (removed.length) bits.push(`-${removed.length} elements`);
  if (!bits.length) bits.push("content updated");

  return { changed: true, appChanged, added, removed, summary: bits.join(", ") };
}
