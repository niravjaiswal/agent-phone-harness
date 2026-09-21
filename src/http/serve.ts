#!/usr/bin/env node
import { serve } from "./server.js";
import { logger } from "../core/logger.js";

const log = logger("serve");

serve({
  allowMockFallback: process.env.PHONE_ALLOW_MOCK === "1",
  ...(process.env.PHONE_WDA_URL ? { ios: { wdaUrl: process.env.PHONE_WDA_URL } } : {}),
}).catch((e) => {
  log.error("fatal", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
