#!/usr/bin/env node
/**
 * Container entrypoint: everything from the environment.
 * See docs/hosting.md for the variables.
 */
import { serve } from "./server.js";
import { logger } from "../core/logger.js";

const log = logger("serve");

serve({
  allowMockFallback: process.env.PHONE_ALLOW_MOCK === "1",
  ...(process.env.PHONE_WDA_URL ? { ios: { wdaUrl: process.env.PHONE_WDA_URL } } : {}),
  android: { useAdbKeyboard: process.env.PHONE_ADB_KEYBOARD === "1" },
  ...(process.env.PHONE_NO_AUTH === "1" ? { auth: false } : {}),
})
  .then((s) => {
    const shutdown = async () => {
      await s.close().catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((e) => {
    log.error("fatal", e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
