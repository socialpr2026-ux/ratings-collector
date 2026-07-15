import { describe, expect, it, vi } from "vitest";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import {
  BLOCKED_FREE_MODE_DOMAINS,
  BlockedFreeModeAdapter,
  REVIEW_SITE_DEFINITIONS,
  ReviewSiteAdapter,
  UNPROVEN_AGGREGATE_DOMAINS,
  UnprovenAggregateAdapter,
  createReviewSiteAdapters
} from "../src/server/adapters/review-sites.js";
import { canConfirmObservation } from "../src/client/review-copy.js";
import { analyzeProductIdentity } from "../src/server/utils/product-name.js";
import { hasDeterministicAggregateProof } from "../src/shared/review-aggregates.js";

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

  it("follows review-search pagination without accepting a brand mention from another product's snippet", async () => {
    const requested: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.pathname === "/" && !url.searchParams.has("search_start")) return new Response(
        `<article><h2>Тикализис</h2><a href="/category/lekarstvennyie-sredstva/823845-tikalizis.html">Тикализис - отзыв</a></article>` +
        `<article><h2>Фенибут</h2><a href="/category/lekarstvennyie-sredstva/100-fenibut.html">Фенибут</a><p>В отзыве упомянут Тикализис</p></article>` +
        `<div class="pagination"><a href="/?do=search&amp;subaction=search&amp;story=Тикализис&amp;search_start=2">2</a></div>`
      );
      if (url.searchParams.get("search_start") === "2") return new Response(
        `<article><h2>Тикализис 90 мг</h2><a href="/category/lekarstvennyie-sredstva/823846-tikalizis-90.html">Тикализис 90 мг</a></article>`
      );
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("otzyv.pro", fetchMock);

    const refs = await adapter.discover("Тикализис", context);

    expect(requested).toHaveLength(2);
    expect(refs.map((item) => item.listingId)).toEqual(["823845", "823846"]);
  });

  it("treats the Otzyv.pro 30-dose page as one product variant and excludes user reviews from proof", async () => {
    const productPath = "/category/badyi/62074-ocillokokcinum-30-doz-grangomeopaticheskie.html";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/") return new Response(
        `<article><h2>Оциллококцинум 30 доз</h2><a href="${productPath}">Оциллококцинум 30 доз гран.гомеопатические</a></article>`
      );
      if (url.pathname === productPath) return new Response(`
        <main itemscope itemtype="https://schema.org/Product">
          <h1 itemprop="name">Оциллококцинум 30 доз гран.гомеопатические - отзыв</h1>
          <meta itemprop="ratingValue" content="2">
          <meta itemprop="bestRating" content="5">
          <meta itemprop="reviewCount" content="1">
          <article itemprop="review" itemscope itemtype="https://schema.org/Review">
            <h2 itemprop="name">Гранулы или плацебо?</h2>
            <span itemprop="description">6 грамм сахара за 400 рублей. Брала упаковку из 30 доз.</span>
          </article>
          <article class="review-card"><h2 itemprop="name">Супер препарат, помогает 100%!</h2></article>
        </main>
      `);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("otzyv.pro", fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    const result = await adapter.collect(refs[0], context);
    const identity = analyzeProductIdentity({
      brand: result.brand,
      product: result.product,
      url: result.canonicalUrl,
      evidence: result.productEvidence
    });

    expect(result).toMatchObject({ listingId: "62074", reviews: 1, rating: 2, status: "ok" });
    expect(result.productEvidence?.scope).toBe("listing");
    expect(result.productEvidence?.variants).toEqual([]);
    expect(JSON.stringify(result.productEvidence)).not.toMatch(/Гранулы или плацебо|6 грамм сахара|Супер препарат/iu);
    expect(identity).toMatchObject({
      label: "гранулы №30",
      granularity: "variant",
      confidence: "exact"
    });
    expect(identity.label).not.toContain("Общий рейтинг");
  });

  it.each(["Тикализис", "Даксабрис"])("requires visible no-results proof for empty iRecommend search: %s", async (brand) => {
    const proved = adapterFor("irecommend.ru", (async () => new Response(
      `<main><h1>${brand}</h1><p>Не нашли? Попробуйте поиск по сайту через Google или Яндекс</p></main>`
    )) as typeof fetch);
    await expect(proved.discover(brand, context)).resolves.toEqual([]);

    const ambiguous = adapterFor("irecommend.ru", (async () => new Response(
      `<main><h1>${brand}</h1><p>Популярные отзывы</p></main>`
    )) as typeof fetch);
    await expect(ambiguous.discover(brand, context)).rejects.toMatchObject({ code: "blocked" });
  });

  it("requires visible no-results proof for an empty first-party search", async () => {
    const proved = adapterFor("otzyv.pro", (async () => new Response(
      `<main><h1>Поиск по сайту</h1><div>Ничего не найдено!</div></main>`
    )) as typeof fetch);
    await expect(proved.discover("Даксабрис", context)).resolves.toEqual([]);

    const ambiguous = adapterFor("otzyv.pro", (async () => new Response(
      `<main><h1>Поиск по сайту</h1><div>Новые отзывы</div></main>`
    )) as typeof fetch);
    await expect(ambiguous.discover("Даксабрис", context)).rejects.toMatchObject({ code: "blocked" });
  });

  it("accepts the live Vseotzyvy empty-search proof for Хондрофен", async () => {
    const adapter = adapterFor("vseotzyvy.ru", (async () => new Response(`
      <main>
        <h1>Хондрофен</h1>
        <p>Подходящих объектов не найдено. Попробуйте изменить запрос поиска.</p>
      </main>
    `)) as typeof fetch);

    await expect(adapter.discover("Хондрофен", context)).resolves.toEqual([]);
  });

  it("does not accept a Vseotzyvy no-results message for another query", async () => {
    const adapter = adapterFor("vseotzyvy.ru", (async () => new Response(`
      <main>
        <h1>Другой препарат</h1>
        <p>Подходящих объектов не найдено. Попробуйте изменить запрос поиска.</p>
      </main>
    `)) as typeof fetch);

    await expect(adapter.discover("Хондрофен", context)).rejects.toMatchObject({ code: "blocked" });
  });

  it.each([
    { domain: "otzyv.pro", brand: "Тикализис", path: "/category/lekarstvennyie-sredstva/823845-tikalizis.html", reviews: 1, rating: 5 },
    { domain: "vseotzyvy.ru", brand: "Тикализис", path: "/item/113727/reviews-tikalizis/", reviews: 1, rating: 5 },
    { domain: "vseotzyvy.ru", brand: "Даксабрис", path: "/item/113736/reviews-daksabris/", reviews: 1, rating: 5 },
    { domain: "otzyvru.com", brand: "Тикализис", path: "/tikalizis", reviews: 2, rating: 5 },
    { domain: "otzyvru.com", brand: "Даксабрис", path: "/daksabris", reviews: 1, rating: 5 },
    { domain: "ru.otzyv.com", brand: "Тикализис", path: "/tikalizis", reviews: 1, rating: 5 },
    { domain: "ru.otzyv.com", brand: "Даксабрис", path: "/daksabris", reviews: 1, rating: 5 }
  ])("keeps live-derived review counts separate from rating for $domain / $brand", async (fixture) => {
    const origin = fixture.domain === "otzyvru.com" ? "https://www.otzyvru.com" : `https://${fixture.domain}`;
    const productHtml = `<h1>${fixture.brand}</h1><script type="application/ld+json">` +
      JSON.stringify({
        "@type": "Product", name: fixture.brand, url: `${origin}${fixture.path}`,
        aggregateRating: { "@type": "AggregateRating", ratingValue: fixture.rating, reviewCount: fixture.reviews, ratingCount: 9, bestRating: 5 }
      }) + `</script>`;
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === fixture.path) return new Response(productHtml);
      return new Response(`<article><h2>${fixture.brand}</h2><a href="${fixture.path}">${fixture.brand}</a></article>`);
    }) as typeof fetch;
    const adapter = adapterFor(fixture.domain, fetchMock);

    const refs = await adapter.discover(fixture.brand, context);
    const result = await adapter.collect(refs[0], context);

    expect(result).toMatchObject({ reviews: fixture.reviews, rating: fixture.rating, ratingCount: 9, status: "ok" });
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

  it("does not block an exact Uteka target on an unrelated product canary", async () => {
    const requested: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.pathname === "/sitemaps/sitemap-reviews.xml") return new Response(
        `<urlset><url><loc>https://uteka.ru/lekarstvennye-sredstva/gomeopatiya/ocillokokcinum/reviews/</loc></url></urlset>`
      );
      if (url.pathname === "/lekarstvennye-sredstva/gomeopatiya/ocillokokcinum/reviews/") return new Response(
        `<h1>Оциллококцинум отзывы</h1>` +
        `<meta itemprop="reviewCount" content="96">` +
        `<meta itemprop="ratingValue" content="4.4">` +
        `<meta itemprop="bestRating" content="5">`
      );
      // This is the former unrelated canary. Its changed layout must not stop
      // collection for Оциллококцинум.
      if (url.pathname.endsWith("/tikalizis/reviews/")) return new Response(`<h1>Тикализис</h1>`);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("uteka.ru", fetchMock);

    const health = await adapter.healthCheck(context);
    const refs = await adapter.discover("Оциллококцинум", context);
    const observation = await adapter.collect(refs[0], context);

    expect(health).toMatchObject({ ok: true });
    expect(health.message).toContain("official reviews sitemap is complete");
    expect(refs).toMatchObject([{
      url: "https://uteka.ru/lekarstvennye-sredstva/gomeopatiya/ocillokokcinum/reviews/"
    }]);
    expect(observation).toMatchObject({
      brand: "Оциллококцинум",
      reviews: 96,
      rating: 4.4,
      status: "ok"
    });
    expect(requested.map((url) => url.pathname)).toEqual([
      "/sitemaps/sitemap-reviews.xml",
      "/lekarstvennye-sredstva/gomeopatiya/ocillokokcinum/reviews/"
    ]);
  });

  it("collects every Megapteka catalog card and proves zero reviews from transfer state", async () => {
    const requested: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.pathname === "/") return new Response(`<script>window.state={"city":{"id":77,"code":"moskva","name":"Москва"}}</script>`);
      if (url.hostname === "api.megapteka.ru" && url.pathname === "/ma/site/v4/search/items") {
        const data = JSON.parse(url.searchParams.get("data") ?? "{}") as { query?: string; city_id?: number; page?: number };
        expect(data).toMatchObject({ query: "Анвифен", city_id: 77, page: 1 });
        return Response.json({ items: [
          { id: 34662, code: "anvifen-kaps-250-34662", group_code: "nevrologiya-62", name: "Анвифен капсулы 250 мг" },
          { id: 34663, code: "anvifen-kaps-50-34663", group_code: "nevrologiya-62", name: "Анвифен капсулы 50 мг" }
        ], search: { empty_info: null } });
      }
      if (url.pathname === "/moskva/catalog/nevrologiya-62/anvifen-kaps-250-34662") return new Response(
        `<script>window.state={"feedback":{"avg":4.8,"count":44,"fill_count":44}}</script>` +
        `<script type="application/ld+json">[
          {"@type":"Product","name":"Анвифен капсулы 50 мг №20","url":"https://megapteka.ru/moskva/catalog/nevrologiya-62/anvifen-kaps-50-34663","aggregateRating":{"@type":"AggregateRating","ratingValue":5,"reviewCount":2,"bestRating":5}},
          {"@type":"Product","name":"Анвифен капсулы 250 мг №20","productID":"34662","url":"https://megapteka.ru/moskva/catalog/nevrologiya-62/anvifen-kaps-250-34662","aggregateRating":{"@type":"AggregateRating","ratingValue":4.8,"reviewCount":44,"bestRating":5}}
        ]</script>` +
        `<aside data-testid="product-card"><img alt="Анвифен капсулы 100 мг №10" src="https://megapteka.ru/recommendation.jpg"></aside>`
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
    expect(results[0].productEvidence).toMatchObject({
      variants: [],
      identifiers: [{ type: "product_id", value: "34662" }]
    });
    expect(results[0].productEvidence?.signals.map((signal) => signal.text)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("50 мг"), expect.stringContaining("100 мг")])
    );
    const productIdentity = analyzeProductIdentity({
      brand: "Анвифен",
      product: results[0].product,
      url: results[0].canonicalUrl,
      evidence: results[0].productEvidence
    });
    expect(productIdentity).toMatchObject({
      label: "капсулы 250 мг №20",
      granularity: "variant",
      confidence: "exact"
    });
    expect(canConfirmObservation({ ...results[0], productIdentity })).toBe(true);
    expect(requested.some((url) => url.pathname === "/search")).toBe(false);
  });

  it("does not turn an ambiguous empty Megapteka API response into no_results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/") return new Response(`<script>window.state={"city":{"id":77,"code":"moskva"}}</script>`);
      if (url.hostname === "api.megapteka.ru") return Response.json({ items: [], search: {} });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    await expect(adapterFor("megapteka.ru", fetchMock).discover("Кагоцел", context))
      .rejects.toMatchObject({ code: "blocked" });
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

  it("keeps the pharmaceutical iRecommend result, rejects the same-name cosmetic and carries the search review count", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/srch") return new Response(`
        <ul class="srch-result-nodes">
          <li><div class="ProductTizer" data-type="2" data-nid="135637"><div class="title"><a href="/content/protivovirusnye-sredstva-kagotsel">Противовирусные средства Кагоцел</a></div><span>430 отзывов</span><div class="fivestar-summary"><span class="average-rating">Среднее: <span>3.9</span></span></div></div></li>
          <li><div class="ProductTizer" data-type="2" data-nid="6599826"><div class="title"><a href="/content/maslo-dlya-gub-kagotsel-pryanoe-kakao-i-sladkii-mindal">Масло для губ Кагоцел Пряное какао и сладкий миндаль</a></div><span>2 отзыва</span></div></li>
        </ul>
      `);
      if (url.pathname === "/content/protivovirusnye-sredstva-kagotsel") return new Response(
        `<h1>Противовирусные средства Кагоцел — отзывы</h1>` +
        `<div class="fivestar-summary"><span class="total-votes">(417 голосов)</span></div>` +
        `<a href="/anonreview?noderef=135637">Написать отзыв</a>`
      );
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("irecommend.ru", fetchMock);

    const refs = await adapter.discover("Кагоцел", context);
    const result = await adapter.collect(refs[0], context);

    expect(refs).toMatchObject([{
      listingId: "135637",
      title: "Противовирусные средства Кагоцел",
      metadata: { source: "irecommend-search", reviewCount: 430, rating: 3.9 }
    }]);
    expect(result).toMatchObject({ reviews: 430, rating: 3.9, ratingCount: null, status: "ok" });
  });

  it("binds all three live Cereton iRecommend search aggregates to their own dedicated pages", async () => {
    const cards = [
      ["4773250", "nootropnoe-sredstvo-soteks-ampuly-vv-i-vm-tsereton", "Ноотропное средство Сотекс Ампулы в/в и в/м Церетон", 7, 4.9],
      ["5227645", "nootropnoe-sredstvo-zao-soteks-tsereton", "Ноотропное средство ЗАО Сотекс Церетон", 13, 4.5],
      ["10010285", "nootropnoe-sredstvo-zao-soteks-tsereton-rastvor-dlya-priema-vnutr", "Ноотропное средство ЗАО Сотекс Церетон раствор для приема внутрь", 3, 4.7]
    ] as const;
    const adapter = adapterFor("irecommend.ru", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname !== "/srch") throw new Error("proved ProductTizers must not require product-page requests");
      return new Response(`<ul class="srch-result-nodes">${cards.map(([id, slug, title, reviews, rating]) =>
        `<li><div class="ProductTizer" data-type="2" data-nid="${id}"><div class="title"><a href="/content/${slug}">${title}</a></div>` +
        `<a class="read-all-reviews-link"><span class="counter">${reviews}</span></a>` +
        `<div class="fivestar-summary"><span class="average-rating"><span>${rating}</span></span></div></div></li>`
      ).join("")}</ul>`);
    }) as typeof fetch);

    const refs = await adapter.discover("Церетон", context);
    const results = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));

    expect(results.map((item) => [item.listingId, item.reviews, item.rating, item.status])).toEqual([
      ["4773250", 7, 4.9, "ok"], ["5227645", 13, 4.5, "ok"], ["10010285", 3, 4.7, "ok"]
    ]);
    expect(results.every((item) => item.productEvidence?.scope === "product_family")).toBe(true);
    expect(results.every((item) => item.productEvidence?.variants.length === 1)).toBe(true);
    expect(results.every((item) => item.productEvidence?.identifiers.some((identifier) =>
      identifier.type === "product_id" && identifier.value === item.listingId
    ))).toBe(true);
    expect(results.every((item) => {
      const productIdentity = analyzeProductIdentity({
        brand: item.brand, product: item.product, url: item.canonicalUrl, evidence: item.productEvidence
      });
      return hasDeterministicAggregateProof({ ...item, productIdentity });
    })).toBe(true);
  });

  it("does not mistake iRecommend's dormant captcha script for an active challenge", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/srch") return new Response(`<html><head><script src="/captcha-checker/assets/script.js"></script></head><body>
        <ul class="srch-result-nodes"><li><div class="ProductTizer" data-type="2" data-nid="2473">
          <div class="title"><a href="/content/protivoprostudnyi-gomeopaticheskii-preparat-laboratoriya-buaron-otsillokoktsinum">Гомеопатия Лаборатория БУАРОН Оциллококцинум</a></div>
          <a class="read-all-reviews-link"><span class="counter">258</span></a><span class="reviewsLink">258 отзывов</span>
          <div class="fivestar-summary"><span class="average-rating"><span>3.7</span></span></div>
        </div></li></ul></body></html>`);
      throw new Error("a proved iRecommend ProductTizer must not require a second CAPTCHA-prone product request");
    }) as unknown as typeof fetch;
    const adapter = adapterFor("irecommend.ru", fetchMock);

    const refs = await adapter.discover("Оциллококцинум", { ...context, brands: ["Оциллококцинум"] });
    const observation = await adapter.collect(refs[0]!, context);

    expect(refs).toMatchObject([{ listingId: "2473", metadata: { reviewCount: 258, rating: 3.7 } }]);
    expect(observation).toMatchObject({ listingId: "2473", reviews: 258, rating: 3.7, status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("proves and excludes Otzyv.pro editorial advice pages without aborting product collection", async () => {
    const path = "/category/zdorove2/749425-cereton-otzyvy-pacientov.html";
    const adapter = adapterFor("otzyv.pro", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/") return new Response(`<article><h2>Церетон отзывы пациентов</h2><a href="${path}">Церетон отзывы пациентов</a></article>`);
      return new Response(`<html><head><title>ЦЕРЕТОН отзывы пациентов советы и инструкции 2026</title></head><body><h1>Церетон</h1></body></html>`);
    }) as typeof fetch);

    const [ref] = await adapter.discover("Церетон", context);
    await expect(adapter.collect(ref, context)).resolves.toMatchObject({
      listingId: "749425",
      status: "not_found",
      reviews: null,
      rating: null,
      source: "review_site_non_product_candidate"
    });
  });

  it.each([
    ["Церетон отзывы неврологов", "ЦЕРЕТОН ОТЗЫВЫ НЕВРОЛОГОВ отзывы врачей отрицательные и реальные"],
    ["Церетон инструкция по применению цена отзывы таблетки", "ЦЕРЕТОН ИНСТРУКЦИЯ ПО ПРИМЕНЕНИЮ ЦЕНА ОТЗЫВЫ ТАБЛЕТКИ"]
  ])("excludes Otzyv.pro single-review prose even when it exposes aggregate microdata: %s", async (subject, title) => {
    const slug = subject.includes("невролог") ? "cereton-otzyvy-nevrologov" : "cereton-instrukciya";
    const path = `/category/lekarstvennyie-sredstva/793897-${slug}.html`;
    const adapter = adapterFor("otzyv.pro", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/") return new Response(
        `<article><h2>${subject}</h2><a href="${path}">${subject}</a></article>`
      );
      return new Response(`<html><head><title>${title}</title></head><body>
        <a itemprop="name">Отзыв про</a>
        <span itemprop="name">${subject} - отзыв</span>
        <meta itemprop="itemReviewed" content="${subject}">
        <meta itemprop="ratingValue" content="5">
        <meta itemprop="reviewCount" content="1">
        <article itemprop="review"><p>Автор рассказывает об опыте лечения.</p></article>
      </body></html>`);
    }) as typeof fetch);

    const [ref] = await adapter.discover("Церетон", context);
    await expect(adapter.collect(ref, context)).resolves.toMatchObject({
      status: "not_found",
      reviews: null,
      rating: null,
      source: "review_site_non_product_candidate"
    });
  });

  it("keeps the Cereton Otzyv.pro capsule aggregate as a dedicated product-family proof", async () => {
    const path = "/category/lekarstvennyie-sredstva/753861-cereton-kapsuly.html";
    const adapter = adapterFor("otzyv.pro", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/") return new Response(
        `<article><h2>Церетон капсулы</h2><a href="${path}">Церетон капсулы</a></article>`
      );
      return new Response(`<html><body><h1 itemprop="name">Церетон капсулы - отзыв</h1>
        <meta itemprop="itemReviewed" content="Церетон капсулы">
        <meta itemprop="ratingValue" content="5"><meta itemprop="reviewCount" content="1">
      </body></html>`);
    }) as typeof fetch);

    const [ref] = await adapter.discover("Церетон", context);
    const result = await adapter.collect(ref, context);

    expect(result).toMatchObject({ listingId: "753861", reviews: 1, rating: 5, status: "ok" });
    expect(result.productEvidence).toMatchObject({
      scope: "product_family",
      variants: ["Церетон капсулы - отзыв"],
      identifiers: expect.arrayContaining([{ type: "product_id", value: "753861" }])
    });
    const productIdentity = analyzeProductIdentity({
      brand: result.brand, product: result.product, url: result.canonicalUrl, evidence: result.productEvidence
    });
    expect(hasDeterministicAggregateProof({ ...result, productIdentity })).toBe(true);
  });

  it("preserves a registered iRecommend id when the reader exposes an image id", async () => {
    const canonical = "https://irecommend.ru/content/lekarstvennyi-preparat-biosintez-khondrofen-maz-dlya-naruzhnogo-primeneniya";
    const adapter = adapterFor("irecommend.ru", (async () => new Response(`<html><body>
      <ul class="srch-result-nodes"><li><div class="ProductTizer" data-type="2" data-nid="577131">
        <div class="title"><a href="${canonical}">Лекарственный препарат Биосинтез Хондрофен мазь для наружного применения</a></div>
        <a class="read-all-reviews-link"><span class="counter">4</span></a><span class="reviewsLink">4 отзыва</span>
        <div class="fivestar-summary"><span class="average-rating"><span>4.8</span></span></div>
      </div></li></ul></body></html>`)) as typeof fetch);

    const refs = await adapter.discover("Хондрофен", {
      ...context,
      previousRefs: [{ listingId: "3232715", url: canonical }]
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "3232715", url: canonical });
  });

  it("collects a proven Baktoblis search aggregate without a second CAPTCHA-prone request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/srch") return new Response(`<html><body>
        <ul class="srch-result-nodes"><li><div class="ProductTizer" data-type="2" data-nid="399872">
          <div class="title"><a href="/content/respiratornyi-probiotik-bactoblis-baktoblis">Респираторный пробиотик Bactoblis Бактоблис</a></div>
          <a class="read-all-reviews-link"><span class="counter">33</span></a><span class="reviewsLink">33 отзыва</span>
          <div class="fivestar-summary"><span class="average-rating"><span>4.5</span></span></div>
        </div></li></ul></body></html>`);
      throw new Error("a complete source-bound ProductTizer must not request the product page");
    }) as unknown as typeof fetch;
    const adapter = adapterFor("irecommend.ru", fetchMock);

    const refs = await adapter.discover("Бактоблис", { ...context, brands: ["Бактоблис"] });
    const observation = await adapter.collect(refs[0]!, context);

    expect(refs).toMatchObject([{ listingId: "399872", metadata: { reviewCount: 33, rating: 4.5 } }]);
    expect(observation).toMatchObject({ listingId: "399872", reviews: 33, rating: 4.5, status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks iRecommend through its strict search route instead of the now-disallowed origin", async () => {
    const requested: URL[] = [];
    const adapter = adapterFor("irecommend.ru", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.pathname === "/") return new Response("origin must not be requested", { status: 400 });
      return new Response(`<ul class="srch-result-nodes"><li><div class="ProductTizer" data-type="2" data-nid="135637">
        <div class="title"><a href="/content/protivovirusnye-sredstva-kagotsel">Противовирусные средства Кагоцел</a></div>
        <a class="read-all-reviews-link"><span class="counter">430</span></a><span class="reviewsLink">430 отзывов</span>
        <div class="fivestar-summary"><span class="average-rating">Среднее: <span>3.9</span></span></div>
      </div></li></ul>`);
    }) as typeof fetch);

    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: true });
    expect(requested).toHaveLength(1);
    expect(requested[0].pathname).toBe("/srch");
    expect(requested[0].searchParams.get("query")).toBe("Кагоцел");
  });

  it("accepts a confirmed iRecommend vote count as feedback", async () => {
    const adapter = adapterFor("irecommend.ru", (async () => new Response(
      `<h1>Противовирусные средства Кагоцел — отзывы</h1>` +
      `<div class="fivestar-summary"><span class="average-rating"><span>3.9</span></span> (430 голосов)</div>`
    )) as typeof fetch);

    await expect(adapter.collect({
      domain: "irecommend.ru", platform: "irecommend.ru", listingId: "135637", brand: "Кагоцел",
      url: "https://irecommend.ru/content/protivovirusnye-sredstva-kagotsel", metadata: {}
    }, context)).resolves.toMatchObject({ reviews: null, ratingCount: 430, rating: 3.9, status: "ok" });
  });

  it("does not let discovery metrics rescue an iRecommend CAPTCHA product page", async () => {
    const adapter = adapterFor("irecommend.ru", (async () => new Response(
      `<html><head><title>Irecommend</title><script src="/captcha-checker/assets/script.js"></script></head>` +
      `<body class="in-maintenance db-offline"><div id="captcha-container"></div></body></html>`
    )) as typeof fetch);

    await expect(adapter.collect({
      domain: "irecommend.ru", platform: "irecommend.ru", listingId: "135637", brand: "Кагоцел",
      url: "https://irecommend.ru/content/protivovirusnye-sredstva-kagotsel",
      metadata: { reviewCount: 430, rating: 3.9 }
    }, context)).rejects.toMatchObject({ code: "blocked" });
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
    expect(results.every((item) => item.productEvidence?.variants.length === 1)).toBe(true);
    expect(results.every((item) => item.productEvidence?.identifiers.some((identifier) =>
      identifier.type === "product_id" && identifier.value === item.listingId
    ))).toBe(true);
    expect(results.every((item) => {
      const productIdentity = analyzeProductIdentity({
        brand: item.brand, product: item.product, url: item.canonicalUrl, evidence: item.productEvidence
      });
      return hasDeterministicAggregateProof({ ...item, productIdentity });
    })).toBe(true);
  });

  it("binds the three live Cereton Otzovik form aggregates without reading review prose", async () => {
    const fixtures = [
      ["kapsuli_soteks_cereton", "Капсулы Сотекс \"Церетон\" - отзывы", 72, 4.53],
      ["pitevoy_rastvor_soteks_cereton", "Питьевой раствор \"Сотекс\" Церетон - отзывы", 25, 4.86],
      ["rastvor_dlya_vnutrivennogo_i_vnutrimishechnogo_vvedeniya_soteks_cereton", "Раствор для внутривенного и внутримышечного введения Сотекс \"Церетон\" - отзывы", 17, 4]
    ] as const;
    const adapter = adapterFor("otzovik.com", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      const fixture = fixtures.find(([slug]) => url.pathname === `/reviews/${slug}/`);
      if (!fixture) throw new Error(`Unexpected URL ${url}`);
      const [, title, reviews, rating] = fixture;
      return new Response(`<main itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">${title}</h1>
        <span itemprop="aggregateRating"><meta itemprop="ratingValue" content="${rating}">
        <meta itemprop="reviewCount" content="${reviews}"><meta itemprop="bestRating" content="5"></span>
        <article itemprop="review"><p>В тексте упомянуты таблетки другого препарата №20.</p></article>
      </main>`);
    }) as typeof fetch);

    const results = await Promise.all(fixtures.map(([slug]) => adapter.collect({
      domain: "otzovik.com", platform: "otzovik.com", listingId: slug, brand: "Церетон",
      url: `https://otzovik.com/reviews/${slug}/`, metadata: { source: "external-search" }
    }, context)));

    expect(results.map((item) => [item.reviews, item.rating, item.status])).toEqual([
      [72, 4.5, "ok"], [25, 4.9, "ok"], [17, 4, "ok"]
    ]);
    expect(results.every((item) => item.productEvidence?.scope === "product_family")).toBe(true);
    expect(results.every((item) => item.productEvidence?.variants.length === 1)).toBe(true);
    expect(JSON.stringify(results.map((item) => item.productEvidence))).not.toContain("другого препарата");
    expect(results.every((item) => {
      const productIdentity = analyzeProductIdentity({
        brand: item.brand, product: item.product, url: item.canonicalUrl, evidence: item.productEvidence
      });
      return hasDeterministicAggregateProof({ ...item, productIdentity });
    })).toBe(true);
  });

  it("canonicalizes and deduplicates historical Otzovik product URLs before collection", async () => {
    const slug = "gomeopaticheskoe_sredstvo_ot_grippa_i_prostudnih_zabolevaniy_buaron_ocillokokcinum";
    const currentSlug = "gomeopaticheskiy_preparat_boiron_ocillokokcinum_zaschita_ot_virusov";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      expect(url.hostname).toBe("otzovik.com");
      if (url.pathname === "/__external_search__") return new Response(`
        <a class="result__a" href="https://otzovik.com/reviews/${currentSlug}/">Отзывы о препарате Оциллококцинум защита от вирусов</a>
      `);
      if (url.pathname === `/reviews/${slug}/`) return new Response(
        `<h1 itemprop="name">Гомеопатический препарат Буарон «Оциллококцинум»</h1>` +
        `<span itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.0">` +
        `<meta itemprop="reviewCount" content="394"><meta itemprop="bestRating" content="5"></span>`
      );
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("otzovik.com", fetchMock);

    const refs = await adapter.discover("Оциллококцинум", {
      region: "Москва",
      previousRefs: [{
        listingId: "historical-id",
        url: `https://www.otzovik.com/reviews/${slug}/?sort=negative#reviews`
      }, {
        listingId: "duplicate-id",
        url: `https://otzovik.com/reviews/${slug}/`
      }]
    });
    const historical = refs.find((ref) => ref.listingId === "historical-id");
    if (!historical) throw new Error("Missing canonical historical ref");
    const result = await adapter.collect(historical, context);

    expect(refs).toHaveLength(2);
    expect(historical.url).toBe(`https://otzovik.com/reviews/${slug}/`);
    expect(result).toMatchObject({ reviews: 394, rating: 4, status: "ok" });
  }, 10_000);

  it.each(["Тикализис", "Даксабрис"])("accepts an explicit external-search zero as proved no_results for Otzovik: %s", async (brand) => {
    const fetchMock = (async () => new Response(
      `<main><h1>No results found for <strong>site:otzovik.com/reviews/ &quot;${brand}&quot;</strong></h1></main>`
    )) as typeof fetch;
    const adapter = adapterFor("otzovik.com", fetchMock);

    await expect(adapter.discover(brand, context)).resolves.toEqual([]);
  });

  it("classifies the live Otzovik captcha form as blocked instead of parser_changed", async () => {
    const adapter = adapterFor("otzovik.com", (async () => new Response(
      `<html><head><title>Кагоцел — не робот</title></head><body>` +
      `<form class="captcha-form popup-box"><input type="hidden" name="captcha_url" value="/reviews/protivovirusniy_preparat_kagocel/">` +
      `<h1>Не робот?</h1><div class="captcha"><img id="captcha-img" src="/scripts/captcha/index.php"></div></form>` +
      `</body></html>`
    )) as typeof fetch);

    await expect(adapter.collect({
      domain: "otzovik.com", platform: "otzovik.com", listingId: "kagocel", brand: "Кагоцел",
      url: "https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/", metadata: {}
    }, context)).rejects.toMatchObject({ code: "blocked", message: expect.stringContaining("защитную страницу") });
  });

  it("does not mistake an optional captcha widget for a block when aggregate metrics are present", async () => {
    const adapter = adapterFor("otzovik.com", (async () => new Response(
      `<html><head><title>Отзывы о Кагоцел</title></head><body>` +
      `<h1 itemprop="name">Противовирусный препарат Кагоцел</h1>` +
      `<meta itemprop="ratingValue" content="4.86"><meta itemprop="reviewCount" content="37">` +
      `<form class="captcha-form"><img id="captcha-img" src="/scripts/captcha/index.php"></form>` +
      `</body></html>`
    )) as typeof fetch);

    await expect(adapter.collect({
      domain: "otzovik.com", platform: "otzovik.com", listingId: "kagocel", brand: "Кагоцел",
      url: "https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/", metadata: {}
    }, context)).resolves.toMatchObject({ reviews: 37, rating: 4.9, status: "ok" });
  });

  it.each([404, 410])("marks an exact retired Otzovik product as a removable search candidate: HTTP %s", async (status) => {
    const adapter = adapterFor("otzovik.com", (async () => new Response("retired", { status })) as typeof fetch);

    await expect(adapter.collect({
      domain: "otzovik.com", platform: "otzovik.com", listingId: "retired", brand: "Оциллококцинум",
      url: "https://otzovik.com/reviews/gomeopaticheskiy_preparat_laboratoriya_popovih_ocillokokcinum/", metadata: {}
    }, context)).resolves.toMatchObject({
      status: "not_found", reviews: null, rating: null, source: "otzovik_missing_candidate"
    });
  });

  it("health-checks Otzovik on a proven aggregate card instead of the protected homepage", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      expect(url.pathname).toBe("/reviews/protivovirusniy_preparat_kagocel/");
      return new Response(
        `<h1 itemprop="name">Противовирусный препарат Кагоцел</h1>` +
        `<span itemprop="aggregateRating"><meta itemprop="ratingValue" content="3.91">` +
        `<meta itemprop="reviewCount" content="578"><meta itemprop="bestRating" content="5"></span>`
      );
    }) as unknown as typeof fetch;
    const adapter = adapterFor("otzovik.com", fetchMock);

    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("health-checks and discovers the live ru.otzyv.com ts slug without touching its protected homepage", async () => {
    const requested: string[] = [];
    const productHtml = `<h1>Кагоцел отзывы</h1><script type="application/ld+json">` +
      `{"@type":"Product","name":"Кагоцел","aggregateRating":{"@type":"AggregateRating",` +
      `"ratingValue":5,"reviewCount":390,"ratingCount":390,"bestRating":5}}</script>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/kagocel") return new Response("missing", { status: 404 });
      if (url.pathname === "/kagotsel") return new Response(productHtml);
      return new Response("protected homepage", { status: 403 });
    }) as unknown as typeof fetch;
    const adapter = adapterFor("ru.otzyv.com", fetchMock);

    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: true });
    const refs = await adapter.discover("Кагоцел", context);
    const result = await adapter.collect(refs[0], context);

    expect(requested).toEqual(["/kagotsel", "/kagocel", "/kagotsel", "/kagotsel"]);
    expect(refs).toMatchObject([{ listingId: "kagotsel", url: "https://ru.otzyv.com/kagotsel" }]);
    expect(result).toMatchObject({ listingId: "kagotsel", reviews: 390, rating: 5, status: "ok" });
    expect(requested).not.toContain("/");
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

  it("collects the live Pravogolosa category summary instead of counting individual search hits", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.searchParams.get("page") === "search") return new Response(`
        <h3>По вашему запросу &laquo;Кагоцел&raquo; всего найдено отзывов: 23</h3>
        <div class="module">
          <h2><a href="/otzyvcategory?page=show_ad&amp;adid=289924&amp;catid=76968">Противовирусный препарат Кагоцел отзывы</a></h2>
          <a href="/otzyvcategory?page=show_category&amp;catid=76968&amp;order=0&amp;expand=0">Читать все отзывы (23)</a>
        </div>
      `);
      if (url.searchParams.get("page") === "show_category") return new Response(`
        <h1 class="contentheading">Противовирусный препарат Кагоцел отзывы</h1>
        <span title="Рейтинг::Оценка объекта отзыва 5 из 5."></span>
        <a href="/otzyvcategory?page=show_category&amp;catid=76968&amp;order=0&amp;expand=0">все отзывы 23</a>
        <a href="/otzyvcategory?page=show_category&amp;catid=76968&amp;order=0&amp;expand=0&amp;ad_tipre=Положительный">положительных 22</a>
        нейтральных 0
        <a href="/otzyvcategory?page=show_category&amp;catid=76968&amp;order=0&amp;expand=0&amp;ad_tipre=Негативный">негативных 1</a>
      `);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = adapterFor("pravogolosa.net", fetchMock);

    const refs = await adapter.discover("Кагоцел", context);
    const result = await adapter.collect(refs[0], context);

    expect(refs).toMatchObject([{
      listingId: "76968",
      metadata: { source: "pravogolosa-search-category", reviewCount: 23 }
    }]);
    expect(result).toMatchObject({
      listingId: "76968",
      product: "Противовирусный препарат Кагоцел отзывы",
      reviews: 23,
      rating: 5,
      ratingCount: 23,
      status: "ok"
    });
  });

  it("treats a Pravogolosa manufacturer aggregate surfaced by a brand mention as no results", async () => {
    const requested: URL[] = [];
    const adapter = adapterFor("pravogolosa.net", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.searchParams.get("page") === "search") return new Response(`
        <h3>По вашему запросу «Оциллококцинум» всего найдено отзывов: 4</h3>
        <div class="module">
          <h2><a href="/otzyvcategory?page=show_ad&amp;adid=1&amp;catid=41247">Отзыв об ООО «Буарон»</a></h2>
          <p>Покупатель упоминает Оциллококцинум в отзыве о производителе.</p>
          <a href="/otzyvcategory?page=show_category&amp;catid=41247&amp;order=0&amp;expand=0">Читать все отзывы (4)</a>
        </div>
      `);
      if (url.searchParams.get("page") === "show_category") return new Response(`
        <h1 class="contentheading">ООО «Буарон» отзывы</h1>
        <span title="Рейтинг::Оценка объекта отзыва 4.5 из 5."></span>
        <a href="/otzyvcategory?page=show_category&amp;catid=41247&amp;order=0&amp;expand=0">все отзывы 4</a>
      `);
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch);
    await expect(adapter.discover("Оциллококцинум", context)).resolves.toEqual([]);
    expect(requested.map((url) => url.searchParams.get("page"))).toEqual(["search", "show_category"]);
    expect(requested[1].searchParams.get("catid")).toBe("41247");
  });

  it("checks the Pravogolosa search contract instead of blocking on an unrelated origin canary", async () => {
    const requested: URL[] = [];
    const adapter = adapterFor("pravogolosa.net", (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url);
      if (url.pathname === "/") return new Response("origin blocked", { status: 403 });
      return new Response(
        `<h3>По вашему запросу &laquo;ratingscollector-healthcheck-7f4c2a&raquo; всего найдено отзывов: 0</h3>`
      );
    }) as typeof fetch);

    await expect(adapter.healthCheck(context)).resolves.toMatchObject({
      ok: true,
      message: "pravogolosa.net search returned an explicit no-results proof"
    });
    expect(requested).toHaveLength(1);
    expect(requested[0].pathname).toBe("/otzyvcategory");
    expect(requested[0].searchParams.get("page")).toBe("search");
  });

  it("keeps an unproven Pravogolosa search canary fail-closed", async () => {
    const adapter = adapterFor("pravogolosa.net", (async () =>
      new Response("temporary protection page", { status: 403 })) as typeof fetch);

    const health = await adapter.healthCheck(context);

    expect(health.ok).toBe(false);
    expect(health.message).toContain("HTTP 403");
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

  it.each(UNPROVEN_AGGREGATE_DOMAINS)("keeps %s separate from access blocks and no_results", async (domain) => {
    const adapter = new UnprovenAggregateAdapter(domain);
    const health = await adapter.healthCheck(context);
    expect(health).toMatchObject({ ok: false });
    expect(health.message).toContain("unsupported_aggregate");
    expect(health.message).toContain("no_results не выводится");
    expect(health.message).not.toContain("blocked_free_mode");
    await expect(adapter.discover()).rejects.toMatchObject({ code: "parser_changed" });
  });

  it("registers direct review adapters plus the remaining Medum access guardrail", () => {
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
