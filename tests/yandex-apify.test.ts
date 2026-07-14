import { afterEach, describe, expect, it, vi } from "vitest";

import { observationSchema, type AdapterContext } from "../src/shared/types.js";
import {
  createYandexApifyAdapter,
  isYandexApifyRef,
  YandexApifyAdapter,
  type YandexApifyAdapterOptions
} from "../src/server/adapters/yandex-apify.js";
import {
  AdapterBlockedError,
  AdapterQuotaError,
  ParserChangedError
} from "../src/server/adapters/errors.js";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const CONTEXT: AdapterContext = { region: "Москва" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function reviewsResponse(overrides: {
  listingId?: string;
  title?: string;
  reviewCount?: number;
  ratingValue?: number;
  status?: number;
} = {}): Response {
  const listingId = overrides.listingId ?? "265149860";
  const title = overrides.title ?? String(product().title);
  const reviewCount = overrides.reviewCount ?? 711;
  const ratingValue = overrides.ratingValue ?? 4.7;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: title,
    aggregateRating: {
      "@type": "AggregateRating",
      reviewCount,
      ratingCount: reviewCount + 1_000,
      ratingValue,
      bestRating: 5
    }
  };
  return new Response(
    `<html><head><link rel="canonical" href="https://reviews.yandex.ru/product/model--${listingId}"><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head></html>`,
    { status: overrides.status ?? 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function options(overrides: Partial<YandexApifyAdapterOptions> = {}): YandexApifyAdapterOptions {
  return {
    token: "test-token",
    maxItems: 10,
    maxTotalChargeUsd: 0.08,
    timeoutSeconds: 120,
    reviewsFetch: vi.fn(async () => reviewsResponse()),
    now: () => NOW,
    ...overrides
  };
}

function product(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 265149860,
    title: "Кагоцел таблетки 12 мг, 20 шт.",
    canonicalUrl: "https://market.yandex.ru/product--kagotsel/265149860?utm_source=test",
    rating: 4.7,
    reviewCount: 711,
    ratingCount: 1827,
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("YandexApifyAdapter discovery", () => {
  it("uses the bounded enriched Moscow input, Bearer auth and deduplicates by modelId", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      product(),
      product({
        canonicalUrl: undefined,
        productUrl: "https://market.yandex.ru/product--kagotsel/265149860?sku=offer-1",
        rating: 1.2,
        reviewCount: 999
      }),
      product({
        modelId: 999,
        title: "Ингавирин капсулы 90 мг",
        canonicalUrl: "https://market.yandex.ru/product--ingavirin/999",
        rating: 4.9,
        reviewCount: 20
      })
    ]));
    const adapter = new YandexApifyAdapter(
      options({ fetch: fetchSpy as unknown as typeof fetch })
    );

    const refs = await adapter.discover("Кагоцел", CONTEXT);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      domain: "market.yandex.ru",
      platform: "yandex",
      listingId: "265149860",
      brand: "Кагоцел",
      url: "https://reviews.yandex.ru/product/model--265149860",
      title: "Кагоцел таблетки 12 мг, 20 шт.",
      metadata: {
        duplicateCount: 2,
        collector: "yandex-apify",
        capturedAt: NOW.toISOString(),
        source: "apify:zen-studio/yandex-market-scraper-parser:enriched"
      }
    });
    expect(refs[0].metadata).not.toHaveProperty("rating");
    expect(refs[0].metadata).not.toHaveProperty("reviewCount");
    expect(refs[0].metadata).not.toHaveProperty("ratingCount");
    expect(isYandexApifyRef(refs[0])).toBe(true);
    expect(isYandexApifyRef({
      ...refs[0],
      metadata: { ...refs[0].metadata, collector: "yandex-sitemap" }
    })).toBe(false);

    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(request));
    expect(url.pathname).toBe(
      "/v2/acts/zen-studio~yandex-market-scraper-parser/run-sync-get-dataset-items"
    );
    expect(url.searchParams.get("maxItems")).toBe("10");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("maxTotalChargeUsd")).toBe("0.08");
    expect(url.searchParams.get("timeout")).toBe("120");
    expect(url.searchParams.get("token")).toBeNull();
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      query: "Кагоцел",
      maxItems: 10,
      region: "213",
      enrichProducts: true,
      includeReviews: false
    });

    const observation = await adapter.collect(refs[0], CONTEXT);
    expect(observation).toMatchObject({
      listingId: "265149860",
      reviews: 711,
      rating: 4.7,
      status: "ok"
    });
    expect(observation.ratingCount).toBe(1711);
    expect(() => observationSchema.parse(observation)).not.toThrow();
  });

  it("uses the fixed Reviews model URL and preserves a confirmed zero", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      product({
        modelId: "000101",
        canonicalUrl: undefined,
        productUrl: "https://market.yandex.ru/card/kagotsel-tabletki/103543299313?sku=abc&utm_source=x",
        reviewCount: "0",
        rating: 5
      })
    ]));
    const reviewsFetch = vi.fn(async () => new Response(
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: String(product().title)
      })}</script>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
    ));
    const adapter = new YandexApifyAdapter(
      options({
        fetch: fetchSpy as unknown as typeof fetch,
        reviewsFetch: reviewsFetch as unknown as typeof fetch
      })
    );

    const [ref] = await adapter.discover("Кагоцел", CONTEXT);
    const observation = await adapter.collect(ref, CONTEXT);

    expect(ref).toMatchObject({
      listingId: "101",
      url: "https://reviews.yandex.ru/product/model--101"
    });
    expect(observation).toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
  });

  it("never substitutes ratingCount when written-review count is unavailable", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      product({ reviewCount: undefined, ratingCount: 1827 })
    ]));
    const adapter = new YandexApifyAdapter(
      options({ fetch: fetchSpy as unknown as typeof fetch })
    );

    const discovery = adapter.discover("Кагоцел", CONTEXT);
    await expect(discovery).rejects.toBeInstanceOf(ParserChangedError);
    await expect(discovery).rejects.toThrow("ratingCount is not a substitute");
  });

  it("keeps valid cards when one matching actor item lacks reviewCount", async () => {
    const requestedBrand = String(product().title).split(" ")[0];
    const fetchSpy = vi.fn(async () => jsonResponse([
      product(),
      product({
        modelId: 5703095086,
        canonicalUrl: "https://market.yandex.ru/product--kagotsel/5703095086",
        reviewCount: undefined,
        ratingCount: 1
      }),
      {
        title: "Unrelated incomplete search result"
      }
    ]));
    const adapter = new YandexApifyAdapter(
      options({ fetch: fetchSpy as unknown as typeof fetch })
    );

    const refs = await adapter.discover(requestedBrand, CONTEXT);

    expect(refs).toHaveLength(1);
    expect(refs[0].listingId).toBe("265149860");
    expect(refs[0].metadata).not.toHaveProperty("reviewCount");
    await expect(adapter.collect(refs[0], CONTEXT)).resolves.toMatchObject({
      reviews: 711,
      rating: 4.7
    });
  });

  it("fails closed when the configured item cap is reached", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      product(),
      product({
        modelId: 266,
        canonicalUrl: "https://market.yandex.ru/product--kagotsel/266"
      })
    ]));
    const adapter = new YandexApifyAdapter(options({
      fetch: fetchSpy as unknown as typeof fetch,
      maxItems: 2
    }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterQuotaError);
  });

  it("deduplicates conflicting offer metrics without publishing them", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      product(),
      product({ reviewCount: 710 })
    ]));
    const adapter = new YandexApifyAdapter(
      options({ fetch: fetchSpy as unknown as typeof fetch })
    );

    const [ref] = await adapter.discover("Кагоцел", CONTEXT);
    expect(ref.metadata).toMatchObject({ duplicateCount: 2 });
    expect(ref.metadata).not.toHaveProperty("reviewCount");
    expect(ref.metadata).not.toHaveProperty("rating");
    await expect(adapter.collect(ref, CONTEXT)).resolves.toMatchObject({
      listingId: "265149860",
      reviews: 711,
      rating: 4.7
    });
  });

  it("rejects changed dataset shapes and invalid identities but ignores actor offer URLs", async () => {
    const wrapped = new YandexApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse({ data: { items: [] } })) as unknown as typeof fetch
    }));
    await expect(wrapped.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(ParserChangedError);

    const missingId = new YandexApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse([product({ modelId: undefined })])) as unknown as typeof fetch
    }));
    await expect(missingId.discover("Кагоцел", CONTEXT)).rejects.toThrow("valid modelId");

    const unsafeUrl = new YandexApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse([
        product({ canonicalUrl: "https://evil.example/product--kagotsel/265149860" })
      ])) as unknown as typeof fetch
    }));
    await expect(unsafeUrl.discover("Кагоцел", CONTEXT)).resolves.toMatchObject([{
      listingId: "265149860",
      url: "https://reviews.yandex.ru/product/model--265149860"
    }]);
  });

  it("collects authoritative Reviews JSON-LD through direct fetch, not the sandbox fetch", async () => {
    const actorFetch = vi.fn(async () => jsonResponse([
      product({ rating: 1.1, reviewCount: 999 })
    ]));
    const reviewsFetch = vi.fn(async (_input: Parameters<typeof fetch>[0]) => reviewsResponse({
      reviewCount: 107,
      ratingValue: 4.8
    }));
    const sandboxFetch = vi.fn(async () => {
      throw new Error("sandbox fetch must not be used for Reviews");
    });
    const adapter = new YandexApifyAdapter(options({
      fetch: actorFetch as unknown as typeof fetch,
      reviewsFetch: reviewsFetch as unknown as typeof fetch
    }));
    const [ref] = await adapter.discover("Кагоцел", CONTEXT);

    const observation = await adapter.collect(ref, {
      ...CONTEXT,
      fetch: sandboxFetch as unknown as typeof fetch
    });

    expect(observation).toMatchObject({ reviews: 107, rating: 4.8, status: "ok" });
    expect(reviewsFetch).toHaveBeenCalledTimes(1);
    expect(String(reviewsFetch.mock.calls[0][0])).toBe(
      "https://reviews.yandex.ru/product/model--265149860"
    );
    expect(sandboxFetch).not.toHaveBeenCalled();
  });

  it("retries transient Reviews 429 and 5xx responses within a fixed bound", async () => {
    const actorFetch = vi.fn(async () => jsonResponse([product()]));
    const reviewsFetch = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(reviewsResponse({ reviewCount: 86, ratingValue: 4.8 }));
    const adapter = new YandexApifyAdapter(options({
      fetch: actorFetch as unknown as typeof fetch,
      reviewsFetch: reviewsFetch as unknown as typeof fetch
    }));
    const [ref] = await adapter.discover(String(product().title), CONTEXT);

    await expect(adapter.collect(ref, CONTEXT)).resolves.toMatchObject({
      reviews: 86,
      rating: 4.8,
      status: "ok"
    });
    expect(reviewsFetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed after bounded attempts on all three fixed Reviews routes", async () => {
    const actorFetch = vi.fn(async () => jsonResponse([product()]));
    const reviewsFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const adapter = new YandexApifyAdapter(options({
      fetch: actorFetch as unknown as typeof fetch,
      reviewsFetch: reviewsFetch as unknown as typeof fetch
    }));
    const [ref] = await adapter.discover(String(product().title), CONTEXT);

    await expect(adapter.collect(ref, CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);
    // Each bounded attempt exhausts the model URL, numeric URL and fixed
    // translated numeric URL without turning their access failures into zero.
    expect(reviewsFetch).toHaveBeenCalledTimes(9);
  });

  it("stops Reviews retry backoff immediately when the run is aborted", async () => {
    const actorFetch = vi.fn(async () => jsonResponse([product()]));
    const reviewsFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const adapter = new YandexApifyAdapter(options({
      fetch: actorFetch as unknown as typeof fetch,
      reviewsFetch: reviewsFetch as unknown as typeof fetch
    }));
    const [ref] = await adapter.discover(String(product().title), CONTEXT);
    const controller = new AbortController();
    const collection = adapter.collect(ref, { ...CONTEXT, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    await expect(collection).rejects.toMatchObject({ name: "AbortError" });
    expect(reviewsFetch).toHaveBeenCalledTimes(1);
  });

  it("returns not_found when an actor modelId has no Reviews product page", async () => {
    const actorFetch = vi.fn(async () => jsonResponse([product()]));
    const reviewsFetch = vi.fn(async (_input: Parameters<typeof fetch>[0]) =>
      new Response("not found", { status: 404 })
    );
    const adapter = new YandexApifyAdapter(options({
      fetch: actorFetch as unknown as typeof fetch,
      reviewsFetch: reviewsFetch as unknown as typeof fetch
    }));
    const [ref] = await adapter.discover("Кагоцел", CONTEXT);

    await expect(adapter.collect(ref, CONTEXT)).resolves.toMatchObject({
      listingId: "265149860",
      reviews: null,
      rating: null,
      status: "not_found",
      source: "yandex_reviews_missing_candidate"
    });
    expect(reviewsFetch).toHaveBeenCalledTimes(2);
    expect(reviewsFetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://reviews.yandex.ru/product/model--265149860",
      "https://reviews.yandex.ru/product/265149860"
    ]);
  });
});

describe("YandexApifyAdapter auth, failures and configuration", () => {
  it("reports missing auth and checks actor availability with Bearer auth", async () => {
    vi.stubEnv("APIFY_TOKEN", "");
    const noTokenFetch = vi.fn();
    const noToken = new YandexApifyAdapter({
      fetch: noTokenFetch as unknown as typeof fetch,
      now: () => NOW
    });
    await expect(noToken.healthCheck(CONTEXT)).resolves.toEqual({
      ok: false,
      checkedAt: NOW.toISOString(),
      message: "APIFY_TOKEN is not configured"
    });
    await expect(noToken.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(noTokenFetch).not.toHaveBeenCalled();

    const fetchSpy = vi.fn(async () => jsonResponse({ data: { id: "actor" } }));
    const adapter = createYandexApifyAdapter(
      options({ fetch: fetchSpy as unknown as typeof fetch })
    );
    await expect(adapter.healthCheck(CONTEXT)).resolves.toEqual({
      ok: true,
      checkedAt: NOW.toISOString()
    });
    const [healthRequest, healthInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(healthRequest).toBe(
      "https://api.apify.com/v2/acts/zen-studio~yandex-market-scraper-parser"
    );
    expect(healthInit.headers).toMatchObject({
      Authorization: "Bearer test-token"
    });
  });

  it("maps cost exhaustion and transport failures without leaking the token", async () => {
    const exhausted = new YandexApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse({
        error: { type: "not-enough-usage-to-run-paid-actor", message: "Not enough credits" }
      }, 402)) as unknown as typeof fetch
    }));
    await expect(exhausted.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterQuotaError);

    const offline = new YandexApifyAdapter(options({
      fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch
    }));
    await expect(offline.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("rejects options outside actor and project hard caps", () => {
    expect(() => new YandexApifyAdapter(options({ maxItems: 0 }))).toThrow(RangeError);
    expect(() => new YandexApifyAdapter(options({ maxItems: 2_701 }))).toThrow(RangeError);
    expect(() => new YandexApifyAdapter(options({ maxTotalChargeUsd: 4.51 }))).toThrow(RangeError);
    expect(() => new YandexApifyAdapter(options({ timeoutSeconds: 301 }))).toThrow(RangeError);
    expect(() => new YandexApifyAdapter(options({ apiBaseUrl: "http://api.apify.test" }))).toThrow(TypeError);
  });
});
