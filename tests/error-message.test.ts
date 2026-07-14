import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../src/server/utils/error-message.js";

describe("safeErrorMessage", () => {
  it("redacts credentials embedded in browser and HTTP errors", () => {
    const value = safeErrorMessage(new Error(
      "CDP https://sandbox.example/cdp?access_token=top-secret/json/version/ " +
      "X-Access-Token: another-secret Authorization=Bearer-secret " +
      "Bearer third-secret apify_api_abcdefghijklmnopqrstuvwxyz " +
      "{\"envdAccessToken\":\"json-secret\"}"
    ));

    expect(value).not.toContain("top-secret");
    expect(value).not.toContain("another-secret");
    expect(value).not.toContain("third-secret");
    expect(value).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(value).not.toContain("json-secret");
    expect(value).toContain("access_token=[redacted]");
  });

  it("bounds messages without changing ordinary errors", () => {
    expect(safeErrorMessage(new Error("обычная ошибка"))).toBe("обычная ошибка");
    expect(safeErrorMessage("123456", 4)).toBe("1234");
  });
});
