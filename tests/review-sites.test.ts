import { describe, expect, it, vi } from "vitest";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import {
  BLOCKED_FREE_MODE_DOMAINS,
  BlockedFreeModeAdapter,
  REVIEW_SITE_DEFINITIONS,
  ReviewSiteAdapter,
  createReviewSiteAdapters
} from "../src/server/adapters/review-sites.js";

function urlOf(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function adapterFor(domain: string, fetchImpl: typeof fetch) {
  const definition = REVIEW_SITE_DEFINITIONS.find((item) => item.domain === domain);
  if (!definition) throw new Error(`Missing definition for ${domain}`);
  return new ReviewSiteAdapter(definition, new MemoryEvidenceStore(), fetchImpl, 0);
}

const context = { region: "Москва" };

describe("first-party review-site adapters", () => {
  it.each([
    {
      domain: "otzyv.pro",
      searchPath: "/",
      searchParam: ["story", "Анвифен"],
      productPath: "/category/lekarstvennyie-sredstva/47087-anvifen.html",
      productHtml: `<h1 class="title">Анвифен капсулы</h1><meta itemprop="ratingValue" content="4.7"><meta itemprop="bestRating" content="5"><meta itemprop="reviewCount" content="18">`,
      listingId: "47087",
      source: "microdata"
    },
    {
      domain: "vseotzyvy.ru",
      searchPath: "/category/",
      searchParam: ["search", "Анвифен"],
      productPath: "/item/51734/reviews-anvifen-anvifen/",
      productHtml: `<h1><span itemprop="name">Анвифен</span> отзывы</h1><div itemprop="ratingValue">4,5</div><span itemprop="reviewCount">12</span>`,
      listingId: "51734",
      source: "microdata"
    },
    {
      domain: "otzyvru.com",
      searchPath: "/anvifen",
      direct: true,
      productPath: "/anvifen",
      productHtml: `<h1 data-id="48742">Анвифен отзывы</h1><script type="application/ld+json">{"@type":"Product","name":"Анвифен","url":"https://www.otzyvru.com/anvifen","aggregateRating":{"@type":"AggregateRating","ratingValue":4.8,"reviewCount":22,"ratingCount":31,"bestRating":5}}</script>`,
      listingId: "anvifen",
      source: "json-ld"
    }
  ])("discovers and collects $domain from its own brand search", async (fixture) => {
    const requested: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.pathname === fixture.searchPath) {
        if (fixture.direct) return new Response(fixture.productHtml);
        return new Response(`<article><a href="${fixture.productPath}">Анвифен капсулы</a></article>`);
      }
      if (url.pathname === fixture.productPath) return new Response(fixture.productHtml);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor(fixture.domain, fetchMock);

    const refs = await adapter.discover("Анвифен", context);
    const result = await adapter.collect(refs[0], context);

    expect(refs).toHaveLength(1);
    expect(requested[0].pathname).toBe(fixture.searchPath);
    if (fixture.searchParam) {
      expect(requested[0].searchParams.get(fixture.searchParam[0])).toBe(fixture.searchParam[1]);
    }
    expect(result).toMatchObject({
      domain: fixture.domain,
      listingId: fixture.listingId,
      brand: "Анвифен",
      status: "ok",
      source: fixture.source
    });
    expect(result.reviews).toBeGreaterThan(0);
    expect(result.rating).toBeGreaterThanOrEqual(0);
    expect(result.rating).toBeLessThanOrEqual(5);
    expect(result.productEvidence?.scope).toBe("product_family");
  });

  it("discovers only aggregate Uteka /reviews/ URLs from the official reviews sitemap", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemaps/sitemap-reviews.xml") return new Response(
        `<urlset>` +
        `<url><loc>https://uteka.ru/lekarstvennye-sredstva/nervnaya-sistema/anvifen/reviews/</loc></url>` +
        `<url><loc>https://uteka.ru/lekarstvennye-sredstva/nervnaya-sistema/anvifen/reviews/producer-rafarma/</loc></url>` +
        `<url><loc>https://uteka.ru/lekarstvennye-sredstva/nervnaya-sistema/fenibut/reviews/</loc></url>` +
        `</urlset>`
      );
      if (url.pathname === "/lekarstvennye-sredstva/nervnaya-sistema/anvifen/reviews/") {
        return new Response(`<h1>Анвифен отзывы</h1><meta itemprop="reviewCount" content="33"><meta itemprop="ratingValue" content="4.6"><meta itemprop="bestRating" content="5">`);
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("uteka.ru", fetchMock);

    const refs = await adapter.discover("Анвифен", context);
    const result = await adapter.collect(refs[0], context);

    expect(refs.map((item) => item.url)).toEqual([
      "https://uteka.ru/lekarstvennye-sredstva/nervnaya-sistema/anvifen/reviews/"
    ]);
    expect(result).toMatchObject({ reviews: 33, rating: 4.6, status: "ok", source: "microdata" });
    expect(result.listingId).toMatch(/^[a-f0-9]{20}$/);
  });

  it("collects every Megapteka catalog card and proves zero reviews from transfer state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/search") return new Response(
        `<article><a href="/moskva/catalog/nevrologiya-62/anvifen-kaps-250-34662">Анвифен капсулы 250 мг</a></article>` +
        `<article><a href="/moskva/catalog/nevrologiya-62/anvifen-kaps-50-34663">Анвифен капсулы 50 мг</a></article>`
      );
      if (url.pathname === "/moskva/catalog/nevrologiya-62/anvifen-kaps-250-34662") return new Response(
        `<script>window.state={"feedback":{"avg":4.8,"count":44,"fill_count":44}}</script>` +
        `<script type="application/ld+json">{"@type":"Product","name":"Анвифен капсулы 250 мг №20","url":"https://megapteka.ru/moskva/catalog/nevrologiya-62/anvifen-kaps-250-34662","aggregateRating":{"@type":"AggregateRating","ratingValue":4.8,"reviewCount":44,"bestRating":5}}</script>`
      );
      if (url.pathname === "/moskva/catalog/nevrologiya-62/anvifen-kaps-50-34663") return new Response(
        `<h1>Анвифен капсулы 50 мг №20</h1><script>window.state={"feedback":{"count":0}}</script>`
      );
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("megapteka.ru", fetchMock);

    const refs = await adapter.discover("Анвифен", context);
    const results = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));

    expect(refs).toMatchObject([
      { listingId: "34662", url: "https://megapteka.ru/moskva/catalog/nevrologiya-62/anvifen-kaps-250-34662" },
      { listingId: "34663", url: "https://megapteka.ru/moskva/catalog/nevrologiya-62/anvifen-kaps-50-34663" }
    ]);
    expect(results[0]).toMatchObject({ listingId: "34662", reviews: 44, rating: 4.8, status: "ok" });
    expect(results[1]).toMatchObject({ listingId: "34663", reviews: 0, rating: null, status: "no_reviews" });
    expect(results[0].productEvidence?.scope).toBe("listing");
  });

  it("uses the trusted dynamic browser route for iRecommend and keeps reviews separate from votes", async () => {
    const headers: Headers[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      headers.push(new Headers(init?.headers));
      if (url.pathname === "/srch") {
        return new Response(`<ul class="srch-result-nodes"><li><div class="ProductTizer" data-type="2" data-nid="10168327"><div class="title"><a href="/content/nootropnoe-sredstvo-rfarma-anvifen">Ноотропное средство Анвифен</a></div></div><a href="/content/user-review-anvifen">Отдельный отзыв Анвифен</a></li></ul>`);
      }
      if (url.pathname === "/content/nootropnoe-sredstvo-rfarma-anvifen") {
        return new Response(`<html><head><link rel="canonical" href="https://irecommend.ru/content/nootropnoe-sredstvo-rfarma-anvifen"></head><body><h1>Ноотропное средство Анвифен</h1><div>Среднее: 4.4 (20 голосов)</div><a href="/content/anvifen">Читать все отзывы 25</a></body></html>`);
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("irecommend.ru", fetchMock);

    const refs = await adapter.discover("Анвифен", context);
    const result = await adapter.collect(refs[0], context);

    expect(result).toMatchObject({ reviews: 25, rating: 4.4, ratingCount: 20, status: "ok", source: "irecommend-visible" });
    expect(refs).toHaveLength(1);
    expect(result.listingId).toBe("10168327");
    expect(result.canonicalUrl).toBe("https://irecommend.ru/content/anvifen");
    expect(result.productEvidence?.scope).toBe("product_family");
    expect(headers.every((value) => value.get("x-ratings-browser") === "1" && value.get("x-ratings-scroll") === "1")).toBe(true);
  });

  it("discovers Otzovik through external results, rejects a false candidate and keeps discovery ids stable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/__external_search__") return new Response(`
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fotzovik.com%2Freviews%2Flekarstvo_anvi_anvifen%2F">Отзывы о Лекарство Anvi «Анвифен»</a>
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fotzovik.com%2Freviews%2Ftabletki_rafarma_anvifen%2F">Отзывы о Таблетки Рафарма «Анвифен»</a>
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fotzovik.com%2Freviews%2Ftabletki_organika_fenibut%2F">Отзывы о Таблетки Органика «Фенибут»</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fotzovik.com%2Freviews%2Ftabletki_organika_fenibut%2F">Невролог выписал Анвифен, но купила аналог</a>
      `);
      if (url.pathname === "/reviews/lekarstvo_anvi_anvifen/") return new Response(`<h1 itemprop="name">Лекарство Anvi «Анвифен»</h1><span itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.04"><meta itemprop="reviewCount" content="83"><meta itemprop="bestRating" content="5"></span><a data-pid="353779">Добавить отзыв</a>`);
      if (url.pathname === "/reviews/tabletki_rafarma_anvifen/") return new Response(`<h1 itemprop="name">Таблетки Рафарма «Анвифен»</h1><span itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.25"><meta itemprop="reviewCount" content="12"><meta itemprop="bestRating" content="5"></span><a data-pid="2077018">Добавить отзыв</a>`);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("otzovik.com", fetchMock);

    const refs = await adapter.discover("Анвифен", context);
    const results = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));

    expect(refs).toHaveLength(2);
    expect(results.map((item) => item.listingId)).toEqual(refs.map((item) => item.listingId));
    expect(results).toMatchObject([{ reviews: 83, rating: 4 }, { reviews: 12, rating: 4.3 }]);
    expect(results.every((item) => item.productEvidence?.scope === "product_family")).toBe(true);
  });

  it("accepts an explicit external-search zero as proved no_results for Otzovik", async () => {
    const fetchMock = (async () => new Response(
      `<main><h1>No results found for <strong>site:otzovik.com/reviews/ &quot;Тикализис&quot;</strong></h1></main>`
    )) as typeof fetch;
    const adapter = adapterFor("otzovik.com", fetchMock);

    await expect(adapter.discover("Тикализис", context)).resolves.toEqual([]);
  });

  it("uses direct brand pages on both Otzyv domains and never replaces their slug identity", async () => {
    for (const domain of ["otzyvru.com", "ru.otzyv.com"]) {
      const origin = domain === "otzyvru.com" ? "https://www.otzyvru.com" : "https://ru.otzyv.com";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.pathname !== "/tikalizis") return new Response("missing", { status: 404 });
        return new Response(
          `<h1 data-id="999999">Тикализис отзывы</h1>` +
          `<script type="application/ld+json">{"@type":"Product","name":"Тикализис","url":"${origin}/tikalizis","aggregateRating":{"@type":"AggregateRating","ratingValue":5,"reviewCount":2,"ratingCount":2,"bestRating":5}}</script>`
        );
      }) as unknown as typeof fetch;
      const adapter = adapterFor(domain, fetchMock);

      const refs = await adapter.discover("Тикализис", context);
      const result = await adapter.collect(refs[0], context);

      expect(refs).toMatchObject([{ listingId: "tikalizis" }]);
      expect(result).toMatchObject({ listingId: "tikalizis", reviews: 2, rating: 5, status: "ok" });
      expect(result.productEvidence?.scope).toBe("product_family");
    }
  });

  it("fails closed when a direct Otzyv slug serves another brand", async () => {
    const fetchMock = (async () => new Response(
      `<h1>Фенибут отзывы</h1><meta itemprop="reviewCount" content="12"><meta itemprop="ratingValue" content="4.5">`
    )) as typeof fetch;
    const adapter = adapterFor("otzyvru.com", fetchMock);

    await expect(adapter.discover("Тикализис", context)).rejects.toMatchObject({ code: "parser_changed" });
  });

  it("returns proved no_results for Pravogolosa but rejects unaggregated individual reviews", async () => {
    const zero = adapterFor("pravogolosa.net", (async () => new Response(
      `<h3>По вашему запросу &laquo;Тикализис&raquo; всего найдено отзывов: 0</h3>`
    )) as typeof fetch);
    await expect(zero.discover("Тикализис", context)).resolves.toEqual([]);

    const alternativeZero = adapterFor("pravogolosa.net", (async () => new Response(
      `<h4>По запросу <b>"Даксабрис"</b> ничего не нашлось. Попробуйте изменить условия поиска.</h4>`
    )) as typeof fetch);
    await expect(alternativeZero.discover("Даксабрис", context)).resolves.toEqual([]);

    const individual = adapterFor("pravogolosa.net", (async () => new Response(
      `<h3>По вашему запросу &laquo;Анвифен&raquo; всего найдено отзывов: 1</h3>`
    )) as typeof fetch);
    await expect(individual.discover("Анвифен", context)).rejects.toMatchObject({ code: "parser_changed" });
  });

  it("publishes a confirmed zero-review product with an empty rating", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemaps/sitemap-reviews.xml") return new Response(`<urlset><url><loc>https://uteka.ru/lekarstvennye-sredstva/nervnaya-sistema/anvifen/reviews/</loc></url></urlset>`);
      return new Response(`<h1>Анвифен капсулы</h1><meta itemprop="reviewCount" content="0"><meta itemprop="ratingValue" content="5">`);
    }) as typeof fetch;
    const adapter = adapterFor("uteka.ru", fetchMock);
    const [ref] = await adapter.discover("Анвифен", context);

    await expect(adapter.collect(ref, context)).resolves.toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
  });

  it("fails closed when a known layout no longer exposes reviewCount", async () => {
    const fetchMock = (async () => new Response(`<h1>Анвифен</h1>`)) as typeof fetch;
    const adapter = adapterFor("uteka.ru", fetchMock);
    await expect(adapter.collect({
      domain: "uteka.ru",
      platform: "uteka.ru",
      listingId: "578521",
      brand: "Анвифен",
      url: "https://uteka.ru/product/anvifen-578521/",
      metadata: {}
    }, context)).rejects.toMatchObject({ code: "parser_changed" });
  });
});

describe("blocked free-mode review sites", () => {
  it.each(BLOCKED_FREE_MODE_DOMAINS)("registers %s without making a request or using Apify", async (domain) => {
    const adapter = new BlockedFreeModeAdapter(domain);
    const health = await adapter.healthCheck(context);
    expect(health).toMatchObject({ ok: false });
    expect(health.message).toContain("blocked_free_mode");
    expect(health.message).toContain("платный резерв не используется");
  });

  it("registers nine direct adapters plus one explicit blocker", () => {
    const adapters = createReviewSiteAdapters(new MemoryEvidenceStore());
    expect(adapters.map((item) => item.supportedDomains[0])).toEqual([
      "irecommend.ru",
      "otzyv.pro",
      "vseotzyvy.ru",
      "otzyvru.com",
      "uteka.ru",
      "megapteka.ru",
      "otzovik.com",
      "pravogolosa.net",
      "ru.otzyv.com",
      "medum.ru"
    ]);
  });
});
