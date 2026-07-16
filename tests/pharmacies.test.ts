import { describe, expect, it, vi } from "vitest";
import {
  FarmlendAdapter,
  OkaptekaAdapter,
  RiglaAdapter,
  ZdravcityAdapter
} from "../src/server/adapters/pharmacies.js";
import { ParserChangedError } from "../src/server/adapters/errors.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const context = { runId: "run-pharmacies", region: "Москва" };

function requestedUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

const fixtures = {
  okGroup: `<!doctype html><html><head><base href="https://okapteka.ru/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/"></head><body>
    <article class="product"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-30-529011/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел таблетки 12мг №30</a></article>
    <article class="product"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-20-529012/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел таблетки 12мг №20</a></article>
    <article class="product"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-10-30687/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел таблетки 12мг №10</a></article>
  </body></html>`,
  okReviews: `<!doctype html><html><head><base href="https://okapteka.ru/reviews/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/"></head><body>
    <div itemprop="review" data-id="2678"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-20-529012/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел №20</a><meta itemprop="ratingValue" content="5"></div>
    <div itemprop="review" data-id="2591"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-10-30687/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел №10</a><meta itemprop="ratingValue" content="4"></div>
    <div itemprop="review" data-id="2509"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-10-30687/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел №10</a><meta itemprop="ratingValue" content="5"></div>
    <div itemprop="review" data-id="2510"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-10-30687/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел №10</a><meta itemprop="ratingValue" content="4"></div>
  </body></html>`,
  riglaForms: `<!doctype html><html><body>
    <article class="product"><a href="/product/kagotsel-tab-12mg-no10-15027">Кагоцел таблетки 0,012г №10</a></article>
    <article class="product"><a href="/product/kagotsel-tab-12mg-no20-106662">Кагоцел таблетки 12мг №20</a></article>
  </body></html>`,
  riglaProduct: `<!doctype html><html><head><link rel="canonical" href="https://www.rigla.ru/product/kagotsel-tab-12mg-no10-15027"></head><body>
    <h1>Кагоцел таблетки 0,012г №10</h1>
    <script>window.__INITIAL_STATE__={"productView":{"reviews":[{"id":11,"ratings":[{"attribute_code":"Оценка","value":5}]},{"id":12,"ratings":[{"attribute_code":"Оценка","value":4}]},{"id":13,"ratings":[{"attribute_code":"Оценка","value":4}]}]}};(function(){})()</script>
  </body></html>`,
  zdravGroup: `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { products: [{
      id: "6CE96B93-3DAD-39C8-EE05-3E30A030A486",
      url: "/p_kagocel-tab-12mg-n20-0093573.html",
      name: "Кагоцел таблетки 12мг 20шт",
      brand: { name: "КАГОЦЕЛ" },
      sku: "228330"
    }] } }
  })}</script></body></html>`,
  zdravProduct: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": ["Product", "Drug"],
    name: "Кагоцел таблетки 12мг 20шт",
    aggregateRating: { "@type": "AggregateRating", ratingValue: 5, reviewCount: 21 }
  })}</script><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Другой препарат 30 шт",
    sku: "other-sku",
    aggregateRating: { "@type": "AggregateRating", ratingValue: 5, reviewCount: 999 }
  })}</script></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { productV2: {
      id: "6CE96B93-3DAD-39C8-EE05-3E30A030A486",
      attributes: { name: "Кагоцел таблетки 12мг 20шт", url: "/p_kagocel-tab-12mg-n20-0093573.html", rating: 5, sku: "228330" },
      reviews: [{ ID: "8648", rate: 5 }, { ID: "8647", rate: 5 }]
    } } }
  })}</script></body></html>`,
  farmlendSearch: `<!doctype html><html><head><base href="https://farmlend.ru/search?keyword=%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB"></head><body>
    <article class="product"><a href="https://farmlend-ru.translate.goog/ufa/product/400001?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">Кагоцел таблетки 12мг №20</a></article>
  </body></html>`,
  farmlendProduct: `<!doctype html><html><head>
    <base href="https://farmlend.ru/ufa/product/400001">
    <link rel="canonical" href="https://farmlend.ru/ufa/product/400001">
  </head><body><h1>Кагоцел таблетки 12мг №20</h1><section>Общий рейтинг 4,5 на основе 2 отзывов покупателей</section></body></html>`
};

describe("OkaptekaAdapter", () => {
  it("discovers every brand variant and derives written-review totals per product", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      return new Response(url.pathname.startsWith("/pg/") ? fixtures.okGroup : fixtures.okReviews, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new OkaptekaAdapter(new MemoryEvidenceStore(), fetchMock);
    const refs = await adapter.discover("Кагоцел", context);
    expect(refs.map((item) => item.listingId).sort()).toEqual(["30687", "529011", "529012"]);

    const ten = await adapter.collect(refs.find((item) => item.listingId === "30687")!, context);
    const twenty = await adapter.collect(refs.find((item) => item.listingId === "529012")!, context);
    const thirty = await adapter.collect(refs.find((item) => item.listingId === "529011")!, context);
    expect(ten).toMatchObject({ reviews: 3, rating: 4.33, ratingCount: 3, status: "ok" });
    expect(twenty).toMatchObject({ reviews: 1, rating: 5, ratingCount: 1, status: "ok" });
    expect(thirty).toMatchObject({ reviews: 0, rating: null, ratingCount: 0, status: "no_reviews" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an empty review page has no explicit no-reviews proof", async () => {
    const ambiguous = `<!doctype html><html><head><base href="https://okapteka.ru/reviews/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/"></head><body><main>Отзывы</main></body></html>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      return new Response(url.pathname.startsWith("/pg/") ? fixtures.okGroup : ambiguous, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new OkaptekaAdapter(new MemoryEvidenceStore(), fetchMock);
    const refs = await adapter.discover("Кагоцел", context);

    await expect(adapter.collect(refs[0], context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("accepts the exact empty brand-review wrapper as zero feedback", async () => {
    const group = `<!doctype html><html><head><base href="https://okapteka.ru/pg/%D0%A5%D0%BE%D0%BD%D0%B4%D1%80%D0%BE%D1%84%D0%B5%D0%BD/"></head><body>
      <article class="product"><a href="https://okapteka.ru/khondrofen-maz-30g-143645/">Хондрофен мазь 30 г</a></article></body></html>`;
    const reviews = `<!doctype html><html><head><base href="https://okapteka.ru/reviews/%D0%A5%D0%BE%D0%BD%D0%B4%D1%80%D0%BE%D1%84%D0%B5%D0%BD/"></head><body>
      <div class="s-reviews-wrapper"><a name="reviewheader"></a><h1>Отзывы на <a href="https://okapteka.ru/pg/%D0%A5%D0%BE%D0%BD%D0%B4%D1%80%D0%BE%D1%84%D0%B5%D0%BD/">Хондрофен</a></h1></div></body></html>`;
    const adapter = new OkaptekaAdapter(new MemoryEvidenceStore(), vi.fn(async (input: RequestInfo | URL) =>
      new Response(new URL(String(input)).pathname.startsWith("/pg/") ? group : reviews)
    ) as unknown as typeof fetch);

    const refs = await adapter.discover("Хондрофен", context);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
  });
});

describe("RiglaAdapter", () => {
  it("uses the public forms page for discovery and complete SSR review objects for metrics", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      return new Response(url.pathname.startsWith("/forms/") ? fixtures.riglaForms : fixtures.riglaProduct, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new RiglaAdapter(new MemoryEvidenceStore(), fetchMock);
    const refs = await adapter.discover("Кагоцел", context);
    expect(refs.map((item) => item.listingId)).toEqual(["15027", "106662"]);
    const observation = await adapter.collect(refs[0], context);
    expect(observation).toMatchObject({ reviews: 3, rating: 4.33, ratingCount: 3, status: "ok" });
  });

  it("checks the requested Rigla brand instead of an unrelated fixed canary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      expect(url.pathname).toBe("/forms/tsereton");
      return new Response(fixtures.riglaForms.replaceAll("Кагоцел", "Церетон"), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(new RiglaAdapter(new MemoryEvidenceStore(), fetchMock).healthCheck({
      ...context, brands: ["Церетон"]
    })).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when a written review has no single product rating", async () => {
    const malformed = fixtures.riglaProduct.replace('"ratings":[{"attribute_code":"Оценка","value":4}]', '"ratings":[]');
    const adapter = new RiglaAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(malformed)) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "rigla.ru", platform: "rigla.ru", listingId: "15027", brand: "Кагоцел",
      url: "https://www.rigla.ru/product/kagotsel-tab-12mg-no10-15027", metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });
});

describe("ZdravcityAdapter", () => {
  it("keeps the stable UUID and separates visible written reviews from the structured counter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      return new Response(url.pathname.startsWith("/g_") ? fixtures.zdravGroup : fixtures.zdravProduct, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new ZdravcityAdapter(new MemoryEvidenceStore(), fetchMock);
    const refs = await adapter.discover("Кагоцел", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "6CE96B93-3DAD-39C8-EE05-3E30A030A486" });
    const observation = await adapter.collect(refs[0], context);
    expect(observation).toMatchObject({ reviews: 2, rating: 5, ratingCount: 21, status: "ok" });
  });
});

describe("FarmlendAdapter", () => {
  it("uses the fixed Translate SSR path and publishes only the proved visible aggregate", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      return new Response(url.pathname === "/search" ? fixtures.farmlendSearch : fixtures.farmlendProduct, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new FarmlendAdapter(new MemoryEvidenceStore(), fetchMock);
    const refs = await adapter.discover("Кагоцел", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "400001", url: "https://farmlend.ru/ufa/product/400001" });
    const observation = await adapter.collect(refs[0], context);
    expect(observation).toMatchObject({ reviews: 2, rating: 4.5, ratingCount: 2, status: "ok" });
  });
});
