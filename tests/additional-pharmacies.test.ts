import { describe, expect, it, vi } from "vitest";
import {
  AptekaAprilAdapter,
  AptekaRuAdapter,
  BudZdorovAdapter,
  EtablAdapter,
  NfAptekaAdapter
} from "../src/server/adapters/additional-pharmacies.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const context = { region: "Москва", runId: "pharmacy-test" };

function translated(source: string, body: string) {
  return `<!doctype html><html><head><base href="${source}"><script data-source-url="${source}"></script></head><body>${body}</body></html>`;
}

describe("additional pharmacy adapters", () => {
  it("collects exact Apteka.ru variants from Product JSON-LD and keeps ratingCount separate", async () => {
    const id = "5e3268eaca7bdc000192d316";
    const productUrl = `https://apteka.ru/product/oczillokokczinum-30-sht-granuly-${id}/`;
    const preparationUrl = "https://apteka.ru/preparation/otsillokoktsinum/";
    const preparation = `<!doctype html><html><head><base href="${preparationUrl}"></head><body><main><h1>Оциллококцинум</h1><article class="product"><a href="${productUrl}" aria-label="Оциллококцинум 30 шт. гранулы">Оциллококцинум 30 шт. гранулы</a></article></main></body></html>`;
    const product = `<!doctype html><html><head><base href="${productUrl}"><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", sku: id,
      name: "Оциллококцинум 30 шт. гранулы",
      aggregateRating: { "@type": "AggregateRating", reviewCount: 44, ratingCount: 57, ratingValue: 4.9 }
    })}</script></head><body><h1>Оциллококцинум 30 шт. гранулы</h1></body></html>`;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(url.pathname.startsWith("/preparation/") ? preparation : product, {
        status: 200, headers: { "content-type": "text/html" }
      });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: id, title: "Оциллококцинум 30 шт. гранулы" });
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      reviews: 57,
      writtenReviewCount: 44,
      ratingCount: 57,
      rating: 4.9,
      status: "ok"
    });
    expect(fetchSpy.mock.calls.every(([input]) => new URL(String(input)).hostname === "apteka-ru.translate.goog")).toBe(true);
  });

  it("fails closed when Apteka.ru Product JSON-LD loses its feedback aggregate", async () => {
    const id = "5e3268eaca7bdc000192d316";
    const productUrl = `https://apteka.ru/product/oczillokokczinum-30-sht-granuly-${id}/`;
    const html = `<!doctype html><head><base href="${productUrl}"></head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", sku: id, name: "Оциллококцинум 30 шт. гранулы"
    })}</script><h1>Оциллококцинум</h1>`;
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(html, {
      status: 200, headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "apteka.ru", platform: "apteka.ru", listingId: id, brand: "Оциллококцинум",
      url: productUrl, metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("discovers NFapteka by exact first-party search and reads product microdata", async () => {
    const path = "/tambov/catalog/prostuda/otsillokoktsinum-gran-gomeopat-1-doza-1-g-12.html";
    const searchSource = "https://nfapteka.ru/catalog/?q=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC";
    const productSource = `https://nfapteka.ru${path}`;
    const search = translated(searchSource, `<main><h1>Результаты поиска по запросу Оциллококцинум</h1><div class="productOuter"><a href="https://nfapteka-ru.translate.goog${path}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en"><img src="image.jpg"></a><div class="productName"><a href="https://nfapteka-ru.translate.goog${path}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Оциллококцинум гранулы 1 г №12</a></div><a data-id="97307"></a></div></main>`);
    const product = translated(productSource, `<link rel="canonical" href="${productSource}"><h1>Оциллококцинум гранулы 1 г №12</h1><input name="productId" value="97307"><div itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.3"><span itemprop="reviewCount">3</span></div>`);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(url.pathname === "/catalog/" ? search : product, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const adapter = new NfAptekaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "97307", url: productSource });
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({ reviews: 3, rating: 4.3, status: "ok" });
  });

  it("uses complete Bud Zdorov reviews and their scores instead of a partial visible list", async () => {
    const formSource = "https://www.budzdorov.ru/forms/ocillokokcinum";
    const productPath = "/product/otsillokoktsinum-granuly-6doz-2511";
    const productSource = `https://www.budzdorov.ru${productPath}`;
    const form = translated(formSource, `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" title="Оциллококцинум гранулы 6 доз">Оциллококцинум гранулы 6 доз</a></main>`);
    const reviews = [
      { id: 1, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 2, ratings: [{ attribute_code: "Оценка", value: 4 }] },
      { id: 3, ratings: [{ attribute_code: "Оценка", value: 5 }] }
    ];
    const product = translated(productSource, `<h1>Оциллококцинум гранулы 6 доз</h1><div allreviewsqty="3"></div><script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews } })};document.currentScript.remove()</script>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(url.pathname.startsWith("/forms/") ? form : product, { status: 200, headers: { "content-type": "text/html" } });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "2511", url: productSource });
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe("/forms/ocillokokcinum");
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({ reviews: 3, rating: 4.7, status: "ok" });
    expect(new URL(String(fetchSpy.mock.calls[1][0])).pathname).toBe(productPath);
  });

  it("collects eTabl product state and drops its default rating when there are no reviews", async () => {
    const searchSource = "https://etabl.ru/search?query=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC&limit=100";
    const productSource = "https://etabl.ru/product/otsillokoktsinum=187122000610";
    const item = {
      id: "187122000610", name: "ОЦИЛЛОКОКЦИНУМ", url: "otsillokoktsinum=187122000610",
      subtitleFull: "гранулы гомеопатические N12", reviewsStats: { rating: 5, reviewsCount: 0 }
    };
    const statePage = (source: string, state: object) => translated(source, `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};document.currentScript.remove()</script>`);
    const search = statePage(searchSource, { search: { searchResultNew: [item], searchResultCount: 1 } });
    const product = statePage(productSource, { products: { product: item } });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(url.pathname === "/search" ? search : product, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const adapter = new EtablAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      reviews: 0, rating: null, status: "no_reviews", product: "ОЦИЛЛОКОКЦИНУМ гранулы гомеопатические N12"
    });
  });

  it("keeps Apteka April as an explicit access block, never an empty result", async () => {
    const adapter = new AptekaAprilAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response("Forbidden", {
      status: 403, headers: { "content-type": "text/plain" }
    })) as unknown as typeof fetch);

    await expect(adapter.discover("Оциллококцинум", context)).rejects.toBeInstanceOf(AdapterBlockedError);
    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: false });
  });
});
