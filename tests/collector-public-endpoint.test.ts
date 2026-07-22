import { describe, expect, it } from "vitest";
import { collectorPublicEndpoint } from "../src/server/utils/collector-public-endpoint.js";

describe("collectorPublicEndpoint", () => {
  it("keeps Agent-to-Function RPC on the canonical public project origin", () => {
    expect(collectorPublicEndpoint("/api/internal/repository"))
      .toBe("https://ratings-collector.edgeone.cool/api/internal/repository");
  });
});
