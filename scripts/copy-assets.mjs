// tsc only emits .js from .ts; the panel's static files ride along here.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/panel", { recursive: true });
for (const f of ["index.html", "app.js", "app.css"]) cpSync(`src/panel/${f}`, `dist/panel/${f}`);
