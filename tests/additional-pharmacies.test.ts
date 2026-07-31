import { describe, expect, it, vi } from "vitest";
import {
  AptekaAprilAdapter,
  AptekaRuAdapter,
  BudZdorovAdapter,
  EtablAdapter,
  NfAptekaAdapter,
  OzerkiAdapter
} from "../src/server/adapters/additional-pharmacies.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const context = { region: "Москва", runId: "pharmacy-test" };

function translated(source: string, body: string) {
  return `<!doctype html><html><head><base href="${source}"><script data-source-url="${source}"></script></head><body>${body}</body></html>`;
}

function aptekaSelectedVariant(url: string, title: string, count: number, rating: number, selected = true) {
  return `<div class="variantButton"${selected ? ' aria-selected="true"' : ""}><a class="variantButton__link" href="${url}" aria-label="${title}"></a>` +
    `<div class="variantButton__rating"><div class="ItemRating"><span class="ItemRating__label">${rating}</span>` +
    `<span class="caption3">(<span>${count}</span> reviews)</span></div></div></div>`;
}

function aptekaExpandedVariant(url: string, title: string, count: number, rating: number) {
  return `<div class="variantButtonExp"><a class="variantButtonExp__link" href="${url}" aria-label="${title}"></a>` +
    `<div class="variantButtonExp__rating"><div class="ItemRating"><span class="ItemRating__label">${rating}</span>` +
    `<span class="caption3">(<span>${count}</span> reviews)</span></div></div></div>`;
}

function nfReviewList(title: string, ratings: number[]) {
  return `<div id="review">${ratings.map((rating) =>
    `<div class="testimonial" itemscope itemtype="https://schema.org/Review"><meta itemprop="itemReviewed" content="${title}">` +
    `<div itemprop="reviewRating" itemscope itemtype="https://schema.org/Rating"><meta itemprop="ratingValue" content="${rating}"></div></div>`
  ).join("")}</div>`;
}

describe("additional pharmacy adapters", () => {
  it("discovers one exact Ozerki family and keeps its aggregate bound to that family", async () => {
    const brand = "\u0410\u043a\u0432\u0430\u041e\u043f\u0442\u0438\u043a";
    const familyUrl = "https://ozerki.ru/alphabet/a/akvaoptik/";
    const html = `<!doctype html><html><head><base href="${familyUrl}"></head><body>
      <h1>${brand}</h1><div id="feedbackAnchor"><div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
        <meta itemprop="reviewCount" content="2"><meta itemprop="ratingCount" content="2"><meta itemprop="ratingValue" content="5">
        <article itemprop="review">Отзыв 1</article><article itemprop="review">Отзыв 2</article>
      </div></div><div itemprop="aggregateRating"><meta itemprop="reviewCount" content="99"></div>
      <article class="variant">${brand} раствор 5 мл</article><article class="variant">${brand} раствор 10 мл</article>
    </body></html>`;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).toString()).toBe(familyUrl);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      domain: "ozerki.ru",
      listingId: "family-akvaoptik",
      url: familyUrl,
      metadata: { discovery: "ozerki-exact-family-page" }
    });
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      listingId: "family-akvaoptik",
      reviews: 2,
      writtenReviewCount: 2,
      ratingCount: 2,
      rating: 5,
      status: "ok",
      aggregateGroupId: "ozerki:family:family-akvaoptik",
      productEvidence: { scope: "product_family" },
      source: "ozerki-family-aggregate-microdata"
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("tries Ozerki's exact kagotsel family after kagocel is missing and keeps one 10/20/30 aggregate", async () => {
    const brand = "Кагоцел";
    const familyUrl = "https://ozerki.ru/alphabet/k/kagotsel/";
    const reviewMarkup = Array.from({ length: 23 }, (_, index) =>
      `<article itemprop="review">Отзыв ${index + 1}</article>`
    ).join("");
    const html = `<!doctype html><html><head><base href="${familyUrl}"></head><body>
      <h1>${brand}</h1>
      <select aria-label="Варианты упаковки">
        <option>${brand} таблетки 12 мг №10</option>
        <option>${brand} таблетки 12 мг №20</option>
        <option>${brand} таблетки 12 мг №30</option>
      </select>
      <div id="feedbackAnchor"><div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
        <meta itemprop="reviewCount" content="23"><meta itemprop="ratingCount" content="23">
        <meta itemprop="ratingValue" content="4.96">${reviewMarkup}
      </div></div>
    </body></html>`;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname === "/alphabet/k/kagocel/"
        ? new Response("missing", { status: 404 })
        : new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs).toMatchObject([{
      listingId: "family-kagotsel",
      url: familyUrl,
      metadata: { discovery: "ozerki-exact-family-page" }
    }]);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      listingId: "family-kagotsel",
      reviews: 23,
      writtenReviewCount: 23,
      ratingCount: 23,
      rating: 4.96,
      aggregateGroupId: "ozerki:family:family-kagotsel",
      productEvidence: {
        scope: "product_family",
        variants: expect.arrayContaining([
          `${brand} таблетки 12 мг №10`,
          `${brand} таблетки 12 мг №20`,
          `${brand} таблетки 12 мг №30`
        ])
      }
    });
    expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/alphabet/k/kagocel/",
      "/alphabet/k/kagotsel/",
      "/alphabet/k/kagotsel/"
    ]);
  });

  it("fails closed when Ozerki family counts are not backed by exact review markup", async () => {
    const brand = "\u0410\u043a\u0432\u0430\u041e\u043f\u0442\u0438\u043a";
    const familyUrl = "https://ozerki.ru/alphabet/a/akvaoptik/";
    const html = `<!doctype html><html><head><base href="${familyUrl}"></head><body>
      <h1>${brand}</h1><div id="feedbackAnchor"><div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
        <meta itemprop="reviewCount" content="2"><meta itemprop="ratingCount" content="2"><meta itemprop="ratingValue" content="5">
      </div></div>
    </body></html>`;
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch);

    await expect(adapter.collect({
      domain: "ozerki.ru", platform: "ozerki.ru", listingId: "family-akvaoptik", brand,
      url: familyUrl, metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("discovers and collects the bounded exact Ozerki product AggregateRating", async () => {
    const brand = "Бивиарт";
    const productUrl = "https://ozerki.ru/catalog/product/biviart-ultra-rastvor-oftalmologicheskiy-uvlazhnyayushchiy-fl-kap-10ml-1-370912/";
    const html = `<!doctype html><html><head><link rel="canonical" href="${productUrl}">
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        sku: "370912",
        name: "Бивиарт Ультра 0,3% раствор офтальмологический увлажняющий 10 мл",
        url: productUrl,
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: 5,
          reviewCount: 1,
          ratingCount: 1
        }
      })}</script></head><body><h1>Бивиарт Ультра 0,3% раствор 10 мл в Москве</h1></body></html>`;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).toString()).toBe(productUrl);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs).toEqual([expect.objectContaining({
      listingId: "370912",
      brand,
      url: productUrl,
      metadata: { discovery: "ozerki-bounded-exact-product" }
    })]);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      listingId: "370912",
      reviews: 1,
      writtenReviewCount: 1,
      ratingCount: 1,
      rating: 5,
      status: "ok",
      canonicalUrl: productUrl,
      productEvidence: {
        scope: "listing",
        identifiers: [{ type: "product_id", value: "370912" }]
      },
      source: "ozerki-product-aggregate-jsonld"
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("discovers all exact Enterolactis products and accepts only their source-bound empty-review proof", async () => {
    const brand = "Энтеролактис";
    const products = [
      {
        id: "339183",
        title: "Энтеролактис Фибра сироп 10 мл 12 шт",
        url: "https://ozerki.ru/catalog/product/enterolaktis-fibra-sirop-fl-10ml-12/"
      },
      {
        id: "346830",
        title: "Энтеролактис Плюс капсулы 15 шт",
        url: "https://ozerki.ru/catalog/product/enterolaktis-plyus-n15-kaps-po-316mg-346830/"
      },
      {
        id: "362968",
        title: "Энтеролактис Дуо порошок для приготовления раствора 5 г 20 шт",
        url: "https://ozerki.ru/catalog/product/enterolaktis-duo-n20-sashe-po-5g-362968/"
      }
    ] as const;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const match = products.find((product) => product.url === new URL(String(input)).toString());
      if (!match) return new Response("missing", { status: 404 });
      const html = `<!doctype html><html><head><link rel="canonical" href="${match.url}">
        <script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org", "@type": "Product", sku: match.id,
          name: match.title, url: match.url
        })}</script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
          props: { pageProps: { data: { componentData: { initialReviews: {
            data: [], meta: { total: 0 },
            rates: { average: null, total: 0, filterByValue: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }
          } } } } }
        })}</script></head><body>
        <h1>${match.title} в Москве</h1><div id="feedbackAnchor">
          <div class="Reviews_noReviewsBlock__proof">
            <p>Вы использовали этот товар?</p><p>Поделитесь своим мнением о нём</p>
          </div></div></body></html>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs.map((item) => item.listingId)).toEqual(["339183", "346830", "362968"]);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));
    expect(observations).toEqual(expect.arrayContaining(products.map((product) => expect.objectContaining({
      listingId: product.id,
      reviews: 0,
      writtenReviewCount: 0,
      ratingCount: 0,
      rating: null,
      status: "no_reviews",
      source: "ozerki-visible-product-empty-state"
    }))));
  });

  it("fails closed for an exact Ozerki product without a source-bound aggregate", async () => {
    const brand = "Бивиарт";
    const productUrl = "https://ozerki.ru/catalog/product/biviart-soft-rastvor-flakon-kapelnitsa-uvlazhnyayuschiy-10-ml/";
    const html = `<!doctype html><html><head><link rel="canonical" href="${productUrl}">
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        sku: "370998",
        name: "Бивиарт Софт раствор офтальмологический 10 мл",
        url: productUrl
      })}</script></head><body><h1>Бивиарт Софт раствор офтальмологический 10 мл</h1>
      <p>Поделитесь своим мнением</p></body></html>`;
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch);

    await expect(adapter.collect({
      domain: "ozerki.ru",
      platform: "ozerki.ru",
      listingId: "370998",
      brand,
      url: productUrl,
      metadata: {}
    }, context)).rejects.toThrow("source-bound product aggregate is missing");
  });

  it("collapses regional Ozerki duplicates and rejects a noncanonical product page", async () => {
    const brand = "Бивиарт";
    const productUrl = "https://ozerki.ru/catalog/product/biviart-ultra-rastvor-oftalmologicheskiy-uvlazhnyayushchiy-fl-kap-10ml-1-370912/";
    const regionalUrl = productUrl.replace("https://ozerki.ru/", "https://spb.ozerki.ru/");
    const wrongCanonical = productUrl.replace("-370912/", "-370998/");
    const html = `<!doctype html><html><head><link rel="canonical" href="${wrongCanonical}">
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        sku: "370912",
        name: "Бивиарт Ультра 0,3% раствор 10 мл",
        url: productUrl,
        aggregateRating: { "@type": "AggregateRating", ratingValue: 5, reviewCount: 1, ratingCount: 1 }
      })}</script></head><body><h1>Бивиарт Ультра 0,3% раствор 10 мл</h1></body></html>`;
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch);

    const refs = await adapter.discover(brand, {
      ...context,
      previousRefs: [
        { listingId: "370912", url: productUrl },
        { listingId: "370912", url: regionalUrl }
      ]
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "370912", url: productUrl });
    await expect(adapter.collect(refs[0], context)).rejects.toThrow("exact product canonical is missing or changed");
  });

  it("uses a fixed Ozerki canary instead of blocking on the first requested brand", async () => {
    const familyUrl = "https://ozerki.ru/alphabet/a/akvaoptik/";
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).toString()).toBe(familyUrl);
      return new Response("<html><body><h1>АкваОптик</h1></body></html>", { status: 200 });
    });
    const adapter = new OzerkiAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    await expect(adapter.healthCheck({ ...context, brands: ["Таустин", "АкваОптик"] })).resolves.toMatchObject({
      ok: true,
      message: "ozerki.ru: fixed exact family canary is available"
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

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
      if (url.pathname.startsWith("/preparation/") && url.pathname !== new URL(preparationUrl).pathname) {
        return new Response("missing", { status: 404 });
      }
      return new Response(url.pathname === new URL(preparationUrl).pathname ? preparation : product, {
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
      "apteka-ru.translate.goog",
      "apteka-ru.translate.goog",
      "apteka-ru.translate.goog"
    ]);
  });

  it("unions all three exact Enterolactis Apteka.ru cards and verifies each selected aggregate", async () => {
    const brand = "Энтеролактис";
    const products = [
      {
        id: "6061c3333312949196ec943d",
        title: "Энтеролактис плюс 15 шт. капсулы массой 319 мг",
        path: "/product/enterolaktis-plyus-15-sht-kapsuly-massoj-319-mg-6061c3333312949196ec943d/",
        reviews: 122,
        rating: 4.9
      },
      {
        id: "6267ea3630197ea53c0caa2c",
        title: "Энтеролактис дуо 20 шт. саше по 5 г",
        path: "/product/enterolaktis-duo-20-sht-sashe-po-5-g-6267ea3630197ea53c0caa2c/",
        reviews: 128,
        rating: 4.8
      },
      {
        id: "611b9cdd492c4ced7420a4a6",
        title: "Энтеролактис фибра 10 мл 12 шт. флакон сироп",
        path: "/product/enterolaktis-fibra-10-ml-12-sht-flakon-sirop-i-kapsula-s-poroshkom-v-kryshkax-flakonov-611b9cdd492c4ced7420a4a6/",
        reviews: 83,
        rating: 4.9
      }
    ] as const;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/preparation/enterolaktis/") {
        const source = "https://apteka.ru/preparation/enterolaktis/";
        return new Response(translated(source, products.slice(0, 2).map((product) =>
          `<article><a href="https://apteka-ru.translate.goog${product.path}?_x_tr_sl=ru&amp;_x_tr_tl=en" aria-label="${product.title}">${product.title}</a></article>`
        ).join("")), { status: 200, headers: { "content-type": "text/html" } });
      }
      const product = products.find((item) => item.path === url.pathname);
      if (!product) throw new Error(`unexpected Apteka.ru route: ${url.pathname}`);
      const source = `https://apteka.ru${product.path}`;
      return new Response(translated(source,
        `<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org", "@type": "Product", sku: product.id, name: product.title,
          aggregateRating: { "@type": "AggregateRating", reviewCount: product.reviews, ratingCount: product.reviews, ratingValue: product.rating }
        })}</script>${aptekaSelectedVariant(source, product.title, product.reviews, product.rating)}`
      ), { status: 200, headers: { "content-type": "text/html" } });
    });
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs.map((item) => item.listingId).sort()).toEqual(products.map((item) => item.id).sort());
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));
    expect(observations).toEqual(expect.arrayContaining(products.map((product) => expect.objectContaining({
      listingId: product.id,
      reviews: product.reviews,
      ratingCount: product.reviews,
      rating: product.rating,
      status: "ok"
    }))));
  });

  it("discovers the three current Apteka.ru Кагоцел cards through translated kagoczel SSR", async () => {
    const brand = "Кагоцел";
    const cards = [
      ["5e3275a565b5ab0001657670", "10"],
      ["5e3267bb65b5ab0001650df1", "20"],
      ["5e72213198826b00010741c6", "30"]
    ].map(([id, count]) => ({
      id,
      title: `${brand} 12 мг ${count} шт. таблетки`,
      url: `https://apteka.ru/product/kagoczel-12-mg-${count}-sht-tabletki-${id}/`
    }));
    const preparationUrl = "https://apteka.ru/preparation/kagoczel/";
    const preparation = translated(preparationUrl, `<main><h1>${brand}</h1>${cards.map((card) =>
      `<article class="product"><a href="${card.url}" aria-label="${card.title}">${card.title}</a></article>`
    ).join("")}</main>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("apteka-ru.translate.goog");
      return url.pathname === "/preparation/kagoczel/"
        ? new Response(preparation, { status: 200, headers: { "content-type": "text/html" } })
        : new Response("missing", { status: 404 });
    });

    const refs = await new AptekaRuAdapter(
      new MemoryEvidenceStore(),
      fetchSpy as unknown as typeof fetch
    ).discover(brand, context);

    expect(refs.map(({ listingId, url }) => ({ listingId, url }))).toEqual(
      cards.map((card) => ({ listingId: card.id, url: card.url }))
    );
    expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/preparation/kagocel/",
      "/preparation/kagotsel/",
      "/preparation/kagoczel/"
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

  it("accepts Apteka.ru's exact self-bound Product offer when the variant strip is absent", async () => {
    const id = "6267ea3630197ea53c0caa2c";
    const title = "Энтеролактис дуо 20 шт. саше по 5 г";
    const productUrl = `https://apteka.ru/product/enterolaktis-duo-20-sht-sashe-po-5-g-${id}/`;
    const html = translated(productUrl, `<h1>${title}</h1><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", sku: id, name: title,
      aggregateRating: { reviewCount: 129, ratingValue: 4.7 },
      offers: [{ "@type": "Offer", url: new URL(productUrl).pathname, name: title }]
    })}</script>`);
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(html, {
      headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch);

    await expect(adapter.collect({
      domain: "apteka.ru", platform: "apteka.ru", listingId: id, brand: "Энтеролактис", url: productUrl, metadata: {}
    }, context)).resolves.toMatchObject({ reviews: 129, rating: 4.7, status: "ok" });
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
    const letterSource = "https://www.budzdorov.ru/letter/%D0%9E";
    const productPath = "/product/otsillokoktsinum-granuly-6doz-2511";
    const productSource = `https://www.budzdorov.ru${productPath}`;
    const form = translated(formSource, `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" title="Оциллококцинум гранулы 6 доз">Оциллококцинум гранулы 6 доз</a></main>`);
    const letter = translated(letterSource, `<main class="alphabet-forms"><a class="alphabet-forms__item-link" href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Оциллококцинум гранулы 6 доз</a></main>`);
    const reviews = [
      { id: 1, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 2, ratings: [{ attribute_code: "Оценка", value: 4 }] },
      { id: 3, ratings: [{ attribute_code: "Оценка", value: 5 }] }
    ];
    const product = translated(productSource, `<h1>Оциллококцинум гранулы 6 доз</h1><div allreviewsqty="3"></div><script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews } })};document.currentScript.remove()</script>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = url.pathname.startsWith("/forms/") ? form : url.pathname.startsWith("/letter/") ? letter : product;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "2511", url: productSource });
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe("/forms/ocillokokcinum");
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({ reviews: 3, rating: 4.7, status: "ok" });
    expect(new URL(String(fetchSpy.mock.calls[1][0])).pathname).toBe("/letter/%D0%9E");
    expect(new URL(String(fetchSpy.mock.calls[2][0])).pathname).toBe(productPath);
  });

  it("collects an exact Apteka.ru variant when SSR omits the transient selected attribute", async () => {
    const id = "5e3268eaca7bdc000192d316";
    const productUrl = `https://apteka.ru/product/oczillokokczinum-30-sht-granuly-${id}/`;
    const title = "Оциллококцинум 30 шт. гранулы";
    const product = `<!doctype html><html><head><base href="${productUrl}"><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", sku: id, name: title,
      aggregateRating: { "@type": "AggregateRating", reviewCount: 44, ratingValue: 4.9 }
    })}</script></head><body>${aptekaSelectedVariant(productUrl, title, 44, 4.9, false)}</body></html>`;
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(product, {
      status: 200, headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch);

    await expect(adapter.collect({
      domain: "apteka.ru", platform: "apteka.ru", listingId: id, brand: "Оциллококцинум",
      url: productUrl, title, metadata: {}
    }, context)).resolves.toMatchObject({ reviews: 44, rating: 4.9, status: "ok" });
  });

  it("collects an exact Apteka.ru expanded SSR variant with source-bound feedback", async () => {
    const id = "5e3268eaca7bdc000192d316";
    const productUrl = `https://apteka.ru/product/oczillokokczinum-30-sht-granuly-${id}/`;
    const title = "Оциллококцинум 30 шт. гранулы";
    const product = `<!doctype html><html><head><base href="${productUrl}"><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "Product", sku: id, name: title,
      aggregateRating: { "@type": "AggregateRating", reviewCount: 44, ratingValue: 4.9 }
    })}</script></head><body>${aptekaExpandedVariant(productUrl, title, 44, 4.9)}</body></html>`;
    const adapter = new AptekaRuAdapter(new MemoryEvidenceStore(), vi.fn(async () => new Response(product, {
      status: 200, headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch);

    await expect(adapter.collect({
      domain: "apteka.ru", platform: "apteka.ru", listingId: id, brand: "Оциллококцинум",
      url: productUrl, title, metadata: {}
    }, context)).resolves.toMatchObject({ reviews: 44, rating: 4.9, status: "ok" });
  });

  it("keeps Bud Zdorov's complete written-review count when some reviews have no star score", async () => {
    const productPath = "/product/kagotsel-tab-12mg-no10-15027";
    const productSource = `https://www.budzdorov.ru${productPath}`;
    const reviews = [
      { id: 9094, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 8892, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 8015, ratings: [] },
      { id: 4688, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 1345, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 1250, ratings: [] }
    ];
    const product = translated(productSource,
      `<h1>Кагоцел таблетки 0,012г №10</h1><div allreviewsqty="6"></div>` +
      `<script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews } })};document.currentScript.remove()</script>`);
    const ref = {
      domain: "budzdorov.ru", platform: "budzdorov.ru", listingId: "15027", brand: "Кагоцел",
      url: productSource, metadata: {}
    };

    await expect(new BudZdorovAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(product, { status: 200 })) as unknown as typeof fetch).collect(ref, context))
      .resolves.toMatchObject({
        listingId: "15027", reviews: 6, rating: null, ratingUnavailable: true, status: "ok"
      });
  });

  it("accepts Bud Zdorov's current self-removing state script but rejects an unknown executable suffix", async () => {
    const productPath = "/product/baktoblis-plyus-tabdlya-rassas-950mg-no30-ddet-starshe-3-kh-let-i-vzr-bad-5005555";
    const productSource = `https://www.budzdorov.ru${productPath}`;
    const state = JSON.stringify({ productView: { reviews: [
      { id: 901, ratings: [{ attribute_code: "Оценка", value: 5 }] }
    ] } });
    const cleanup = ";(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}())";
    const page = (suffix: string) => translated(productSource,
      `<h1>Бактоблис плюс таблетки для рассасывания 950 мг №30</h1><div allreviewsqty="1"></div>` +
      `<script>window.__INITIAL_STATE__=${state}${suffix}</script>`);
    const ref = {
      domain: "budzdorov.ru", platform: "budzdorov.ru", listingId: "5005555", brand: "Бактоблис",
      url: productSource, metadata: {}
    };

    await expect(new BudZdorovAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(page(cleanup), { status: 200 })) as unknown as typeof fetch).collect(ref, context))
      .resolves.toMatchObject({ listingId: "5005555", reviews: 1, rating: 5, status: "ok" });

    await expect(new BudZdorovAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(page(";sendStateElsewhere()"), { status: 200 })) as unknown as typeof fetch).collect(ref, context))
      .rejects.toThrow(/unknown executable suffix/);
  });

  it("uses the translated letter index and completes it with bounded refs when the brand form was removed", async () => {
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

    const refs = await new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch)
      .discover("Бактоблис", context);
    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["109834", "5005555", "5005556", "6000866"]);
    expect(refs.find((ref) => ref.listingId === "109834")).toMatchObject({
      url: `https://www.budzdorov.ru${productPath}`,
      metadata: { discovery: "translated-first-party-letter-index" }
    });
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe(new URL(formSource).pathname);
  });

  it("verifies every bounded exact Baktoblis card when Bud Zdorov indexes are unavailable", async () => {
    const brand = "\u0411\u0430\u043a\u0442\u043e\u0431\u043b\u0438\u0441";
    const products = new Map<string, { id: string; title: string; reviews: Array<{ id: number; ratings: never[] }> }>([
      ["/product/baktoblis-plyus-tabdlya-rassas-950mg-no30-ddet-starshe-3-kh-let-i-vzr-bad-5005555", {
        id: "5005555", title: `${brand} \u043f\u043b\u044e\u0441 \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 \u0434\u043b\u044f \u0440\u0430\u0441\u0441\u0430\u0441\u044b\u0432\u0430\u043d\u0438\u044f 950 \u043c\u0433 \u211630`, reviews: []
      }],
      ["/product/baktoblis-tab-dlya-rassasyv-30g-no30-109834", {
        id: "109834", title: `${brand} \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 \u0434\u043b\u044f \u0440\u0430\u0441\u0441\u0430\u0441\u044b\u0432\u0430\u043d\u0438\u044f 30 \u0433 \u211630`,
        reviews: [1, 2, 3, 4, 5].map((id) => ({ id, ratings: [] }))
      }],
      ["/product/baktoblis-poroshok-dlya-vzr-i-det-ot-15let-sashe-paket-1500mg-no15-bad-5005556", {
        id: "5005556", title: `${brand} \u043f\u043e\u0440\u043e\u0448\u043e\u043a \u0432 \u0441\u0430\u0448\u0435-\u043f\u0430\u043a\u0435\u0442\u0430\u0445 1500 \u043c\u0433 \u211615`, reviews: []
      }],
      ["/product/baktoblis-poroshok-v-sashe-paketakh-1500mg-no30-6000866", {
        id: "6000866", title: `${brand} \u043f\u043e\u0440\u043e\u0448\u043e\u043a \u0432 \u0441\u0430\u0448\u0435-\u043f\u0430\u043a\u0435\u0442\u0430\u0445 1500 \u043c\u0433 \u211630`, reviews: []
      }]
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/forms/baktoblis") return new Response("missing", { status: 404 });
      if (url.pathname === "/letter/%D0%91") return new Response("gateway", { status: 502 });
      const product = products.get(url.pathname);
      if (!product) throw new Error(`unexpected Bud Zdorov route: ${url.pathname}`);
      const source = `https://www.budzdorov.ru${url.pathname}`;
      return new Response(translated(source,
        `<h1>${product.title}</h1><div allreviewsqty="${product.reviews.length}"></div>` +
        `<script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews: product.reviews } })};document.currentScript.remove()</script>`), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["109834", "5005555", "5005556", "6000866"]);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));
    expect(observations.find((item) => item.listingId === "5005555"))
      .toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
    expect(observations.find((item) => item.listingId === "109834"))
      .toMatchObject({ reviews: 5, rating: null, ratingUnavailable: true, status: "ok" });
    expect(observations.find((item) => item.listingId === "5005556"))
      .toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
    expect(observations.find((item) => item.listingId === "6000866"))
      .toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
  });

  it("verifies all three bounded exact Enterolactis cards when Bud Zdorov indexes are unavailable", async () => {
    const brand = "Энтеролактис";
    const products = new Map([
      ["/product/enterolaktis-plyus-kaps-316mg-no15-bad-113143", { id: "113143", title: `${brand} Плюс капсулы 316 мг №15` }],
      ["/product/enterolaktis-fibra-sirop-fl-10ml-kapsula-s-porno12-bad-4993056", { id: "4993056", title: `${brand} Фибра сироп 10 мл №12` }],
      ["/product/enterolaktis-duo-sashe-5g-no20-bad-5005750", { id: "5005750", title: `${brand} Дуо саше 5 г №20` }]
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/forms/enterolaktis") return new Response("missing", { status: 404 });
      if (url.pathname === "/letter/%D0%AD") return new Response("gateway", { status: 502 });
      const product = products.get(url.pathname);
      if (!product) throw new Error(`unexpected Bud Zdorov route: ${url.pathname}`);
      const source = `https://www.budzdorov.ru${url.pathname}`;
      return new Response(translated(source,
        `<h1>${product.title}</h1><div allreviewsqty="0"></div>` +
        `<script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews: [] } })};document.currentScript.remove()</script>`), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs.map((item) => item.listingId).sort()).toEqual(["113143", "4993056", "5005750"]);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "113143", reviews: 0, rating: null, status: "no_reviews" }),
      expect.objectContaining({ listingId: "4993056", reviews: 0, rating: null, status: "no_reviews" }),
      expect.objectContaining({ listingId: "5005750", reviews: 0, rating: null, status: "no_reviews" })
    ]));
  });

  it("verifies the four bounded exact Кагоцел cards and preserves their per-card review counts", async () => {
    const brand = "Кагоцел";
    type Review = { id: number; ratings: Array<{ attribute_code: string; value: number }> };
    const products = new Map<string, { id: string; title: string; reviews: Review[] }>([
      ["/product/kagotsel-tab-12mg-no10-15027", {
        id: "15027", title: `${brand} таблетки 0,012г №10`,
        reviews: [
          { id: 9094, ratings: [{ attribute_code: "Оценка", value: 5 }] },
          { id: 8892, ratings: [{ attribute_code: "Оценка", value: 5 }] },
          { id: 8015, ratings: [] },
          { id: 4688, ratings: [{ attribute_code: "Оценка", value: 5 }] },
          { id: 1345, ratings: [{ attribute_code: "Оценка", value: 5 }] },
          { id: 1250, ratings: [] }
        ]
      }],
      ["/product/90933", { id: "90933", title: `${brand} таблетки 0,012г №10`, reviews: [] }],
      ["/product/kagotsel-tab-12mg-no20-106662", {
        id: "106662", title: `${brand} таблетки 12мг №20`,
        reviews: [1, 2, 3, 4].map((id) => ({ id, ratings: [{ attribute_code: "Оценка", value: 5 }] }))
      }],
      ["/product/kagotsel-tab-12mg-no30-110671", {
        id: "110671", title: `${brand} таблетки 12мг №30`,
        reviews: [
          { id: 6, ratings: [] },
          ...[1, 2, 3, 4, 5].map((id) => ({ id, ratings: [{ attribute_code: "Оценка", value: 5 }] }))
        ]
      }]
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/forms/")) return new Response("missing", { status: 404 });
      if (url.pathname.startsWith("/letter/")) return new Response("gateway", { status: 502 });
      const product = products.get(url.pathname);
      if (!product) throw new Error(`unexpected Bud Zdorov route: ${url.pathname}`);
      const source = `https://www.budzdorov.ru${url.pathname}`;
      return new Response(translated(source,
        `<h1>${product.title}</h1><div allreviewsqty="${product.reviews.length}"></div>` +
        `<script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews: product.reviews } })};document.currentScript.remove()</script>`), {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const refs = await adapter.discover(brand, context);
    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["106662", "110671", "15027", "90933"]);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));
    const actual = observations.map((item) => ({
      listingId: item.listingId,
      reviews: item.reviews,
      rating: item.rating,
      status: item.status
    })).sort((left, right) => left.listingId.localeCompare(right.listingId));
    expect(actual).toEqual([
      { listingId: "106662", reviews: 4, rating: 5, status: "ok" },
      { listingId: "110671", reviews: 6, rating: null, status: "ok" },
      { listingId: "15027", reviews: 6, rating: null, status: "ok" },
      { listingId: "90933", reviews: 0, rating: null, status: "no_reviews" }
    ]);
    for (const id of ["15027", "110671"]) {
      expect(observations.find((item) => item.listingId === id)).toMatchObject({ ratingUnavailable: true });
    }
    expect(observations.find((item) => item.listingId === "106662")).not.toHaveProperty("ratingUnavailable");
  });

  it("unions form and alphabet discovery for all four eye-care brands and excludes Taurin/Taufon analogs", async () => {
    const product = (path: string, title: string, className = "product-info__title") =>
      `<a class="${className}" href="https://www-budzdorov-ru.translate.goog${path}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">${title}</a>`;
    const pages = new Map<string, { status?: number; body: string }>([
      ["/forms/biviart", { status: 404, body: "missing" }],
      ["/letter/%D0%91", { body: `<main class="alphabet-forms">
        ${product("/product/biviart-komfort-123189", "Бивиарт Комфорт 0,18% 10 мл", "alphabet-forms__item-link")}
        ${product("/product/biviart-soft-123188", "Бивиарт Софт 0,1% 10 мл", "alphabet-forms__item-link")}
        ${product("/product/biviart-ultra-123187", "Бивиарт Ультра 0,3% 10 мл", "alphabet-forms__item-link")}
      </main>` }],
      ["/forms/okusalin", { body: `<main>${product("/product/okusalin-3-2ml-4990339", "Окусалин 3% 2 мл №10")}</main>` }],
      ["/forms/oftarint", { body: `<main>${product("/product/oftarint-01-10ml-111503", "Офтаринт 0,1% 10 мл")}</main>` }],
      ["/letter/%D0%9E", { body: `<main class="alphabet-forms">
        ${product("/product/okusalin-3-2ml-4990339", "Окусалин 3% 2 мл №10", "alphabet-forms__item-link")}
        ${product("/product/okusalin-1ml-106305", "Окусалин 1 мл №10", "alphabet-forms__item-link")}
        ${product("/product/oftarint-01-10ml-111503", "Офтаринт 0,1% 10 мл", "alphabet-forms__item-link")}
      </main>` }],
      ["/forms/taustin", { body: `<main>
        ${product("/product/taustin-4-10ml-4990756", "Таустин капли глазные 4% 10 мл")}
        ${product("/product/taurin-4-10ml-43973", "Таурин капли глазные 4% 10 мл")}
      </main>` }],
      ["/letter/%D0%A2", { body: `<main class="alphabet-forms">
        ${product("/product/taustin-04ml-4990371", "Таустин капли глазные 4% 0,4 мл №20", "alphabet-forms__item-link")}
        ${product("/product/taustin-1ml-4990372", "Таустин капли глазные 4% 1 мл №20", "alphabet-forms__item-link")}
        ${product("/product/taustin-4-10ml-4990756", "Таустин капли глазные 4% 10 мл", "alphabet-forms__item-link")}
        ${product("/product/taurin-4-10ml-43973", "Таурин капли глазные 4% 10 мл", "alphabet-forms__item-link")}
        ${product("/product/taufon-4-10ml-116393", "Тауфон капли глазные 4% 10 мл", "alphabet-forms__item-link")}
      </main>` }]
    ]);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const fixture = pages.get(url.pathname);
      if (!fixture) throw new Error(`unexpected Bud Zdorov route: ${url.pathname}`);
      const source = `https://www.budzdorov.ru${url.pathname}`;
      return new Response(fixture.status === 404 ? fixture.body : translated(source, fixture.body), {
        status: fixture.status ?? 200,
        headers: { "content-type": "text/html" }
      });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    const found = new Map<string, string[]>();
    for (const brand of ["Бивиарт", "Окусалин", "Офтаринт", "Таустин"]) {
      found.set(brand, (await adapter.discover(brand, { ...context, runId: `bud-${brand}` }))
        .map((ref) => ref.listingId).sort());
    }

    expect(Object.fromEntries(found)).toEqual({
      "Бивиарт": ["123187", "123188", "123189"],
      "Окусалин": ["106305", "4990339"],
      "Офтаринт": ["111503"],
      "Таустин": ["4990371", "4990372", "4990756"]
    });
    expect([...found.values()].flat()).not.toContain("43973");
    expect([...found.values()].flat()).not.toContain("116393");
  });

  it("fails closed instead of returning a partial Bud Zdorov form result when the alphabet index is blocked", async () => {
    const formSource = "https://www.budzdorov.ru/forms/taustin";
    const productPath = "/product/taustin-kapli-gl-4-10ml-no1-4990756";
    const form = translated(formSource,
      `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Таустин капли глазные 4% 10мл</a></main>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname.startsWith("/letter/")
        ? new Response("blocked", { status: 403 })
        : new Response(form, { status: 200 });
    });

    await expect(new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch)
      .discover("Таустин", context)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("unions partial live Bud Zdorov discovery with bounded exact refs and reuses the full set", async () => {
    const brand = "\u041a\u0430\u0433\u043e\u0446\u0435\u043b";
    const formSource = "https://www.budzdorov.ru/forms/kagocel";
    const productPath = "/product/kagotsel-tab-12mg-no20-106662";
    const form = translated(formSource,
      `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" ` +
      `title="${brand} \u0442\u0430\u0431\u043b\u0435\u0442\u043a\u0438 12\u043c\u0433 \u211620">${brand}</a></main>`);
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/forms/kagocel") {
        return new Response(form, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/forms/kagotsel") return new Response("missing", { status: 404 });
      expect(url.pathname).toBe("/letter/%D0%9A");
      return new Response(translated("https://www.budzdorov.ru/letter/%D0%9A",
        `<main class="alphabet-forms"><a class="alphabet-forms__item-link" href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">${brand} таблетки 12мг №20</a></main>`), { status: 200 });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);
    const runContext = { ...context, runId: "bud-kagocel-run", brands: [brand] };

    const health = await adapter.healthCheck(runContext);
    expect(health, health.message).toMatchObject({ ok: true });
    const refs = await adapter.discover(brand, runContext);
    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["106662", "110671", "15027", "90933"]);
    expect(refs.find((ref) => ref.listingId === "106662")).toMatchObject({
      url: `https://www.budzdorov.ru${productPath}`,
      metadata: { discovery: "translated-first-party-form+letter-union" }
    });
    for (const id of ["15027", "90933", "110671"]) {
      expect(refs.find((ref) => ref.listingId === id)).toMatchObject({
        metadata: { discovery: "bounded-exact-product-registry" }
      });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("tries the ts spelling used by the Cereton form without treating an empty alias as no results", async () => {
    const productPath = "/product/tsereton-kaps-400mg-no28-330028";
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const source = `https://www.budzdorov.ru${url.pathname}`;
      if (url.pathname === "/forms/cereton") {
        return new Response(translated(source, "<main>Каталог лекарств</main>"), { status: 200 });
      }
      if (url.pathname === "/forms/tsereton") {
        return new Response(translated(source,
          `<main><a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" ` +
          `title="Церетон капсулы 400 мг №28">Церетон</a></main>`
        ), { status: 200 });
      }
      expect(url.pathname).toBe("/letter/%D0%A6");
      return new Response(translated(source,
        `<main class="alphabet-forms"><a class="alphabet-forms__item-link" href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Церетон капсулы 400 мг №28</a></main>`
      ), { status: 200 });
    });
    const adapter = new BudZdorovAdapter(new MemoryEvidenceStore(), fetchSpy as unknown as typeof fetch);

    await expect(adapter.discover("Церетон", context)).resolves.toMatchObject([
      { listingId: "330028", url: `https://www.budzdorov.ru${productPath}` }
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
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
