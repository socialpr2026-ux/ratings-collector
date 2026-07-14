import { describe, expect, it, vi } from "vitest";
import { assertAllowedOzonComposerUrl } from "../companion/ozon-residential.js";
import { createCompanionServer, type CompanionCollector } from "../companion/server.js";
import { AdapterBlockedError } from "../src/server/adapters/errors.js";

const allowedOrigin = "https://ratings-collector.edgeone.cool";

function collector(): CompanionCollector {
  return {
    collect: vi.fn(async (brands: readonly string[]) => brands.map((brand: string, index: number) => ({
      listingId: String(100 + index),
      brand,
      canonicalUrl: `https://www.ozon.ru/product/${100 + index}/`,
      product: `${brand} таблетки №20`,
      reviews: 5,
      rating: 4.9,
      status: "ok" as const,
      capturedAt: "2026-07-14T12:00:00.000Z"
    })))
  };
}

describe("local Ozon companion", () => {
  it("allows only composer product-search URLs", () => {
    const valid = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fsearch%2F%3Ftext%3D%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB%26from_global%3Dtrue%26page%3D2";
    expect(assertAllowedOzonComposerUrl(valid).hostname).toBe("www.ozon.ru");
    expect(() => assertAllowedOzonComposerUrl("https://example.com/api/composer-api.bx/page/json/v2?url=/search/?text=x"))
      .toThrow("only permits the Ozon composer");
    expect(() => assertAllowedOzonComposerUrl("https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=https://metadata.google.internal/"))
      .toThrow("relative path");
    expect(() => assertAllowedOzonComposerUrl("https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=/search/?text=x&url=https://example.com"))
      .toThrow("Unexpected Ozon composer parameter");
  });

  it("supports the production-origin private-network preflight", async () => {
    const server = createCompanionServer({ collector: collector() });
    const response = await server.inject({
      method: "OPTIONS",
      url: "/v1/ozon/discover",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true"
      }
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(response.headers["access-control-allow-private-network"]).toBe("true");
    await server.close();
  });

  it("rejects foreign web origins", async () => {
    const server = createCompanionServer({ collector: collector() });
    const response = await server.inject({
      method: "POST",
      url: "/v1/ozon/discover",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      payload: { brands: ["Кагоцел"], region: "Москва" }
    });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it("returns the minimal observation contract and rejects arbitrary proxy input", async () => {
    const fake = collector();
    const server = createCompanionServer({ collector: fake });
    const good = await server.inject({
      method: "POST",
      url: "/v1/ozon/discover",
      headers: { origin: allowedOrigin, "content-type": "application/json" },
      payload: { brands: ["Кагоцел", "Кагоцел"], region: "Москва" }
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ observations: [{
      listingId: "100",
      brand: "Кагоцел",
      canonicalUrl: "https://www.ozon.ru/product/100/",
      product: "Кагоцел таблетки №20",
      reviews: 5,
      rating: 4.9,
      status: "ok",
      capturedAt: "2026-07-14T12:00:00.000Z"
    }] });
    expect(fake.collect).toHaveBeenCalledWith(["Кагоцел"], "Москва");

    const unsafe = await server.inject({
      method: "POST",
      url: "/v1/ozon/discover",
      headers: { origin: allowedOrigin, "content-type": "application/json" },
      payload: { brands: ["Кагоцел"], region: "Москва", targetUrl: "https://example.com" }
    });
    expect(unsafe.statusCode).toBe(400);
    await server.close();
  });

  it("turns an Ozon challenge into an explicit retry instruction, never zero reviews", async () => {
    const server = createCompanionServer({
      collector: { collect: async () => { throw new AdapterBlockedError("Ozon blocked the browser collector (HTTP 403)"); } }
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/ozon/discover",
      headers: { origin: allowedOrigin, "content-type": "application/json" },
      payload: { brands: ["Кагоцел"], region: "Москва" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ozon_challenge" });
    expect(response.json()).not.toHaveProperty("observations");
    await server.close();
  });
});
