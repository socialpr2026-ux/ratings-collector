import { describe, expect, it } from "vitest";
import { readAgentJson } from "../src/server/utils/agent-request.js";
import { shouldUseHardenedBrowser } from "../src/server/utils/agent-browser-routing.js";

describe("readAgentJson", () => {
  it("reads a standard Web Request JSON body", async () => {
    const request = new Request("https://example.test/ratings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "web-request" })
    });

    await expect(readAgentJson<{ runId: string }>(request)).resolves.toEqual({ runId: "web-request" });
  });

  it("reads the parsed body shape injected by Makers Agent", async () => {
    const request = { body: { runId: "makers-agent" } } as unknown as Request;

    await expect(readAgentJson<{ runId: string }>(request)).resolves.toEqual({ runId: "makers-agent" });
  });
});

describe("Agent browser routing", () => {
  it("routes XML from an unknown profiled domain through the hardened browser", () => {
    const request = new Request("https://unknown.example/sitemap.xml", {
      headers: { "x-ratings-browser": "1" }
    });
    expect(shouldUseHardenedBrowser(request)).toBe(true);
  });

  it("keeps fixed API POST requests outside browser navigation", () => {
    const request = new Request("https://api.apify.com/v2/acts/example", {
      method: "POST",
      headers: { "x-ratings-browser": "1" }
    });
    expect(shouldUseHardenedBrowser(request)).toBe(false);
  });
});
