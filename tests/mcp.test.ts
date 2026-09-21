import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPhoneMcpServer } from "../src/mcp/server.js";
import type { Harness } from "../src/core/harness.js";

/** Everything an agent actually touches, exercised over a real MCP transport. */
describe("MCP tool surface", () => {
  let client: Client;
  let harness: Harness;
  let sessionId: string;

  const textOf = (r: unknown): string =>
    ((r as { content: { type: string; text?: string }[] }).content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  beforeAll(async () => {
    process.env.PHONE_SECRET_MCP_PASSWORD = "mcp-secret-value";
    const built = createPhoneMcpServer({ allowMockFallback: true });
    harness = built.harness;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await harness.closeAll();
    await client.close();
  });

  it("advertises the phone tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "phone_list_devices", "phone_session_start", "phone_observe", "phone_tap",
      "phone_type", "phone_type_secret", "phone_wait_for_otp", "phone_open_url",
      "phone_screenshot", "phone_session_end",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("exposes no tool that can approve a gated action", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/approve|deny|decide/i);
  });

  it("lists devices including the mock phone", async () => {
    expect(textOf(await call("phone_list_devices"))).toContain("mock:demo");
  });

  it("starts a session and returns the first screen", async () => {
    const out = textOf(
      await call("phone_session_start", {
        deviceId: "mock:demo",
        allowedApps: ["com.example.demobank", "com.mock.launcher"],
        approvalWaitMs: 1500,
      }),
    );
    expect(out).toContain("Demo Bank");
    sessionId = /session (\w+) on/.exec(out)![1]!;
    expect(sessionId).toBeTruthy();
  });

  it("observes with refs and prune accounting", async () => {
    const out = textOf(await call("phone_observe", { sessionId }));
    expect(out).toMatch(/e\d+ Button "Demo Bank"/);
    expect(out).toContain("elements shown");
  });

  it("taps by selector and returns the resulting screen in one round trip", async () => {
    const out = textOf(await call("phone_tap", { sessionId, selector: { text: "Demo Bank" } }));
    expect(out).toContain("✓ tap");
    expect(out).toContain("LoginActivity");
    expect(out).toContain("Sign in");
  });

  it("types into a field found by label", async () => {
    const out = textOf(await call("phone_type", { sessionId, selector: { label: "Username" }, text: "ada@example.com" }));
    expect(out).toContain("ada@example.com");
  });

  it("types a secret without ever revealing it", async () => {
    const out = textOf(await call("phone_type_secret", { sessionId, selector: { label: "Password" }, key: "mcp_password" }));
    expect(out).not.toContain("mcp-secret-value");
    expect(out).toContain("«secret:mcp_password»");
  });

  it("lists secret names but not values", async () => {
    const out = textOf(await call("phone_list_secrets"));
    expect(out).toContain("mcp_password");
    expect(out).not.toContain("mcp-secret-value");
  });

  it("returns a real PNG from phone_screenshot", async () => {
    const r = (await call("phone_screenshot", { sessionId, marks: true })) as {
      content: { type: string; data?: string; mimeType?: string }[];
    };
    const image = r.content.find((c) => c.type === "image")!;
    expect(image.mimeType).toBe("image/png");
    const bytes = Buffer.from(image.data!, "base64");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("collects an SMS one-time code end to end", async () => {
    await call("phone_tap", { sessionId, selector: { text: "Sign in" } });
    const out = textOf(await call("phone_wait_for_otp", { sessionId, digits: 6, timeoutMs: 8000 }));
    expect(out).toMatch(/code: \d{6}/);
  });

  it("returns a structured, hint-carrying error instead of throwing", async () => {
    const r = (await call("phone_tap", { sessionId, selector: { text: "Does not exist" } })) as {
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    const body = JSON.parse(textOf(r)) as { code: string; hint: string; details: unknown };
    expect(body.code).toBe("no_match");
    expect(body.hint).toContain("phone_observe");
    expect(JSON.stringify(body.details)).toContain("Verification code");
  });

  it("surfaces a pending approval as a retryable error with an id", async () => {
    // Finish the login so the money screen is reachable.
    const otp = textOf(await call("phone_wait_for_otp", { sessionId, digits: 6, timeoutMs: 8000 })).replace("code: ", "").trim();
    await call("phone_type", { sessionId, selector: { label: "Verification code" }, text: otp });
    await call("phone_tap", { sessionId, selector: { text: "Verify" } });

    const r = (await call("phone_tap", { sessionId, selector: { text: "Send money" } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(textOf(r)) as { code: string; details: { approvalId: string } };
    expect(body.code).toBe("awaiting_approval");
    expect(body.details.approvalId).toMatch(/^[0-9a-f]{8}$/);
  }, 60_000);

  it("advertises batching and deep links", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("phone_batch");
    expect(names).toContain("phone_list_deep_links");
  });

  it("runs a multi-step batch in one call and ends on a full screen", async () => {
    const fresh = textOf(
      await call("phone_session_start", {
        deviceId: "mock:demo",
        allowedApps: ["com.example.demobank", "com.mock.launcher"],
        approvalWaitMs: 1500,
      }),
    );
    const id = /session (\w+) on/.exec(fresh)![1]!;

    const out = textOf(
      await call("phone_batch", {
        sessionId: id,
        steps: [
          { action: "open_app", appId: "com.example.demobank" },
          { action: "type", selector: { label: "Username" }, text: "ada@example.com" },
          { action: "type_secret", selector: { label: "Password" }, key: "mcp_password" },
          { action: "tap", selector: { text: "Sign in" } },
        ],
      }),
    );

    expect(out).toContain("batch complete: 4/4 steps");
    expect(out).toContain("Verification code");
    expect(out).not.toContain("mcp-secret-value");
    await call("phone_session_end", { sessionId: id });
  }, 30_000);

  it("reports a partial batch with the failing step and what was skipped", async () => {
    const fresh = textOf(await call("phone_session_start", { deviceId: "mock:demo", approvalWaitMs: 1500 }));
    const id = /session (\w+) on/.exec(fresh)![1]!;

    const out = textOf(
      await call("phone_batch", {
        sessionId: id,
        steps: [
          { action: "open_app", appId: "com.example.demobank" },
          { action: "tap", selector: { text: "Nonexistent" } },
          { action: "tap", selector: { text: "Sign in" } },
        ],
      }),
    );

    expect(out).toContain("batch stopped: 1/3 steps");
    expect(out).toContain("[no_match]");
    expect(out).toContain("were not attempted");
    await call("phone_session_end", { sessionId: id });
  }, 30_000);

  it("lists the deep links an app declares", async () => {
    const fresh = textOf(await call("phone_session_start", { deviceId: "mock:demo", approvalWaitMs: 1500 }));
    const id = /session (\w+) on/.exec(fresh)![1]!;
    const out = textOf(await call("phone_list_deep_links", { sessionId: id, appId: "com.example.demobank" }));
    expect(out).toContain("demobank://send");
    await call("phone_session_end", { sessionId: id });
  });

  it("closes the session", async () => {
    const out = textOf(await call("phone_session_end", { sessionId }));
    expect(out).toContain("closed session");
  });
});
