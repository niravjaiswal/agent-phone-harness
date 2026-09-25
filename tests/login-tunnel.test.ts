import { describe, expect, it } from "vitest";
import { mintLoginCode, redeemLoginCode } from "../src/core/login-codes.js";
import { findQuickTunnelUrl } from "../src/http/tunnel.js";

describe("one-time panel sign-in codes", () => {
  it("work exactly once", () => {
    const code = mintLoginCode();
    expect(redeemLoginCode(code)).toBe(true);
    expect(redeemLoginCode(code)).toBe(false);
  });

  it("expire", () => {
    const code = mintLoginCode(-1);
    expect(redeemLoginCode(code)).toBe(false);
  });

  it("reject anything minted elsewhere", () => {
    expect(redeemLoginCode("not-a-real-code")).toBe(false);
  });
});

describe("quick tunnel output", () => {
  it("finds the public URL in cloudflared's log box", () => {
    const log = [
      "2026-09-24T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-09-24T10:00:01Z INF +--------------------------------------------------------------------------------------------+",
      "2026-09-24T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-09-24T10:00:01Z INF |  https://brave-otter-sample-words.trycloudflare.com                                         |",
    ].join("\n");
    expect(findQuickTunnelUrl(log)).toBe("https://brave-otter-sample-words.trycloudflare.com");
  });

  it("ignores cloudflare's own API host, which appears in failure messages", () => {
    expect(findQuickTunnelUrl("Requesting new quick Tunnel on trycloudflare.com...")).toBeUndefined();
    expect(
      findQuickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'),
    ).toBeUndefined();
  });
});
