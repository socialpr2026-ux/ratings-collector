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

function aptekaSelectedVariant(url: string, title: string, count: number, rating: number) {
  return `<div class="variantButton" aria-selected="true"><a class="variantButton__link" href="${url}" aria-label="${title}"></a>` +
    `<div class="variantButton__rating"><div class="ItemRating"><span class="ItemRating__label">${rating}</span>` +
    `<span class="caption3">(<span>${count}</span> reviews)</span></div></div></div>`;
}

function nfReviewList(title: string, ratings: number[]) {
  return `<div id="review">${ratings.map((rating) =>
    `<div class="testimonial" itemscope itemtype="https://schema.org/Review"><meta itemprop="itemReviewed" content="${title}">` +
    `<div itemprop="reviewRating" itemscope itemtype="https://schema.org/Rating"><meta itemprop="ratingValue" content="${rating}"></div></div>`
  ).join("")}</div>`;
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
    })}</script></head><body><h1>Оциллококцинум 30 шт. гранулы</h1>${aptekaSelectedVariant(productUrl, "Оциллококцинум 30 шт. гранулы", 57, 4.9)}</body></html>`;
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
    expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).hostname)).toEqual([
      "apteka.ru",
      "apteka-ru.translate.goog"
    ]);
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

  it("rejects Apteka.ru stale or cross-variant AggregateRating without selected-product proof", async () => {
    const id = "5e3268eaca7bdc000192d316";
    const productUrl = `https://apteka.ru/product/oczillokokczinum-30-sht-granuly-${id}/`;
    const title = "Оциллококцинум 30 шт. гранулы";
    const html = `<!doctype html><head><base href="${productUrl}"></head><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", sku: id, name: title, aggregateRating: { reviewCount: 2, ratingValue: 5 }
    })}</script><h1>${title}</h1>${aptekaSelectedVariant("https://apteka.ru/product/analog-aaaaaaaaaaaaaaaaaaaaaaaa/", "Аналог", 2, 5)}`;
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(html)) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "apteka.ru", platform: "apteka.ru", listingId: id, brand: "Оциллококцинум", url: productUrl, metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("checks Apteka.ru health against a stable exact Product instead of brand discovery spelling", async () => {
    const id = "5e3268eaca7bdc000192d316";
    const canaryUrl = `https://apteka.ru/product/oczillokokczinum-30-sht-granuly-${id}/`;
    const canary = `<!doctype html><html><head><base href="${canaryUrl}"><link rel="canonical" href="${canaryUrl}"><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", sku: id, name: "Оциллококцинум 30 шт. гранулы"
    })}</script></head><body></body></html>`;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://apteka-ru.translate.goog/product/oczillokokczinum-30-sht-granuly-5e3268eaca7bdc000192d316/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en");
      return new Response(canary, { headers: { "content-type": "text/html" } });
    });
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("discovers Хондрофен through the filtered sitemap when optional Agent gateway preparation routes fail", async () => {
    const id = "630e04ccbb7256f6b07f621f";
    const productUrl = `https://apteka.ru/product/xondrofen-maz-dlya-naruzhnogo-primeneniya-30-gr-${id}/`;
    const product = `<!doctype html><html><head><base href="${productUrl}"><link rel="canonical" href="${productUrl}"><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", sku: id, name: "Хондрофен мазь для наружного применения 30 гр",
      aggregateRating: { reviewCount: 157, ratingValue: 4.7 }
    })}</script></head><body>${aptekaSelectedVariant(productUrl, "Хондрофен мазь для наружного применения 30 гр", 157, 4.7)}</body></html>`;
    const preparationStatuses = new Map([
      ["/preparation/hondrofen/", 502],
      ["/preparation/khondrofen/", 503],
      ["/preparation/xondrofen/", 404]
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/preparation/")) {
        if (url.pathname === "/preparation/khondrofen/") throw new TypeError("upstream connection reset");
        return new Response("optional preparation gateway unavailable", { status: preparationStatuses.get(url.pathname) ?? 502 });
      }
      if (url.pathname === "/sitemap-product.xml") {
        expect(url.searchParams.get("slugs")?.split(",")).toEqual(expect.arrayContaining(["hondrofen", "khondrofen", "xondrofen"]));
        return new Response(`<urlset><url><loc>${productUrl}</loc></url></urlset>`, { headers: { "content-type": "application/xml" } });
      }
      return new Response(product, { headers: { "content-type": "text/html" } });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Хондрофен", context);
    expect(refs).toMatchObject([{ listingId: id, url: productUrl }]);
    expect(fetchSpy.mock.calls.some(([input]) => new URL(String(input)).pathname === "/sitemap-product.xml")).toBe(true);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({ reviews: 157, rating: 4.7, status: "ok" });
  });

  it("discovers NFapteka by exact first-party search and reads product microdata", async () => {
    const path = "/tambov/catalog/prostuda/otsillokoktsinum-gran-gomeopat-1-doza-1-g-12.html";
    const searchSource = "https://nfapteka.ru/catalog/?q=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC";
    const productSource = `https://nfapteka.ru${path}`;
    const search = translated(searchSource, `<main><h1>Результаты поиска по запросу Оциллококцинум</h1><div class="productOuter"><a href="https://nfapteka-ru.translate.goog${path}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en"><img src="image.jpg"></a><div class="productName"><a href="https://nfapteka-ru.translate.goog${path}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Оциллококцинум гранулы 1 г №12</a></div><a data-id="97307"></a></div></main>`);
    const title = "Оциллококцинум гранулы 1 г №12";
    const product = translated(productSource, `<link rel="canonical" href="${productSource}"><h1>${title}</h1><input name="productId" value="97307"><div itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.3"><span itemprop="reviewCount">3</span></div>${nfReviewList(title, [4.3, 4.3, 4.3])}`);
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

  it("accepts an integer-rounded NFapteka aggregate only when the exact review list proves it", async () => {
    const brand = "\u041a\u0430\u0433\u043e\u0446\u0435\u043b";
    const title = `${brand} \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 No10 12 \u043c\u0433 \u0432 \u0422\u0430\u043c\u0431\u043e\u0432\u0435`;
    const reviewedTitle = `${brand} \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 \u211610 12 \u043c\u0433`;
    const path = "/tambov/catalog/zabolevaniya/prostuda-i-gripp/profilaktika-orvi-i-grippa/kagotsel-tab-12-mg-10.html";
    const productSource = `https://nfapteka.ru${path}`;
    const page = (aggregateRating: number, itemReviewed = reviewedTitle) => translated(productSource,
      `<link rel="canonical" href="${productSource}"><h1>${title}</h1><input name="productId" value="108514">` +
      `<div itemprop="aggregateRating"><meta itemprop="ratingValue" content="${aggregateRating}">` +
      `<span itemprop="reviewCount">3</span></div>${nfReviewList(itemReviewed, [4, 5, 5])}`);
    const ref = {
      domain: "nfapteka.ru", platform: "nfapteka.ru", listingId: "108514", brand,
      url: productSource, metadata: {}
    };

    const adapter = new NfAptekaAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(page(5), { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    await expect(adapter.collect(ref, context)).resolves.toMatchObject({
      reviews: 3,
      rating: 5,
      rawRating: 5,
      rawRatingScale: 5,
      status: "ok"
    });

    const mismatched = new NfAptekaAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(page(4), { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    await expect(mismatched.collect(ref, context)).rejects.toBeInstanceOf(ParserChangedError);

    const anotherVariant = `${brand} \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 \u211620 12 \u043c\u0433`;
    const wrongProduct = new NfAptekaAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(page(5, anotherVariant), { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    await expect(wrongProduct.collect(ref, context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("accepts only the exact empty NFapteka product review section as zero feedback", async () => {
    const path = "/tambov/catalog/lekarstva/khondrofen-maz-30-g.html";
    const productSource = `https://nfapteka.ru${path}`;
    const product = translated(productSource, `<link rel="canonical" href="${productSource}"><h1>Хондрофен мазь 30 г</h1>
      <input name="productId" value="127010"><div id="review"><h2>Отзывы хондрофен</h2>
      <div class="uk-text-left"><a href="${productSource}#testimonialModal">Оставить отзыв</a></div></div>`);
    const adapter = new NfAptekaAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(product, {
      headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch);

    await expect(adapter.collect({
      domain: "nfapteka.ru", platform: "nfapteka.ru", listingId: "127010", brand: "Хондрофен",
      url: productSource, metadata: {}
    }, context)).resolves.toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });

    const ambiguous = product.replace("<h2>Отзывы хондрофен</h2>", "<h2>Отзывы хондрофен</h2><div class=\"loading\"></div>");
    const blocked = new NfAptekaAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(ambiguous)) as unknown as typeof fetch);
    await expect(blocked.collect({
      domain: "nfapteka.ru", platform: "nfapteka.ru", listingId: "127010", brand: "Хондрофен",
      url: productSource, metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
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

  it("falls back to the translated letter index when the brand form was removed", async () => {
    const formSource = "https://www.budzdorov.ru/forms/baktoblis";
    const letterSource = "https://www.budzdorov.ru/letter/%D0%91";
    const productPath = "/product/baktoblis-tab-dlya-rassasyv-30g-no30-109834";
    const letter = translated(letterSource, `<main class="alphabet-forms">
      <a class="alphabet-forms__item-link" href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">
        <span>Бактоблис таблетки для рассасывания 30г №30</span>
      </a></main>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/forms/baktoblis") return new Response("missing", { status: 404 });
      expect(url.pathname).toBe("/letter/%D0%91");
      return new Response(letter, { status: 200, headers: { "content-type": "text/html" } });
    });

    await expect(new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch)
      .discover("Бактоблис", context)).resolves.toMatchObject([
      { listingId: "109834", url: `https://www.budzdorov.ru${productPath}` }
    ]);
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe(new URL(formSource).pathname);
  });

  it("checks the requested Bud Zdorov brand and reuses its successful discovery in the same run", async () => {
    const brand = "\u041a\u0430\u0433\u043e\u0446\u0435\u043b";
    const formSource = "https://www.budzdorov.ru/forms/kagocel";
    const productPath = "/product/kagotsel-tab-12mg-no20-106662";
    const form = translated(formSource,
      `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" ` +
      `title="${brand} \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 12\u043c\u0433 \u211620">${brand}</a></main>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).pathname).toBe("/forms/kagocel");
      return new Response(form, { status: 200, headers: { "content-type": "text/html" } });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);
    const runContext = { ...context, runId: "bud-kagocel-run", brands: [brand] };

    await expect(adapter.healthCheck(runContext)).resolves.toMatchObject({ ok: true });
    await expect(adapter.discover(brand, runContext)).resolves.toMatchObject([
      { listingId: "106662", url: `https://www.budzdorov.ru${productPath}` }
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("tries the ts spelling used by the Cereton form without treating an empty alias as no results", async () => {
    const productPath = "/product/tsereton-kaps-400mg-no28-330028";
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const source = `https://www.budzdorov.ru${url.pathname}`;
      if (url.pathname === "/forms/cereton") {
        return new Response(translated(source, "<main>Каталог лекарств</main>"), { status: 200 });
      }
      expect(url.pathname).toBe("/forms/tsereton");
      return new Response(translated(source,
        `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" ` +
        `title="Церетон капсулы 400 мг №28">Церетон</a></main>`
      ), { status: 200 });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    await expect(adapter.discover("Церетон", context)).resolves.toMatchObject([
      { listingId: "330028", url: `https://www.budzdorov.ru${productPath}` }
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("collects eTabl product state and drops its default rating when there are no reviews", async () => {
    const searchSource = "https://etabl.ru/search?query=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC&limit=100";
    const productSource = "https://etabl.ru/product/otsillokoktsinum=187122000610";
    const item = {
      id: "187122000610", name: "ОЦИЛЛОКОКЦИНУМ", url: "otsillokoktsinum=187122000610",
      subtitleFull: "гранулы гомеопатические N12", reviewsStats: { rating: 5, reviewsCount: 0 }
    };
    const statePage = (source: string, state: object) => translated(source, `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};document.currentScript.remove()</script>`);
    const search = statePage(searchSource, {
      search: { searchQuery: "Оциллококцинум", searchResultNew: [item], searchResultCount: 1 }
    });
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

  it("collects the single live Хондрофен card when eTabl's broad count is larger", async () => {
    const searchSource = "https://etabl.ru/search?query=%D0%A5%D0%BE%D0%BD%D0%B4%D1%80%D0%BE%D1%84%D0%B5%D0%BD&limit=100";
    const productSource = "https://etabl.ru/product/khondrofen=187242009440";
    const item = {
      id: "187242009440", name: "ХОНДРОФЕН", url: "khondrofen=187242009440",
      subtitleFull: "мазь 30г N1", reviewsStats: { rating: 5, reviewsCount: 0 }
    };
    const translatedCanonical = (source: string, state: object) => {
      const canonical = new URL(source);
      canonical.search = "";
      return `<!doctype html><html><head><link rel="canonical" href="${canonical}"><base href="/"></head><body>` +
        `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};document.currentScript.remove()</script></body></html>`;
    };
    const search = translatedCanonical(searchSource, {
      search: { searchQuery: "Хондрофен", searchResultNew: [item], searchResultCount: 2 }
    });
    const product = translatedCanonical(productSource, { products: { product: item } });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(url.pathname === "/search" ? search : product, {
        status: 200, headers: { "content-type": "text/html" }
      });
    }) as unknown as typeof fetch;
    const adapter = new EtablAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Хондрофен", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      listingId: "187242009440",
      title: "ХОНДРОФЕН мазь 30г N1",
      url: productSource
    });
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      product: "ХОНДРОФЕН мазь 30г N1",
      reviews: 0,
      rating: null,
      status: "no_reviews"
    });
  });

  it("keeps eTabl fail-closed when a positive counter has no product cards", async () => {
    const searchSource = "https://etabl.ru/search?query=%D0%A5%D0%BE%D0%BD%D0%B4%D1%80%D0%BE%D1%84%D0%B5%D0%BD&limit=100";
    const search = translated(searchSource,
      `<script>window.__INITIAL_STATE__=${JSON.stringify({
        search: { searchQuery: "Хондрофен", searchResultNew: [], searchResultCount: 1 }
      })};document.currentScript.remove()</script>`);
    const adapter = new EtablAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(search, {
      status: 200, headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch);

    await expect(adapter.discover("Хондрофен", context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("keeps Apteka April as an explicit access block, never an empty result", async () => {
    const adapter = new AptekaAprilAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response("Forbidden", {
      status: 403, headers: { "content-type": "text/plain" }
    })) as unknown as typeof fetch);

    await expect(adapter.discover("Оциллококцинум", context)).rejects.toBeInstanceOf(AdapterBlockedError);
    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: false });
  });
});
