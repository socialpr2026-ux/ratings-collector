import { describe, expect, it } from "vitest";
import { playwrightCdpBaseUrl } from "../src/server/utils/sandbox-cdp.js";

describe("playwrightCdpBaseUrl", () => {
  it("removes the query token before Playwright appends json/version", () => {
    expect(playwrightCdpBaseUrl("https://sandbox.example/cdp?access_token=secret"))
      .toBe("https://sandbox.example/cdp");
  });

  it("rejects non-HTTPS endpoints", () => {
    expect(() => playwrightCdpBaseUrl("http://sandbox.example/cdp?access_token=secret"))
      .toThrow("non-HTTPS");
    expect(() => playwrightCdpBaseUrl("wss://sandbox.example/cdp?access_token=secret"))
      .toThrow("non-HTTPS");
  });

  it("rejects authority credentials and unknown routing parameters", () => {
    expect(() => playwrightCdpBaseUrl("https://user:pass@sandbox.example/cdp?access_token=secret"))
      .toThrow("credential-bearing");
    expect(() => playwrightCdpBaseUrl("https://sandbox.example/cdp?access_token=secret&route=other"))
      .toThrow("unexpected CDP query parameter");
  });
});
