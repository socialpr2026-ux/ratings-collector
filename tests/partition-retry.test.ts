import { describe, expect, it } from "vitest";
import {
  isFailedOnlyRetryTarget,
  isLegacyTerminalFailureMessage,
  isOnlySourceUnavailableMessage,
  isSourceUnavailableMessage,
  retryableFailedPartitionCount
} from "../src/shared/partition-retry.js";
import type { PartitionResult } from "../src/shared/types.js";

function partition(overrides: Partial<PartitionResult> = {}): PartitionResult {
  return {
    domain: "example.com",
    brand: "Бренд",
    status: "blocked",
    discovered: 1,
    collected: 0,
    ...overrides
  };
}

describe("failed-only partition retry policy", () => {
  it("recognizes current and legacy terminal source blockers", () => {
    const current = partition({ retryable: false, message: "blocked: review_channel_unavailable" });
    const legacy = partition({ message: "123: blocked: review_aggregate_unavailable" });

    expect(isFailedOnlyRetryTarget(current)).toBe(false);
    expect(isFailedOnlyRetryTarget(legacy)).toBe(false);
    expect(isSourceUnavailableMessage(legacy.message)).toBe(true);
    expect(isOnlySourceUnavailableMessage(legacy.message)).toBe(true);
  });

  it("keeps a legacy mixed source-unavailable and transient card failure retryable", () => {
    const mixed = partition({
      message: "card-a: blocked: review_channel_unavailable; card-b: blocked: exact route returned HTTP 502"
    });

    expect(isSourceUnavailableMessage(mixed.message)).toBe(true);
    expect(isOnlySourceUnavailableMessage(mixed.message)).toBe(false);
    expect(isFailedOnlyRetryTarget(mixed)).toBe(true);
  });

  it("skips pure legacy quota and parser failures but retries a mixed free-route transport failure", () => {
    const quota = partition({ message: "quota_exceeded: Monthly sandbox GB-s quota exceeded" });
    const parser = partition({ message: "parser_changed: exact product markup changed" });
    const mixed = partition({
      message: "Wildberries direct appType=1 HTTP 502; browser network error: monthly sandbox GB-s quota exceeded"
    });

    expect(isLegacyTerminalFailureMessage(quota.message)).toBe(true);
    expect(isLegacyTerminalFailureMessage(parser.message)).toBe(true);
    expect(isLegacyTerminalFailureMessage(mixed.message)).toBe(false);
    expect(isFailedOnlyRetryTarget(quota)).toBe(false);
    expect(isFailedOnlyRetryTarget(parser)).toBe(false);
    expect(isFailedOnlyRetryTarget(mixed)).toBe(true);
  });

  it("retries only unfinished temporary partitions", () => {
    const partitions = [
      partition({ status: "complete" }),
      partition({ domain: "empty.example", status: "no_results" }),
      partition({ domain: "terminal.example", retryable: false }),
      partition({ domain: "legacy.example", message: "blocked: review_channel_unavailable" }),
      partition({ domain: "temporary.example", message: "blocked: HTTP 502" })
    ];

    expect(retryableFailedPartitionCount(partitions)).toBe(1);
    expect(isFailedOnlyRetryTarget(partitions.at(-1))).toBe(true);
    expect(isFailedOnlyRetryTarget(undefined)).toBe(true);
  });
});
