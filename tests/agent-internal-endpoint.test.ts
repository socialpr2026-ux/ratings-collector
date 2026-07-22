import { describe, expect, it } from "vitest";
import { agentInternalEndpoint } from "../src/server/utils/agent-internal-endpoint.js";

describe("agentInternalEndpoint", () => {
  it("uses the forwarded public host instead of an Agent-internal origin", () => {
    const request = new Request("https://ratings-agent.internal/ratings", {
      headers: { "x-forwarded-host": "ratings-collector.edgeone.cool" }
    });

    expect(agentInternalEndpoint(request, "/api/internal/repository"))
      .toBe("https://ratings-collector.edgeone.cool/api/internal/repository");
  });

  it("keeps the request origin when no valid public host is present", () => {
    const request = new Request("http://localhost:8787/ratings", {
      headers: { host: "not a host" }
    });

    expect(agentInternalEndpoint(request, "/api/internal/repository"))
      .toBe("http://localhost:8787/api/internal/repository");
  });

  it("accepts the plain header object provided by the EdgeOne Agent runtime", () => {
    const request = {
      url: "https://ratings-agent.internal/ratings",
      headers: { "x-forwarded-host": "ratings-collector.edgeone.cool" }
    } as unknown as Request;

    expect(agentInternalEndpoint(request, "/api/internal/repository"))
      .toBe("https://ratings-collector.edgeone.cool/api/internal/repository");
  });
});
