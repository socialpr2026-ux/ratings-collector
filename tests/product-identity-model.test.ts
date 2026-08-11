import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProductFact } from "../src/shared/product-master.js";
import { HttpProductIdentityModelProvider } from "../src/server/product-identity-model.js";

const candidate = randomUUID();
const fact: ProductFact = {
  field: "strength",
  value: "50 мг from raw page",
  normalizedValue: "50 мг",
  sourceKind: "source_title",
  sourceRef: "https://docs.google.com/spreadsheets/d/private/edit?token=secret",
  extractorVersion: "2",
  observedAt: "2026-08-11T00:00:00.000Z"
};

describe("external product identity ranker boundary", () => {
  it("sends only normalized facts and returns candidates in probability order", async () => {
    let requestBody = "";
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
        results: [
          { candidateVariantId: candidate, probability: 0.998, positiveEvidence: ["strength"], negativeEvidence: [], modelVersion: "ranker-1" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new HttpProductIdentityModelProvider({
      endpoint: "https://example.com/v1/rank",
      token: "secret-token",
      fetchImpl
    });

    const results = await provider.rank({ normalizedTitle: "анвифен капсулы 50 мг", facts: [fact], candidateVariantIds: [candidate] });

    expect(results).toMatchObject([{ candidateVariantId: candidate, probability: 0.998 }]);
    expect(JSON.parse(requestBody)).toEqual({
      schemaVersion: 1,
      title: "анвифен капсулы 50 мг",
      facts: [{ field: "strength", value: "50 мг" }],
      candidateVariantIds: [candidate]
    });
    expect(requestBody).not.toContain("docs.google.com");
    expect(requestBody).not.toContain("secret-token");
    expect(requestBody).not.toContain("raw page");
  });

  it("rejects a model response that invents a catalog candidate", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{
        candidateVariantId: randomUUID(), probability: 1,
        positiveEvidence: [], negativeEvidence: [], modelVersion: "ranker-1"
      }]
    }), { status: 200 })) as unknown as typeof fetch;
    const provider = new HttpProductIdentityModelProvider({ endpoint: "https://example.com/rank", token: "token", fetchImpl });

    await expect(provider.rank({ normalizedTitle: "товар", facts: [], candidateVariantIds: [candidate] }))
      .rejects.toThrow("unknown candidate ID");
  });

  it("cancels an oversized model response before JSON parsing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [],
      padding: "x".repeat(256 * 1024)
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const provider = new HttpProductIdentityModelProvider({
      endpoint: "https://example.com/rank",
      token: "token",
      fetchImpl
    });

    await expect(provider.rank({ normalizedTitle: "товар", facts: [], candidateVariantIds: [candidate] }))
      .rejects.toThrow("превышает лимит 262144 байт");
  });

  it("does not call the external provider when deterministic blocking found no candidates", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = new HttpProductIdentityModelProvider({ endpoint: "https://example.com/rank", token: "token", fetchImpl });
    await expect(provider.rank({ normalizedTitle: "новый sku", facts: [], candidateVariantIds: [] })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
