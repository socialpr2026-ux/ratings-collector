import { describe, expect, it, vi } from "vitest";
import { applyOzonBrandFilter, assertAllowedOzonComposerUrl } from "../companion/ozon-residential.js";
import { createCompanionServer, type CompanionCollector } from "../companion/server.js";
import { AdapterBlockedError } from "../src/server/adapters/errors.js";

const allowedOrigin = "https://ratings-collector.edgeone.cool";

function collector(): CompanionCollector {
  return {
    collect: vi.fn(async (brands: readonly string[]) => brands.map((brand: string, index: number) => ({
      listingId: String(100000 + index),
      brand,
      canonicalUrl: `https://www.ozon.ru/product/${100000 + index}/`,
      product: `${brand} таблетки №20`,
      reviews: 5,
      rating: 4.9,
      status: "ok" as const,
      capturedAt: "2026-07-14T12:00:00.000Z"
    })))
  };
}

describe("local Ozon companion", () => {
  it("allows only composer product-search and exact product URLs", () => {
    const valid = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fsearch%2F%3Ftext%3D%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB%26from_global%3Dtrue%26page%3D2";
    expect(assertAllowedOzonComposerUrl(valid).hostname).toBe("www.ozon.ru");
    const exactProduct = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fproduct%2Fbaktoblis-sashe-123456789%2F";
    expect(assertAllowedOzonComposerUrl(exactProduct).searchParams.get("url")).toBe("/product/baktoblis-sashe-123456789/");
    expect(() => assertAllowedOzonComposerUrl("https://example.com/api/composer-api.bx/page/json/v2?url=/search/?text=x"))
      .toThrow("only permits the Ozon composer");
    expect(() => assertAllowedOzonComposerUrl("https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=https://metadata.google.internal/"))
      .toThrow("relative path");
    expect(() => assertAllowedOzonComposerUrl("https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=/search/?text=x&url=https://example.com"))
      .toThrow("Unexpected Ozon composer parameter");
    expect(() => assertAllowedOzonComposerUrl("https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=/product/baktoblis-123456789/?redirect=https://metadata.google.internal"))
      .toThrow("only permits Ozon product search or an exact product card");
  });

  it("rewrites an oversized generic search to the exact Ozon brand filter and keeps pagination bounded", () => {
    const input = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fsearch%2F%3Ftext%3D%D0%92%D0%B8%D0%B0%D1%80%D0%B4%D0%BE%2B%D0%A4%D0%BE%D1%80%D1%82%D0%B5%26from_global%3Dtrue%26page%3D2";
    const filtered = "/category/bady-dlya-muzhchin-6188/viardo-forte-140464399/?__rr=1&category_was_predicted=true&deny_category_prediction=true&from_global=true&text=%D0%92%D0%B8%D0%B0%D1%80%D0%B4%D0%BE+%D0%A4%D0%BE%D1%80%D1%82%D0%B5";
    const rewritten = applyOzonBrandFilter(input, new Map([["виардо форте", filtered]]));
    const endpoint = assertAllowedOzonComposerUrl(rewritten);
    const nested = new URL(endpoint.searchParams.get("url")!, "https://www.ozon.ru");

    expect(nested.pathname).toBe("/category/bady-dlya-muzhchin-6188/viardo-forte-140464399/");
    expect(nested.searchParams.get("text")).toBe("Виардо Форте");
    expect(nested.searchParams.get("page")).toBe("2");
    expect(() => assertAllowedOzonComposerUrl(
      "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fcategory%2Fbady-6183%2Fviardo-forte-140464399%2F%3Ftext%3D%D0%92%D0%B8%D0%B0%D1%80%D0%B4%D0%BE"
    )).toThrow("incomplete exact-brand proof");
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
    expect(good.json()).toEqual({
      version: 1,
      observations: [{
        listingId: "100000",
        brand: "Кагоцел",
        canonicalUrl: "https://www.ozon.ru/product/100000/",
        product: "Кагоцел таблетки №20",
        reviews: 5,
        rating: 4.9,
        status: "ok",
        capturedAt: "2026-07-14T12:00:00.000Z"
      }],
      partitions: [{ brand: "Кагоцел", status: "complete", discovered: 1, collected: 1 }]
    });
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
