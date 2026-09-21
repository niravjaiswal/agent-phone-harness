import { PNG } from "pngjs";
import type { Rect, UiElement } from "./types.js";

/**
 * Pure-JS image ops (pngjs) — deliberately no native dependency, so the harness
 * installs cleanly on a Mac mini, a Linux runner or inside a container without
 * a build toolchain.
 */

export type RGBA = [number, number, number, number];

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png, { deflateLevel: 6 });
}

function setPixel(png: PNG, x: number, y: number, c: RGBA) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  const a = c[3] / 255;
  png.data[i] = Math.round(png.data[i]! * (1 - a) + c[0] * a);
  png.data[i + 1] = Math.round(png.data[i + 1]! * (1 - a) + c[1] * a);
  png.data[i + 2] = Math.round(png.data[i + 2]! * (1 - a) + c[2] * a);
  png.data[i + 3] = 255;
}

export function fillRect(png: PNG, r: Rect, c: RGBA) {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(png.width, Math.round(r.x + r.width));
  const y1 = Math.min(png.height, Math.round(r.y + r.height));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPixel(png, x, y, c);
}

export function strokeRect(png: PNG, r: Rect, c: RGBA, thickness = 2) {
  for (let t = 0; t < thickness; t++) {
    const rr: Rect = { x: r.x + t, y: r.y + t, width: r.width - 2 * t, height: r.height - 2 * t };
    if (rr.width <= 0 || rr.height <= 0) return;
    fillRect(png, { ...rr, height: 1 }, c);
    fillRect(png, { ...rr, y: rr.y + rr.height - 1, height: 1 }, c);
    fillRect(png, { ...rr, width: 1 }, c);
    fillRect(png, { ...rr, x: rr.x + rr.width - 1, width: 1 }, c);
  }
}

/** 3x5 bitmap digits — enough to label set-of-marks without shipping a font. */
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

export function drawLabel(png: PNG, x: number, y: number, text: string, px: number, fg: RGBA, bg: RGBA) {
  const glyphs = [...text].filter((ch) => DIGITS[ch]);
  const w = glyphs.length * (3 * px + px) + px;
  const h = 5 * px + 2 * px;
  fillRect(png, { x, y, width: w, height: h }, bg);
  let cx = x + px;
  for (const ch of glyphs) {
    const rows = DIGITS[ch]!;
    for (let r = 0; r < 5; r++) {
      const row = rows[r]!;
      for (let c = 0; c < 3; c++) {
        if (row[c] === "1") fillRect(png, { x: cx + c * px, y: y + px + r * px, width: px, height: px }, fg);
      }
    }
    cx += 4 * px;
  }
}

/** Box-average downscale. Keeps text legible far better than nearest-neighbour. */
export function scalePng(png: PNG, maxSize: number): { png: PNG; scale: number } {
  const longest = Math.max(png.width, png.height);
  if (longest <= maxSize) return { png, scale: 1 };
  const scale = maxSize / longest;
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  const out = new PNG({ width: w, height: h });
  const bx = png.width / w;
  const by = png.height / h;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * by);
    const sy1 = Math.min(png.height, Math.max(sy0 + 1, Math.floor((y + 1) * by)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * bx);
      const sx1 = Math.min(png.width, Math.max(sx0 + 1, Math.floor((x + 1) * bx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (png.width * sy + sx) << 2;
          r += png.data[i]!; g += png.data[i + 1]!; b += png.data[i + 2]!; a += png.data[i + 3]!;
          n++;
        }
      }
      const o = (w * y + x) << 2;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return { png: out, scale };
}

export interface AnnotateOptions {
  /** Device logical coordinate space the element bounds are expressed in. */
  deviceSize?: { width: number; height: number };
  /** Elements to black out (password fields). */
  redact?: UiElement[];
  /** Elements to number (set-of-marks). Label is the numeric part of the ref. */
  marks?: UiElement[];
  maxSize?: number;
}

const MARK_COLOR: RGBA = [255, 45, 85, 255];
const MARK_BG: RGBA = [255, 45, 85, 235];
const WHITE: RGBA = [255, 255, 255, 255];
const BLACK: RGBA = [0, 0, 0, 255];

/**
 * Redact first (at full resolution, so nothing leaks through downscaling),
 * then scale, then draw marks (so the boxes stay crisp and the labels legible).
 */
export function annotateScreenshot(
  input: Buffer,
  opts: AnnotateOptions = {},
): { data: Buffer; width: number; height: number; scale: number } {
  let png = decodePng(input);
  const dev = opts.deviceSize ?? { width: png.width, height: png.height };
  const toPx = (b: Rect): Rect => ({
    x: (b.x / dev.width) * png.width,
    y: (b.y / dev.height) * png.height,
    width: (b.width / dev.width) * png.width,
    height: (b.height / dev.height) * png.height,
  });

  for (const e of opts.redact ?? []) fillRect(png, toPx(e.bounds), BLACK);

  const { png: scaled, scale } = scalePng(png, opts.maxSize ?? 1000);
  png = scaled;

  if (opts.marks?.length) {
    const sx = png.width / dev.width;
    const sy = png.height / dev.height;
    const px = Math.max(2, Math.round(png.width / 320));
    for (const e of opts.marks) {
      const r: Rect = {
        x: e.bounds.x * sx,
        y: e.bounds.y * sy,
        width: e.bounds.width * sx,
        height: e.bounds.height * sy,
      };
      if (r.width < 4 || r.height < 4) continue;
      strokeRect(png, r, MARK_COLOR, Math.max(1, Math.round(px / 2)));
      const n = e.ref.replace(/\D/g, "");
      const lw = n.length * 4 * px + px;
      const lx = Math.min(Math.max(0, r.x), png.width - lw);
      const ly = Math.max(0, r.y - (7 * px));
      drawLabel(png, Math.round(lx), Math.round(ly), n, px, WHITE, MARK_BG);
    }
  }

  return { data: encodePng(png), width: png.width, height: png.height, scale };
}
