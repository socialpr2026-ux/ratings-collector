import { describe, expect, it } from "vitest";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "../src/server/adapters/errors.js";
import { failureEnvelope } from "../src/server/failure-envelope.js";

describe("typed collection failure policy", () => {
  it("keeps a wrapped monthly quota sticky even when the message also contains HTTP 502", () => {
    expect(failureEnvelope(new AdapterBlockedError(
      "Ozon composer HTTP 502: EdgeOne Sandbox monthly GB-s quota exceeded"
    ))).toMatchObject({ category: "quota", retryable: false, scope: "account", upstreamStatus: 502 });
  });

  it.each([
    ["HTTP 429 Retry-After", "throttle", true],
    ["upstream returned HTTP 502", "transport", true],
    ["run_deadline_exceeded", "timeout", true],
    ["CAPTCHA challenge", "access_block", false]
  ] as const)("classifies %s", (message, category, retryable) => {
    expect(failureEnvelope(new AdapterBlockedError(message))).toMatchObject({ category, retryable });
  });

  it("never retries deterministic parser or proof failures", () => {
    expect(failureEnvelope(new ParserChangedError("unknown product markup")))
      .toMatchObject({ category: "parser_changed", retryable: false });
    expect(failureEnvelope(new AdapterBlockedError("Yandex exact XML proof is incomplete")))
      .toMatchObject({ category: "proof_incomplete", retryable: false });
  });

  it("preserves route metadata without using it to weaken the classification", () => {
    expect(failureEnvelope(new AdapterQuotaError("quota_exceeded"), {
      provider: "edgeone",
      route: "sandbox",
      host: "ozon.ru",
      attempt: 1
    })).toEqual({
      category: "quota",
      retryable: false,
      scope: "account",
      message: "quota_exceeded",
      provider: "edgeone",
      route: "sandbox",
      host: "ozon.ru",
      attempt: 1
    });
  });
});
