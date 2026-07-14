import { describe, expect, it, vi } from "vitest";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { EaptekaAdapter } from "../src/server/adapters/eapteka.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

function requestedUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

const context = { region: "Москва" };

describe("EaptekaAdapter", () => {
  it("discovers unique matching /goods/id{ID}/ cards and keeps registry cards", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      expect(url.pathname).toBe("/search/");
      expect(url.searchParams.get("q")).toBe("Тикализис");
      return new Response(`
        <html><body>
          <article class="product-card"><h3>Тикализис таблетки 90 мг №60</h3><a href="/goods/id12345/">Подробнее</a></article>
          <article class="product-card"><a href="https://www.eapteka.ru/goods/id12345/?utm_source=test">Тикализис, дубль</a></article>
          <article class="product-card"><a href="/goods/id77777/">Другой препарат</a></article>
          <a href="https://evil.example/goods/id99999/">Тикализис</a>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const adapter = new EaptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Тикализис", {
      ...context,
      previousRefs: [{ listingId: "54321", url: "https://www.eapteka.ru/goods/id54321/?ref=history" }]
    });

    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["12345", "54321"]);
    expect(refs.find((ref) => ref.listingId === "12345")).toMatchObject({
      domain: "eapteka.ru",
      platform: "eapteka.ru",
      url: "https://www.eapteka.ru/goods/id12345/"
    });
  });

  it("collects title, review count and rating from the server-rendered dataLayer", async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <!doctype html><html><head>
        <link rel="canonical" href="https://www.eapteka.ru/goods/id12345/?utm_source=card">
      </head><body>
        <h1>Тикализис, таблетки покрытые пленочной оболочкой 90 мг, 60 шт.</h1>
        <script>window.dataLayer = window.dataLayer || []; dataLayer.push({
          item_name: "Тикализис 90 мг №60",
          item_rating: "4,8",
          item_reviews_count: "25"
        });</script>
      </body></html>
    `, { status: 200 })) as unknown as typeof fetch;
    const evidence = new MemoryEvidenceStore();
    const adapter = new EaptekaAdapter(evidence, fetchMock);

    const observation = await adapter.collect({
      domain: "eapteka.ru",
      platform: "eapteka.ru",
      listingId: "12345",
      brand: "Тикализис",
      url: "https://www.eapteka.ru/goods/id12345/",
      metadata: {}
    }, context);

    expect(observation).toMatchObject({
      domain: "eapteka.ru",
      listingId: "12345",
      brand: "Тикализис",
      canonicalUrl: "https://www.eapteka.ru/goods/id12345/",
      reviews: 25,
      rating: 4.8,
      status: "ok",
      source: "eapteka-data-layer"
    });
    expect(observation.productEvidence?.identifiers).toContainEqual({ type: "product_id", value: "12345" });
    expect(observation.evidenceRef).toMatch(/^evidence:[a-f0-9]{64}$/);
    expect(evidence.items.size).toBe(1);
  });

  it("publishes a proved zero as no_reviews and leaves rating empty", async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html><body><h1>Даксабрис таблетки 20 мг №100</h1>
      <script>dataLayer.push({"item_reviews_count":0,"item_rating":5});</script></body></html>
    `, { status: 200 })) as unknown as typeof fetch;
    const adapter = new EaptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    const observation = await adapter.collect({
      domain: "eapteka.ru",
      platform: "eapteka.ru",
      listingId: "67890",
      brand: "Даксабрис",
      url: "https://www.eapteka.ru/goods/id67890/",
      metadata: {}
    }, context);

    expect(observation).toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
  });

  it("rejects a positive review count without a valid rating", async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html><body><h1>Тикализис таблетки №60</h1>
      <script>dataLayer.push({item_reviews_count: 3, item_rating: 0});</script></body></html>
    `, { status: 200 })) as unknown as typeof fetch;
    const adapter = new EaptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.collect({
      domain: "eapteka.ru",
      platform: "eapteka.ru",
      listingId: "12345",
      brand: "Тикализис",
      url: "https://www.eapteka.ru/goods/id12345/",
      metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("classifies access denial as a blocked adapter", async () => {
    const fetchMock = vi.fn(async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;
    const adapter = new EaptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Тикализис", context)).rejects.toBeInstanceOf(AdapterBlockedError);
    const health = await adapter.healthCheck(context);
    expect(health).toMatchObject({ ok: false });
    expect(health.message).toContain("blocked_free_mode");
  });

  it("fails the health canary when an accessible search loses aggregate listing cards", async () => {
    const fetchMock = vi.fn(async () => new Response("<html><h1>Поиск</h1></html>", { status: 200 })) as unknown as typeof fetch;
    const adapter = new EaptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    const health = await adapter.healthCheck(context);
    expect(health).toMatchObject({ ok: false });
    expect(health.message).toContain("parser_changed");
  });

  it("recovers a cloud-blocked search and product through fixed source-bound routes", async () => {
    const productUrl = "https://www.eapteka.ru/goods/id208826/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.hostname === "www.eapteka.ru") return new Response("Forbidden", { status: 403 });
      if (url.hostname === "www-eapteka-ru.translate.goog") {
        const source = "https://www.eapteka.ru/search/?q=%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB";
        return new Response(`<html><base href="${source}"><script data-source-url="${source}"></script>
          <div class="listing-card" itemscope><link itemprop="url" content="${productUrl}">
            <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="125"><meta itemprop="ratingValue" content="4.93"></span>
          </div></html>`, {
          headers: { "content-type": "text/html" }
        });
      }
      if (url.hostname === "r.jina.ai") {
        return new Response(`Title: Кагоцел таблетки 12 мг 10 шт - купить, цена и отзывы

URL Source: ${productUrl}

Markdown Content:
#### Кагоцел таблетки 12 мг 10 шт: 125 отзывов покупателей и фармацевтов

4.93

на основе 125 оценок`, { headers: { "content-type": "text/plain" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new EaptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Кагоцел", context);
    expect(refs).toHaveLength(1);
    const result = await adapter.collect(refs[0], context);
    expect(result).toMatchObject({ listingId: "208826", product: "Кагоцел таблетки 12 мг 10 шт", reviews: 125, rating: 4.93, ratingCount: 125, status: "ok", source: "eapteka-reader-product" });
  });
});
