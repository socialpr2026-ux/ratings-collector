import { describe, expect, it, vi } from "vitest";

import type { AdapterContext, ProductRef } from "../src/shared/types.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { YandexAdapter } from "../src/server/adapters/yandex.js";

const INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const MAP_A = "https://reviews.yandex.ru/ugcpub/sitemap_model_0-9999999-0.xml";
const MAP_B = "https://reviews.yandex.ru/ugcpub/sitemap_model_260000000-269999999-0.xml";
const MAP_C = "https://reviews.yandex.ru/ugcpub/sitemap_model_500000000-509999999-0.xml";

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

  it("scans an index exactly at the cap and reuses cached responses", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B, MAP_C])),
      [MAP_A]: xmlResponse(modelSitemap([])),
      [MAP_B]: xmlResponse(modelSitemap([])),
      [MAP_C]: xmlResponse(modelSitemap([]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 3, cacheTtlMs: 60_000 });

    await adapter.discover("Кагоцел", context());
    await adapter.discover("Кагоцел", context());

    expect(fetch).toHaveBeenCalledTimes(4);
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
});

describe("YandexAdapter collection", () => {
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

  it("never substitutes ratingCount when reviewCount disappears", async () => {
    const adapter = new YandexAdapter({
      fetch: productFetch({
        "@type": "Product",
        name: "Кагоцел",
        aggregateRating: { "@type": "AggregateRating", ratingCount: 1827, ratingValue: 4.7 }
      })
    });

    await expect(adapter.collect(ref(), context())).rejects.toThrow(/ratingCount is not a substitute/);
    await expect(adapter.collect(ref(), context())).rejects.toBeInstanceOf(ParserChangedError);
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
