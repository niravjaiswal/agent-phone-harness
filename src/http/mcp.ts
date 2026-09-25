import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Harness } from "../core/harness.js";
import { logger } from "../core/logger.js";
import { createPhoneMcpServer } from "../mcp/server.js";
import { json } from "./util.js";

const log = logger("mcp-http");

interface Client {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/**
 * One MCP transport (and one tool registry) per connected agent, all sharing a
 * single Harness.
 *
 * A single transport accepts exactly one `initialize` for its whole life, so
 * the first agent to reconnect after a restart would have been locked out.
 * Each connection also owns its phone sessions: when it goes away, they close
 * and the phone is free for the next agent.
 */
export class McpHub {
  private clients = new Map<string, Client>();
  private reaper?: NodeJS.Timeout;

  constructor(
    private harness: Harness,
    /** Drop connections silent for this long. Clients that vanish never send DELETE. */
    private idleMs = 60 * 60_000,
  ) {
    this.reaper = setInterval(() => void this.reap(), 60_000);
    this.reaper.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string" && sid) {
      const c = this.clients.get(sid);
      if (!c) {
        // Per spec, 404 tells the client to start a new session.
        json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found; re-initialize" }, id: null });
        return;
      }
      c.lastSeen = Date.now();
      await c.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      const id = randomUUID();
      const owner = `mcp:${id}`;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
      transport.onclose = () => {
        if (!this.clients.delete(id)) return;
        void this.harness.closeOwned(owner).then((n) => {
          if (n) log.info(`MCP client ${id.slice(0, 8)} left; closed ${n} phone session(s)`);
        });
      };
      const { server } = createPhoneMcpServer({ harness: this.harness, owner });
      await server.connect(transport);
      this.clients.set(id, { transport, lastSeen: Date.now() });
      log.info(`MCP client ${id.slice(0, 8)} connected (${this.clients.size} total)`);
      await transport.handleRequest(req, res, body);
      return;
    }

    json(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "No MCP session: send an initialize request first" },
      id: null,
    });
  }

  async reap(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [id, c] of this.clients) {
      if (now - c.lastSeen > this.idleMs) {
        await c.transport.close().catch(() => {});
        this.clients.delete(id);
        await this.harness.closeOwned(`mcp:${id}`);
        n++;
      }
    }
    return n;
  }

  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.clients.values()].map((c) => c.transport.close().catch(() => {})));
    this.clients.clear();
  }
}
