import { describe, expect, it, vi } from "vitest";

import type { AdapterContext, ProductRef } from "../src/shared/types.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { YandexAdapter } from "../src/server/adapters/yandex.js";
import { analyzeProductIdentity } from "../src/server/utils/product-name.js";

const INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const MAP_A = "https://reviews.yandex.ru/ugcpub/sitemap_model_0-9999999-0.xml";
const MAP_B = "https://reviews.yandex.ru/ugcpub/sitemap_model_260000000-269999999-0.xml";
const MAP_C = "https://reviews.yandex.ru/ugcpub/sitemap_model_500000000-509999999-0.xml";
const MAP_695 = "https://reviews.yandex.ru/ugcpub/sitemap_model_690000000-699999999-0.xml";

describe("YandexAdapter discovery", () => {
  it("discovers model cards by Cyrillic brand transliteration and deduplicates modelId", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B, "https://evil.example/sitemap_model_1-2-0.xml"])),
      [MAP_A]: xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/chasy-kagotsel--111"])),
      [MAP_B]: xmlResponse(
        modelSitemap([
          "https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-20-sht--265149860",
          "https://reviews.yandex.ru/product/kagotsel--265149860",
          "https://reviews.yandex.ru/product/ingavirin--265149861",
          "https://evil.example/product/kagotsel--999"
        ])
      )
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 10 });

    const refs = await adapter.discover("Кагоцел", context());

    expect(new Set(refs.map(({ listingId }) => listingId))).toEqual(new Set(["265149860", "111"]));
    expect(refs.find(({ listingId }) => listingId === "265149860")?.url).toBe(
      "https://reviews.yandex.ru/product/kagotsel--265149860"
    );
    expect(refs.every((ref) => ref.platform === "yandex" && ref.domain === "market.yandex.ru")).toBe(true);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("evil.example"), expect.anything());
  });

  it("discovers every current Kagocel model across distant sitemap shards", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_B, MAP_695])),
      [MAP_B]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/kagotsel--265149860"
      ])),
      [MAP_695]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-10-sht--695943742",
        "https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-20-sht--695940046",
        "https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-30-sht--695941716",
        "https://reviews.yandex.ru/product/ingavirin--695999999"
      ]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 2 });

    const refs = await adapter.discover("Кагоцел", context({ runId: "kagocel-live-shape", brands: ["Кагоцел"] }));

    expect(new Set(refs.map(({ listingId }) => listingId))).toEqual(new Set([
      "265149860",
      "695940046",
      "695941716",
      "695943742"
    ]));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed before scanning when the sitemap index exceeds the cap", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B, MAP_C]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 1 });

    await expect(
      adapter.discover("Кагоцел", context({ previousIds: ["yandex:265149860"] }))
    ).rejects.toBeInstanceOf(AdapterBlockedError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses the small index but releases raw model sitemap responses between runs", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B, MAP_C])),
      [MAP_A]: xmlResponse(modelSitemap([])),
      [MAP_B]: xmlResponse(modelSitemap([])),
      [MAP_C]: xmlResponse(modelSitemap([]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 3, cacheTtlMs: 60_000 });

    await adapter.discover("kagotsel", context({ runId: "run-a", brands: ["kagotsel"] }));
    await adapter.discover("kagotsel", context({ runId: "run-b", brands: ["kagotsel"] }));

    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("scans every sitemap once for all brands in the same run", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B])),
      [MAP_A]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/kagotsel--111",
        "https://reviews.yandex.ru/product/ingavirin--112"
      ])),
      [MAP_B]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/kagotsel-tabletki--265149860",
        "https://reviews.yandex.ru/product/ingavirin-kapsuly--265149861"
      ]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 2 });
    const shared = { runId: "run-batch", brands: ["kagotsel", "ingavirin"] } as const;

    const [kagotsel, ingavirin] = await Promise.all([
      adapter.discover("kagotsel", context(shared)),
      adapter.discover("ingavirin", context(shared))
    ]);
    const repeated = await adapter.discover("kagotsel", context(shared));

    expect(kagotsel.map(({ listingId }) => listingId)).toEqual(["111", "265149860"]);
    expect(ingavirin.map(({ listingId }) => listingId)).toEqual(["112", "265149861"]);
    expect(repeated).toEqual(kagotsel);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails the whole brand batch closed and retries it after one unreadable shard", async () => {
    let mapARequests = 0;
    let mapBRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A, MAP_B]));
      if (url === MAP_A) {
        mapARequests += 1;
        return xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/kagotsel--111"]));
      }
      if (url === MAP_B) {
        mapBRequests += 1;
        return mapBRequests === 1
          ? xmlResponse("<html>changed</html>")
          : xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/ingavirin--112"]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 2 });
    const shared = { runId: "run-retry", brands: ["kagotsel", "ingavirin"] } as const;

    await expect(Promise.all([
      adapter.discover("kagotsel", context(shared)),
      adapter.discover("ingavirin", context(shared))
    ])).rejects.toBeInstanceOf(ParserChangedError);
    await expect(adapter.discover("ingavirin", context(shared))).resolves.toMatchObject([
      { listingId: "112", brand: "ingavirin" }
    ]);

    expect(mapARequests).toBe(2);
    expect(mapBRequests).toBe(2);
  });

  it("fails closed only when the distinct candidate count actually exceeds its cap", async () => {
    const urls = [
      "https://reviews.yandex.ru/product/kagotsel-a--101",
      "https://reviews.yandex.ru/product/kagotsel-b--102",
      "https://reviews.yandex.ru/product/kagotsel-c--103"
    ];
    const exactFetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse(modelSitemap(urls.slice(0, 2)))
    });
    const exact = new YandexAdapter({ fetch: exactFetch, maxCandidates: 2 });
    await expect(exact.discover("Кагоцел", context())).resolves.toHaveLength(2);

    const overflowFetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse(modelSitemap(urls))
    });
    const overflow = new YandexAdapter({ fetch: overflowFetch, maxCandidates: 2 });
    await expect(overflow.discover("Кагоцел", context())).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("returns previous model IDs even when their sitemap slug is unavailable", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse(modelSitemap([]))
    });
    const adapter = new YandexAdapter({ fetch });

    const refs = await adapter.discover("Кагоцел", context({ previousIds: ["265149860"] }));

    expect(refs).toMatchObject([
      {
        listingId: "265149860",
        url: "https://reviews.yandex.ru/product/model--265149860",
        metadata: { discovery: "previous_registry" }
      }
    ]);
  });

  it("reports sitemap parser drift through healthCheck", async () => {
    const adapter = new YandexAdapter({ fetch: routeFetch({ [INDEX]: xmlResponse("<html>changed</html>") }) });

    const health = await adapter.healthCheck(context());

    expect(health.ok).toBe(false);
    expect(health.message).toContain("shape changed");
  });

  it("retries transient sitemap 5xx responses and then completes discovery", async () => {
    let indexRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) {
        indexRequests += 1;
        return indexRequests === 1
          ? new Response("temporary", { status: 503 })
          : xmlResponse(sitemapIndex([MAP_A]));
      }
      if (url === MAP_A) {
        return xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/kagotsel--265149860"]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({
      fetch,
      sitemapRetryBaseMs: 0,
      sleep: async () => undefined
    });

    const refs = await adapter.discover("kagotsel", context());

    expect(refs.map(({ listingId }) => listingId)).toEqual(["265149860"]);
    expect(indexRequests).toBe(2);
  });

  it("retries a transient sitemap 429 instead of switching away from the free collector", async () => {
    let modelCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      if (url === MAP_A) {
        modelCalls += 1;
        return modelCalls === 1
          ? new Response("rate limited", { status: 429 })
          : xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/kagotsel--265149860"]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("Кагоцел", context())).resolves.toMatchObject([
      { listingId: "265149860" }
    ]);
    expect(modelCalls).toBe(2);
  });

  it("retries a bounded sitemap body-read timeout without masking valid XML", async () => {
    let modelRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      if (url === MAP_A) {
        modelRequests += 1;
        return modelRequests === 1
          ? hangingXmlResponse()
          : xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/kagotsel--265149860"]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({
      fetch,
      sitemapReadTimeoutMs: 5,
      sitemapRetryBaseMs: 0,
      sleep: async () => undefined
    });

    await expect(adapter.discover("kagotsel", context())).resolves.toHaveLength(1);
    expect(modelRequests).toBe(2);
  });

  it("treats a missing model sitemap shard as an empty urlset", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: new Response("missing", { status: 404 })
    });
    const adapter = new YandexAdapter({ fetch, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("kagotsel", context())).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an invalid successful model sitemap as parser_changed without retrying it", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse("<html>changed</html>")
    });
    const adapter = new YandexAdapter({
      fetch,
      sitemapRetryAttempts: 3,
      sitemapRetryBaseMs: 0
    });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(ParserChangedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not turn a truncated model sitemap into exhaustive no_results", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse("<?xml version=\"1.0\"?><urlset><url><loc>https://reviews.yandex.ru/product/other--999</loc></url>")
    });
    const adapter = new YandexAdapter({ fetch, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(ParserChangedError);
  });
});

describe("YandexAdapter collection", () => {
  it("uses source-bound reviewed product titles to resolve one exact Khondrofen variant", async () => {
    const listingId = "5829843760";
    const url = `https://reviews.yandex.ru/product/khondrofen-maz-d-nar-prim--${listingId}`;
    const html = productHtml({
      canonical: url,
      product: {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Хондрофен мазь д/нар.прим.",
        brand: "Хондрофен",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 5, ratingCount: 5, ratingValue: 4.9 }
      }
    }).replace("</body>", `
      <div class="Review-Text">Комментарий с ложным соседним вариантом 50 г</div>
      <div class="Review-ReasonToTrustText">Товар — Хондрофен мазь для наружного применения 30 г 1 шт</div>
      <script>window.__STATE__={"reasonToTrust":{"text":"Товар — Хондрофен мазь для наружного применения 30 г 1 шт"}}</script>
    </body>`);
    const adapter = new YandexAdapter({ fetch: routeFetch({ [url]: htmlResponse(html) }) });

    const observation = await adapter.collect(ref({ listingId, brand: "Хондрофен", url }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl,
      evidence: observation.productEvidence
    });

    expect(observation).toMatchObject({ reviews: 5, rating: 4.9, status: "ok" });
    expect(observation.productEvidence?.signals).toContainEqual({
      source: "json_ld",
      text: "Хондрофен мазь для наружного применения 30 г 1 шт"
    });
    expect(identity).toMatchObject({
      label: "мазь 30 г №1",
      granularity: "variant",
      confidence: "exact"
    });
    expect(identity.label).not.toContain("50 г");
  });

  it("does not merge conflicting source-bound Yandex product variants", async () => {
    const listingId = "5829843760";
    const url = `https://reviews.yandex.ru/product/khondrofen-maz-d-nar-prim--${listingId}`;
    const html = productHtml({
      canonical: url,
      product: {
        "@type": "Product",
        name: "Хондрофен мазь д/нар.прим.",
        brand: "Хондрофен",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 2, ratingValue: 5 }
      }
    }).replace("</body>", `
      <div class="Review-ReasonToTrustText">Товар — Хондрофен мазь для наружного применения 30 г 1 шт</div>
      <div class="Review-ReasonToTrustText">Товар — Хондрофен мазь для наружного применения 50 г 1 шт</div>
    </body>`);
    const adapter = new YandexAdapter({ fetch: routeFetch({ [url]: htmlResponse(html) }) });

    const observation = await adapter.collect(ref({ listingId, brand: "Хондрофен", url }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl,
      evidence: observation.productEvidence
    });

    expect(identity).toMatchObject({ granularity: "unresolved", confidence: "ambiguous" });
  });

  it("collects reviewCount (not ratingCount), rating and canonical model URL from Product JSON-LD", async () => {
    const url = "https://reviews.yandex.ru/product/kagotsel--265149860?utm_source=test";
    const fetch = routeFetch({
      [url.replace("?utm_source=test", "")]: htmlResponse(
        productHtml({
          canonical: "https://reviews.yandex.ru/product/kagotsel--265149860?utm_source=search",
          product: {
            "@context": "https://schema.org",
            "@type": "Product",
            name: "Кагоцел таблетки 12 мг №20",
            brand: { "@type": "Brand", name: "Кагоцел" },
            aggregateRating: {
              "@type": "AggregateRating",
              ratingValue: "4,7",
              ratingCount: "1 827",
              reviewCount: "711",
              bestRating: "5"
            }
          }
        })
      )
    });
    const adapter = new YandexAdapter({ fetch, now: () => new Date("2026-07-13T09:00:00.000Z") });

    const result = await adapter.collect(ref({ url }), context());

    expect(result).toMatchObject({
      listingId: "265149860",
      product: "Кагоцел таблетки 12 мг №20",
      canonicalUrl: "https://reviews.yandex.ru/product/kagotsel--265149860",
      reviews: 711,
      ratingCount: 1827,
      rating: 4.7,
      rawRating: 4.7,
      rawRatingScale: 5,
      status: "ok",
      capturedAt: "2026-07-13T09:00:00.000Z",
      source: "yandex_reviews_json_ld"
    });
  });

  it("recovers a cloud-blocked product through the fixed translated numeric route", async () => {
    const modelId = "695943742";
    const directUrl = `https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-10-sht--${modelId}`;
    const translatedUrl = `https://reviews-yandex-ru.translate.goog/product/${modelId}?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`;
    const canonical = `https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-10-sht--${modelId}`;
    const fetch = routeFetch({
      [directUrl]: new Response("blocked", { status: 403 }),
      [translatedUrl]: htmlResponse(translatedProductHtml({
        source: `https://reviews.yandex.ru/product/${modelId}`,
        canonical,
        product: {
          "@context": "https://schema.org",
          "@type": "Product",
          name: "Кагоцел, таблетки 12 мг, 10 шт.",
          brand: { "@type": "Brand", name: "Без бренда" },
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: "5.0",
            ratingCount: "7",
            reviewCount: "2"
          }
        }
      }))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ listingId: modelId, url: directUrl }), context())).resolves.toMatchObject({
      listingId: modelId,
      canonicalUrl: canonical,
      reviews: 2,
      ratingCount: 7,
      rating: 5,
      status: "ok",
      source: "yandex_reviews_json_ld_google_translate"
    });
    expect(fetch.mock.calls.map(([input]) => input)).toEqual([directUrl, translatedUrl]);
  });

  it("binds translated metrics to the Product identifying the requested model", async () => {
    const modelId = "695943742";
    const directUrl = `https://reviews.yandex.ru/product/kagotsel--${modelId}`;
    const translatedUrl = `https://reviews-yandex-ru.translate.goog/product/${modelId}?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`;
    const fetch = routeFetch({
      [directUrl]: new Response("blocked", { status: 403 }),
      [translatedUrl]: htmlResponse(translatedProductHtml({
        source: `https://reviews.yandex.ru/product/${modelId}`,
        canonical: directUrl,
        product: [
          {
            "@type": "Product",
            url: "https://reviews.yandex.ru/product/unrelated--999999999",
            name: "Соседний товар",
            aggregateRating: { "@type": "AggregateRating", ratingValue: 1, reviewCount: 999 }
          },
          {
            "@type": "Product",
            url: directUrl,
            name: "Кагоцел, таблетки 12 мг, 10 шт.",
            aggregateRating: { "@type": "AggregateRating", ratingValue: 5, reviewCount: 2 }
          }
        ]
      }))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ listingId: modelId, url: directUrl }), context())).resolves.toMatchObject({
      product: "Кагоцел, таблетки 12 мг, 10 шт.",
      reviews: 2,
      rating: 5
    });
  });

  it("never turns a partial translated Product without AggregateRating into zero reviews", async () => {
    const modelId = "695943742";
    const directUrl = `https://reviews.yandex.ru/product/kagotsel--${modelId}`;
    const translatedUrl = `https://reviews-yandex-ru.translate.goog/product/${modelId}?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`;
    const partial = `<html><head><base href="https://reviews.yandex.ru/product/${modelId}"><link rel="canonical" href="${directUrl}"><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Кагоцел"
    })}</script></head>`;
    const fetch = routeFetch({
      [directUrl]: new Response("blocked", { status: 403 }),
      [translatedUrl]: htmlResponse(partial)
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ listingId: modelId, url: directUrl }), context()))
      .rejects.toThrow(/incomplete HTML/);
  });

  it("requires explicit zero-review proof on a complete translated Product without AggregateRating", async () => {
    const modelId = "695943742";
    const directUrl = `https://reviews.yandex.ru/product/kagotsel--${modelId}`;
    const translatedUrl = `https://reviews-yandex-ru.translate.goog/product/${modelId}?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`;
    const fetch = routeFetch({
      [directUrl]: new Response("blocked", { status: 403 }),
      [translatedUrl]: htmlResponse(translatedProductHtml({
        source: `https://reviews.yandex.ru/product/${modelId}`,
        canonical: directUrl,
        product: { "@type": "Product", name: "Кагоцел" }
      }))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ listingId: modelId, url: directUrl }), context()))
      .rejects.toThrow(/explicit zero-review proof/);
  });

  it("fails closed when the translated renderer cannot prove the exact source model", async () => {
    const modelId = "695943742";
    const directUrl = `https://reviews.yandex.ru/product/kagotsel--${modelId}`;
    const translatedUrl = `https://reviews-yandex-ru.translate.goog/product/${modelId}?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`;
    const fetch = routeFetch({
      [directUrl]: new Response("blocked", { status: 403 }),
      [translatedUrl]: htmlResponse(translatedProductHtml({
        source: "https://reviews.yandex.ru/product/265149860",
        canonical: directUrl,
        product: {
          "@type": "Product",
          name: "Кагоцел",
          aggregateRating: { "@type": "AggregateRating", ratingValue: 5, reviewCount: 2 }
        }
      }))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ listingId: modelId, url: directUrl }), context()))
      .rejects.toThrow(/different source page/);
  });

  it("finds Product inside @graph and falls back to its title for brand validation", async () => {
    const fetch = productFetch({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "BreadcrumbList", name: "crumbs" },
        {
          "@type": ["Thing", "Product"],
          name: "Кагоцел таблетки",
          brand: { name: "Ниармедик" },
          aggregateRating: { "@type": "AggregateRating", reviewCount: 10, ratingValue: 4, bestRating: 5 }
        }
      ]
    });
    const adapter = new YandexAdapter({ fetch });

    const result = await adapter.collect(ref(), context());

    expect(result.status).toBe("ok");
    expect(result.reviews).toBe(10);
  });

  it("marks a product as needs_review when neither structured brand nor title matches", async () => {
    const adapter = new YandexAdapter({
      fetch: productFetch({
        "@type": "Product",
        name: "Ингавирин 90 мг",
        brand: "Ингавирин",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 3, ratingValue: 5 }
      })
    });

    const result = await adapter.collect(ref(), context());

    expect(result.status).toBe("needs_review");
    expect(result.reviews).toBe(3);
  });

  it("represents a Product without AggregateRating as a confirmed no-review card", async () => {
    const adapter = new YandexAdapter({
      fetch: productFetch({ "@type": "Product", name: "Кагоцел", brand: "Кагоцел" })
    });

    const result = await adapter.collect(ref(), context());

    expect(result).toMatchObject({ reviews: 0, rating: null, ratingCount: null, status: "no_reviews" });
  });

  it("keeps a default AggregateRating only as raw evidence when reviewCount is zero", async () => {
    const brand = ref().brand;
    const adapter = new YandexAdapter({
      fetch: productFetch({
        "@type": "Product",
        name: brand,
        brand,
        aggregateRating: {
          "@type": "AggregateRating",
          reviewCount: 0,
          ratingCount: 0,
          ratingValue: 5,
          bestRating: 5
        }
      })
    });

    const result = await adapter.collect(ref(), context());

    expect(result).toMatchObject({
      reviews: 0,
      rating: null,
      rawRating: 5,
      ratingCount: 0,
      status: "no_reviews"
    });
  });

  it("accepts a confirmed ratingCount when reviewCount is absent", async () => {
    const adapter = new YandexAdapter({
      fetch: productFetch({
        "@type": "Product",
        name: "Кагоцел",
        aggregateRating: { "@type": "AggregateRating", ratingCount: 1827, ratingValue: 4.7 }
      })
    });

    await expect(adapter.collect(ref(), context())).resolves.toMatchObject({
      reviews: null,
      ratingCount: 1827,
      rating: 4.7,
      status: "ok"
    });
  });

  it("detects missing JSON-LD and invalid rating shapes as parser drift", async () => {
    const noJsonLd = new YandexAdapter({
      fetch: routeFetch({ [ref().url]: htmlResponse("<html><title>Кагоцел</title></html>") })
    });
    const invalidRating = new YandexAdapter({
      fetch: productFetch({
        "@type": "Product",
        name: "Кагоцел",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 2, ratingValue: 6, bestRating: 5 }
      })
    });

    await expect(noJsonLd.collect(ref(), context())).rejects.toBeInstanceOf(ParserChangedError);
    await expect(invalidRating.collect(ref(), context())).rejects.toThrow(/outside its declared scale/);
  });

  it("distinguishes block pages and missing models", async () => {
    const numericUrl = "https://reviews.yandex.ru/product/265149860";
    const blocked = new YandexAdapter({
      fetch: routeFetch({ [ref().url]: htmlResponse("<html><title>Ой!</title><div class='smart-captcha'></div></html>") })
    });
    const missing = new YandexAdapter({
      fetch: routeFetch({
        [ref().url]: new Response("missing", { status: 404 }),
        [numericUrl]: new Response("gone", { status: 410 })
      }),
      now: () => new Date("2026-07-13T09:00:00.000Z")
    });

    await expect(blocked.collect(ref(), context())).rejects.toBeInstanceOf(AdapterBlockedError);
    await expect(missing.collect(ref(), context())).resolves.toMatchObject({
      status: "not_found",
      reviews: null,
      rating: null,
      source: "yandex_reviews_missing_candidate",
      capturedAt: "2026-07-13T09:00:00.000Z"
    });
  });

  it("checks the numeric Reviews route before treating a model-route 404 as stale", async () => {
    const modelUrl = "https://reviews.yandex.ru/product/model--265149860";
    const numericUrl = "https://reviews.yandex.ru/product/265149860";
    const brand = ref().brand;
    const fetch = routeFetch({
      [modelUrl]: new Response("missing", { status: 404 }),
      [numericUrl]: htmlResponse(productHtml({
        canonical: modelUrl,
        product: {
          "@type": "Product",
          name: brand,
          brand,
          aggregateRating: { "@type": "AggregateRating", reviewCount: 4, ratingValue: 4.75 }
        }
      }))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ url: modelUrl }), context())).resolves.toMatchObject({
      listingId: "265149860",
      reviews: 4,
      rating: 4.8,
      status: "ok"
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the fixed numeric Reviews route when model--ID resets and recognizes its missing page", async () => {
    const modelUrl = "https://reviews.yandex.ru/product/model--265149860";
    const numericUrl = "https://reviews.yandex.ru/product/265149860";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === modelUrl) throw new TypeError("fetch failed");
      if (url === numericUrl) return htmlResponse("<html><h1>Такой страницы нет</h1></html>");
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ url: modelUrl }), context())).resolves.toMatchObject({
      listingId: "265149860",
      reviews: null,
      rating: null,
      status: "not_found",
      source: "yandex_reviews_missing_candidate"
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fetch an arbitrary URL supplied in a ProductRef", async () => {
    const safeUrl = "https://reviews.yandex.ru/product/model--265149860";
    const fetch = routeFetch({
      [safeUrl]: htmlResponse(
        productHtml({
          canonical: safeUrl,
          product: {
            "@type": "Product",
            name: "Кагоцел",
            aggregateRating: { "@type": "AggregateRating", reviewCount: 1, ratingValue: 5 }
          }
        })
      )
    });
    const adapter = new YandexAdapter({ fetch });

    await adapter.collect(ref({ url: "https://attacker.example/product--265149860" }), context());

    expect(fetch.mock.calls[0][0]).toBe(safeUrl);
  });

});

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { region: "Москва", ...overrides };
}

function ref(overrides: Partial<ProductRef> = {}): ProductRef {
  return {
    domain: "market.yandex.ru",
    platform: "yandex",
    listingId: "265149860",
    brand: "Кагоцел",
    url: "https://reviews.yandex.ru/product/kagotsel--265149860",
    metadata: {},
    ...overrides
  };
}

function productFetch(product: unknown) {
  return routeFetch({
    [ref().url]: htmlResponse(productHtml({ canonical: ref().url, product }))
  });
}

function routeFetch(routes: Record<string, Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = routes[url];
    if (!response) throw new Error(`Unexpected URL: ${url}`);
    return response.clone();
  }) as unknown as ReturnType<typeof vi.fn> & typeof globalThis.fetch;
}

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

function hangingXmlResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    cancel: () => undefined
  }), { status: 200, headers: { "content-type": "application/xml" } });
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function sitemapIndex(urls: string[]): string {
  return `<?xml version="1.0"?><sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;
}

function modelSitemap(urls: string[]): string {
  return `<?xml version="1.0"?><urlset>${urls.map((url) => `<url><loc><![CDATA[${url}]]></loc></url>`).join("")}</urlset>`;
}

function productHtml({ canonical, product }: { canonical: string; product: unknown }): string {
  return `<!doctype html><html><head><link href="${canonical}" rel="canonical"><script type="application/ld+json">${JSON.stringify(product)}</script></head><body></body></html>`;
}

function translatedProductHtml({
  source,
  canonical,
  product
}: {
  source: string;
  canonical: string;
  product: unknown;
}): string {
  return `<!doctype html><html><head><base href="${source}"><link href="${canonical}" rel="canonical"><script type="application/ld+json">${JSON.stringify(product)}</script></head><body></body></html>`;
}
