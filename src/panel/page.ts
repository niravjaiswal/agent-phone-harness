import { readFileSync } from "node:fs";

/**
 * The operator panel: one HTML page, one script, one stylesheet, no build step.
 *
 * Read from disk next to this module (src/ under tsx, dist/ after build — the
 * build copies them), cached after first read.
 */
const FILES: Record<string, { file: string; type: string }> = {
  "/panel/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/panel/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/panel/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const cache = new Map<string, string>();

export function panelAsset(path: string): { body: string; type: string } | undefined {
  const f = FILES[path];
  if (!f) return undefined;
  let body = cache.get(f.file);
  if (body === undefined) {
    body = readFileSync(new URL(`./${f.file}`, import.meta.url), "utf8");
    if (!process.env.PHONE_PANEL_DEV) cache.set(f.file, body);
  }
  return { body, type: f.type };
}
