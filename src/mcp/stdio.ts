#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPhoneMcpServer } from "./server.js";
import { logger } from "../core/logger.js";

const log = logger("mcp");

async function main() {
  const { server, harness } = createPhoneMcpServer({
    allowMockFallback: process.env.PHONE_ALLOW_MOCK === "1",
    ...(process.env.PHONE_WDA_URL ? { ios: { wdaUrl: process.env.PHONE_WDA_URL } } : {}),
    android: { useAdbKeyboard: process.env.PHONE_ADB_KEYBOARD === "1" },
  });

  const shutdown = async () => {
    await harness.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log.info("phone MCP server ready on stdio");
}

main().catch((e) => {
  log.error("fatal", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
