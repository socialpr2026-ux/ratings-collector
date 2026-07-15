import { afterEach, describe, expect, it, vi } from "vitest";

import { observationSchema, type AdapterContext, type ProductRef } from "../src/shared/types.js";
import {
  createOzonAdapter,
  OzonAdapter,
  type OzonAdapterOptions
} from "../src/server/adapters/ozon.js";
import {
  AdapterBlockedError,
  AdapterQuotaError,
  ParserChangedError
} from "../src/server/adapters/errors.js";
import { BudgetedAdapter, createSerialExecutor } from "../src/server/adapters/budgeted.js";

const NOW = new Date("2026-07-13T08:00:00.000Z");
const CONTEXT: AdapterContext = { region: "Москва" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function adapterOptions(options: Partial<OzonAdapterOptions> = {}): OzonAdapterOptions {
  return {
    token: "test-token",
    maxResults: 10,
    maxTotalChargeUsd: 0.1,
    timeoutSeconds: 120,
    now: () => NOW,
    ...options
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OzonAdapter discovery", () => {
  it("allows the RU tiles-only actor the full safe 300-second sync window by default", async () => {
    vi.stubEnv("OZON_APIFY_TIMEOUT_SECONDS", "");
    const fetchSpy = vi.fn(async () => jsonResponse([]));
    const adapter = new OzonAdapter({
      token: "test-token",
      maxResults: 10,
      maxTotalChargeUsd: 0.1,
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW
    });

    await adapter.discover("Кагоцел", CONTEXT);

    const [request] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(new URL(String(request)).searchParams.get("timeout")).toBe("300");
  });

  it("calls the RU tiles-only actor with hard result and cost caps, then deduplicates SKU", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          sku: "001 185 261 285",
          productId: 1185261285,
          url: "https://www.ozon.ru/product/citovir-3-kapsuly-1185261285/?utm_source=test&from=share",
          title: "Цитовир-3 капсулы 24 шт.",
          brand: "Цитовир-3",
          rating: "4,9",
          reviewCount: "6 346"
        },
        {
          sku: 1185261285,
          url: "https://www.ozon.ru/product/citovir-3-kapsuly-1185261285/?oos_search=false",
          title: "Цитовир-3 капсулы 24 шт.",
          brand: { name: "Цитовир-3" },
          rating: 4.9,
          reviewCount: 6346,
          sponsored: true
        },
        {
          sku: 999999999,
          url: "https://www.ozon.ru/product/vitamin-c-999999999/",
          title: "Витамин C таблетки",
          rating: 4.8,
          reviewCount: 100
        }
      ])
    );
    const adapter = new OzonAdapter(adapterOptions());

    const refs = await adapter.discover("Цитовир-3", {
      ...CONTEXT,
      fetch: fetchSpy as unknown as typeof fetch
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "1185261285",
      brand: "Цитовир-3",
      url: "https://www.ozon.ru/product/citovir-3-kapsuly-1185261285/",
      title: "Цитовир-3 капсулы 24 шт.",
      metadata: {
        rating: 4.9,
        reviewCount: 6346,
        duplicateCount: 2,
        conflictingMetrics: false,
        discoveryTruncated: false,
        capturedAt: NOW.toISOString(),
        source: "apify:ahaham_bytiz/ozon-scraper:search"
      }
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(request));
    expect(url.pathname).toBe(
      "/v2/acts/ahaham_bytiz~ozon-scraper/run-sync-get-dataset-items"
    );
    expect(url.searchParams.get("maxItems")).toBe("10");
    expect(url.searchParams.get("maxTotalChargeUsd")).toBe("0.1");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("timeout")).toBe("120");
    expect(url.searchParams.get("clean")).toBe("1");
    expect(url.searchParams.get("token")).toBeNull();
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      searchQueries: ["Цитовир-3"],
      maxItems: 10,
      maxPagesPerQuery: 20
    });
  });

  it("batches all run brands into one Actor call and does not reserve again for cached brands", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      {
        sku: 101001,
        url: "https://www.ozon.ru/product/brand-a-101001/",
        title: "Brand A tablets",
        rating: 4.8,
        reviewCount: 10
      },
      {
        sku: 202002,
        url: "https://www.ozon.ru/product/brand-b-202002/",
        title: "Brand B capsules",
        rating: 4.9,
        reviewCount: 20
      },
      {
        sku: 303003,
        url: "https://www.ozon.ru/product/brand-c-303003/",
        title: "Brand C powder",
        rating: 5,
        reviewCount: 30
      }
    ]));
    const usage = vi.fn(async () => 1);
    const inner = new OzonAdapter(adapterOptions({
      fetch: fetchSpy as unknown as typeof fetch,
      maxTotalChargeUsd: 0.15
    }));
    const adapter = new BudgetedAdapter(inner, {
      reservePerDiscovery: 0.15,
      monthlyLimit: 4.5,
      externalUsageUsd: usage,
      runExclusive: createSerialExecutor()
    });
    const batchContext: AdapterContext = {
      runId: "run-batch",
      brands: ["Brand A", "Brand B", "Brand C"],
      region: "Москва",
      month: "2026-07"
    };

    const results = await Promise.all(batchContext.brands!.map((brand) =>
      adapter.discover(brand, batchContext)
    ));

    expect(results.map((refs) => refs.map((ref) => ref.listingId))).toEqual([
      ["101001"], ["202002"], ["303003"]
    ]);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(request));
    expect(url.searchParams.get("maxItems")).toBe("30");
    expect(url.searchParams.get("limit")).toBe("30");
    expect(url.searchParams.get("maxTotalChargeUsd")).toBe("0.15");
    expect(JSON.parse(String(init.body))).toMatchObject({
      searchQueries: ["Brand A", "Brand B", "Brand C"],
      maxItems: 30,
      maxPagesPerQuery: 20
    });
  });

  it("releases a reservation only after the complete Ozon batch proves no matching products", async () => {
    const emptyRelease = vi.fn(async () => undefined);
    const emptyInner = new OzonAdapter(adapterOptions({
      fetch: vi.fn(async () => jsonResponse([])) as unknown as typeof fetch
    }));
    const empty = new BudgetedAdapter(emptyInner, {
      reservePerDiscovery: 0.25,
      monthlyLimit: 4.5,
      reserveCapacityUsd: async () => ({ release: emptyRelease })
    });
    const context: AdapterContext = {
      runId: "run-empty-batch",
      brands: ["Brand A", "Brand B"],
      region: "Moscow",
      month: "2026-07"
    };

    await expect(empty.discover("Brand A", context)).resolves.toEqual([]);
    await expect(empty.discover("Brand B", context)).resolves.toEqual([]);
    expect(emptyRelease).toHaveBeenCalledTimes(1);

    const nonEmptyRelease = vi.fn(async () => undefined);
    const nonEmptyInner = new OzonAdapter(adapterOptions({
      fetch: vi.fn(async () => jsonResponse([{
        sku: 202002,
        url: "https://www.ozon.ru/product/brand-b-202002/",
        title: "Brand B capsules",
        rating: 4.9,
        reviewCount: 20
      }])) as unknown as typeof fetch
    }));
    const nonEmpty = new BudgetedAdapter(nonEmptyInner, {
      reservePerDiscovery: 0.25,
      monthlyLimit: 4.5,
      reserveCapacityUsd: async () => ({ release: nonEmptyRelease })
    });

    await expect(nonEmpty.discover("Brand A", { ...context, runId: "run-non-empty-batch" })).resolves.toEqual([]);
    await expect(nonEmpty.discover("Brand B", { ...context, runId: "run-non-empty-batch" })).resolves.toHaveLength(1);
    expect(nonEmptyRelease).not.toHaveBeenCalled();
  });

  it("couples maxItems to the paid charge cap so truncation remains detectable", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([]));
    const brands = Array.from({ length: 17 }, (_, index) => `Brand ${index + 1}`);
    const adapter = new OzonAdapter(adapterOptions({
      fetch: fetchSpy as unknown as typeof fetch,
      maxResults: 80,
      maxTotalChargeUsd: 0.25
    }));

    await adapter.discover(brands[0], {
      runId: "run-charge-cap",
      brands,
      region: "Москва",
      month: "2026-07"
    });

    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(request));
    expect(url.searchParams.get("maxItems")).toBe("500");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(JSON.parse(String(init.body))).toMatchObject({ maxItems: 500 });
  });

  it("accepts productId and the brand object when SKU and title brand are unavailable", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          productId: "2 651 498 600",
          title: "Таблетки 12 мг, 20 шт.",
          brand: { name: "Кагоцел" },
          rating: "4.7 из 5",
          reviewsCount: "1 234 отзыва"
        }
      ])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    const [ref] = await adapter.discover("Кагоцел", CONTEXT);

    expect(ref.listingId).toBe("2651498600");
    expect(ref.url).toBe("https://www.ozon.ru/product/2651498600/");
    expect(ref.metadata).toMatchObject({ rating: 4.7, reviewCount: 1234 });
  });

  it("rejects Kazakhstan cards instead of relabeling them as Russian cards", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([{
        sku: 123456789,
        url: "https://ozon.kz/product/wrong-product-987654321/",
        title: "Кагоцел таблетки",
        rating: 4.8,
        reviewsCount: 10
      }])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(
      ParserChangedError
    );
  });

  it("filters search noise with token-aware shared brand matching", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          sku: 123456789,
          url: "https://www.ozon.ru/product/superkagocel-123456789/",
          title: "Суперкагоцел комплекс",
          rating: 5,
          reviewCount: 5
        }
      ])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).resolves.toEqual([]);
  });

  it("skips an incomplete service item but fails closed when every item has lost its title", async () => {
    const validProduct = {
      sku: 123456789,
      url: "https://www.ozon.ru/product/kagocel-123456789/",
      title: "Кагоцел таблетки",
      rating: 4.8,
      reviewCount: 100
    };
    const incompleteServiceItem = {
      sku: 999999999,
      url: "https://www.ozon.ru/product/999999999/",
      itemType: "diagnostic"
    };
    const mixedFetch = vi.fn(async () => jsonResponse([incompleteServiceItem, validProduct]));
    const mixedAdapter = new OzonAdapter(
      adapterOptions({ fetch: mixedFetch as unknown as typeof fetch })
    );

    await expect(mixedAdapter.discover("Кагоцел", CONTEXT)).resolves.toMatchObject([
      { listingId: "123456789", title: "Кагоцел таблетки" }
    ]);

    const driftFetch = vi.fn(async () => jsonResponse([incompleteServiceItem, { metadata: true }]));
    const driftAdapter = new OzonAdapter(
      adapterOptions({ fetch: driftFetch as unknown as typeof fetch })
    );

    await expect(driftAdapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(
      ParserChangedError
    );
  });

  it("expands a column-oriented dataset item without mixing product metrics", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([{
        sku: [123456789, 123456790],
        url: [
          "https://www.ozon.ru/product/baktoblis-123456789/",
          "https://www.ozon.ru/product/baktoblis-duo-123456790/"
        ],
        title: ["БактоБЛИС таблетки №30", "Бактоблис Дуо №10"],
        brand: [null, "Бактоблис"],
        rating: [4.8, 5],
        reviewCount: [6448, 9]
      }])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    const refs = await adapter.discover("Бактоблис", CONTEXT);

    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => [ref.listingId, ref.metadata.reviewCount, ref.metadata.rating])).toEqual([
      ["123456789", 6448, 4.8],
      ["123456790", 9, 5]
    ]);
  });

  it("fails closed when column-oriented actor arrays have different lengths", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([{
        sku: [123456789, 123456790],
        url: ["https://www.ozon.ru/product/baktoblis-123456789/"],
        title: ["БактоБЛИС таблетки №30", "Бактоблис Дуо №10"],
        rating: [4.8, 5],
        reviewCount: [6448, 9]
      }])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.discover("Бактоблис", CONTEXT)).rejects.toThrow(
      "column arrays with different lengths"
    );
  });

  it("marks duplicate metric disagreements for manual review instead of choosing silently", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          sku: 123456789,
          url: "https://www.ozon.ru/product/kagocel-123456789/",
          title: "Кагоцел таблетки",
          rating: 4.8,
          reviewCount: 100
        },
        {
          sku: 123456789,
          url: "https://www.ozon.ru/product/kagocel-123456789/",
          title: "Кагоцел таблетки",
          rating: 4.7,
          reviewCount: 101
        }
      ])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    const [ref] = await adapter.discover("Кагоцел", CONTEXT);
    const observation = await adapter.collect(ref, CONTEXT);

    expect(ref.metadata).toMatchObject({ conflictingMetrics: true, duplicateCount: 2 });
    expect(observation.status).toBe("needs_review");
  });

  it("marks ID disagreements for review when discovery is complete", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          sku: 123456789,
          productId: 987654321,
          url: "https://www.ozon.ru/product/kagocel-123456789/",
          title: "Кагоцел таблетки",
          rating: 4.8,
          reviewCount: 100
        }
      ])
    );
    const adapter = new OzonAdapter(
      adapterOptions({ maxResults: 2, fetch: fetchSpy as unknown as typeof fetch })
    );

    const [ref] = await adapter.discover("Кагоцел", CONTEXT);
    const observation = await adapter.collect(ref, CONTEXT);

    expect(ref.metadata).toMatchObject({ idConflict: true, discoveryTruncated: false });
    expect(observation.status).toBe("needs_review");
  });

  it("fails closed when the Actor result cap is reached with matching products", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          sku: 123456789,
          url: "https://www.ozon.ru/product/kagocel-123456789/",
          title: "Кагоцел таблетки",
          rating: 4.8,
          reviewCount: 100
        }
      ])
    );
    const adapter = new OzonAdapter(
      adapterOptions({ maxResults: 1, fetch: fetchSpy as unknown as typeof fetch })
    );

    const discovery = adapter.discover("Кагоцел", CONTEXT);
    await expect(discovery).rejects.toThrow(
      "complete discovery was not proven"
    );
    await expect(discovery).rejects.toBeInstanceOf(AdapterQuotaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OzonAdapter observations", () => {
  it("creates a schema-valid ok observation from tile metrics", async () => {
    const adapter = createOzonAdapter(adapterOptions());
    const ref: ProductRef = {
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "265149860",
      brand: "Кагоцел",
      url: "https://ozon.ru/product/kagocel-tabletki-265149860/?utm_source=x",
      title: "Кагоцел таблетки 12 мг 20 шт.",
      metadata: {
        rating: 4.86,
        reviewCount: 321,
        capturedAt: NOW.toISOString(),
        source: "fixture"
      }
    };

    const observation = await adapter.collect(ref, CONTEXT);

    expect(observation).toEqual({
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "265149860",
      brand: "Кагоцел",
      canonicalUrl: "https://www.ozon.ru/product/kagocel-tabletki-265149860/",
      product: "Кагоцел таблетки 12 мг 20 шт.",
      reviews: 321,
      rating: 4.86,
      rawRating: 4.86,
      rawRatingScale: 5,
      status: "ok",
      capturedAt: NOW.toISOString(),
      source: "fixture"
    });
    expect(() => observationSchema.parse(observation)).not.toThrow();
  });

  it("keeps a confirmed zero-review product and blanks its rating", async () => {
    const adapter = new OzonAdapter(adapterOptions());
    const ref: ProductRef = {
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "123456789",
      brand: "Анаферон",
      url: "https://www.ozon.ru/product/anaferon-123456789/",
      title: "Анаферон таблетки",
      metadata: { rating: 5, reviewCount: 0 }
    };

    const observation = await adapter.collect(ref, CONTEXT);

    expect(observation).toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
  });

  it("blanks Ozon's zero sentinel when reviews exist but no aggregate rating is displayed", async () => {
    const adapter = new OzonAdapter(adapterOptions());
    const observation = await adapter.collect({
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "1140465214",
      brand: "Бактоблис",
      url: "https://www.ozon.ru/product/baktoblis-1140465214/",
      title: "БактоБЛИС порошок 15 саше",
      metadata: { rating: 0, reviewCount: 2 }
    }, CONTEXT);

    expect(observation).toMatchObject({
      reviews: 2,
      rating: null,
      rawRating: 0,
      ratingUnavailable: true,
      status: "ok"
    });
  });

  it("does not auto-approve a zero-review product with conflicting evidence", async () => {
    const adapter = new OzonAdapter(adapterOptions());
    const ref: ProductRef = {
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "123456789",
      brand: "Бактоблис",
      url: "https://www.ozon.ru/product/other-product-123456789/",
      title: "Другой препарат",
      metadata: { rating: 5, reviewCount: 0, conflictingMetrics: true }
    };

    const observation = await adapter.collect(ref, CONTEXT);

    expect(observation).toMatchObject({ reviews: 0, rating: null, status: "needs_review" });
  });

  it("requires review when metrics are missing or the title no longer matches the brand", async () => {
    const adapter = new OzonAdapter(adapterOptions());
    const ref: ProductRef = {
      domain: "ozon.ru",
      platform: "ozon",
      listingId: "123456789",
      brand: "Анаферон",
      url: "https://www.ozon.ru/product/drug-123456789/",
      title: "Другой препарат",
      metadata: { reviewCount: 10 }
    };

    const observation = await adapter.collect(ref, CONTEXT);

    expect(observation).toMatchObject({ reviews: 10, rating: null, status: "needs_review" });
  });
});

describe("OzonAdapter failures and health", () => {
  it("reports a missing token without making a request", async () => {
    vi.stubEnv("APIFY_TOKEN", "");
    const fetchSpy = vi.fn();
    const adapter = new OzonAdapter({ fetch: fetchSpy as unknown as typeof fetch, now: () => NOW });

    await expect(adapter.healthCheck(CONTEXT)).resolves.toEqual({
      ok: false,
      checkedAt: NOW.toISOString(),
      message: "APIFY_TOKEN is not configured"
    });
    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks actor availability without starting a paid run", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: { id: "actor" } }));
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.healthCheck(CONTEXT)).resolves.toEqual({
      ok: true,
      checkedAt: NOW.toISOString()
    });
    const [request, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(request)).toBe(
      "https://api.apify.com/v2/acts/ahaham_bytiz~ozon-scraper"
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("maps exhausted Apify credit to AdapterQuotaError", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            type: "not-enough-usage-to-run-paid-actor",
            message: "Not enough usage credits"
          }
        },
        402
      )
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterQuotaError);
  });

  it("maps rate limiting and network failures to AdapterBlockedError", async () => {
    const rateLimited = vi.fn(async () =>
      jsonResponse({ error: { type: "rate-limit-exceeded", message: "Try later" } }, 429)
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: rateLimited as unknown as typeof fetch }));
    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);

    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const offlineAdapter = new OzonAdapter(
      adapterOptions({ fetch: offline as unknown as typeof fetch })
    );
    await expect(offlineAdapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(
      AdapterBlockedError
    );
  });

  it("treats actor-reported dataset failures as fatal, including quota failures", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([{ error: "Monthly usage limit exceeded before collection" }])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterQuotaError);
  });

  it("fails closed on Actor warning rows instead of treating a capped dataset as complete", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse([
        {
          sku: 123456789,
          url: "https://www.ozon.ru/product/kagocel-123456789/",
          title: "Кагоцел таблетки",
          rating: 4.8,
          reviewsCount: 10
        },
        { _warning: "Free tier limit reached" }
      ])
    );
    const adapter = new OzonAdapter(adapterOptions({ fetch: fetchSpy as unknown as typeof fetch }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterQuotaError);
  });

  it("detects changed response schemas and unsafe product URLs", async () => {
    const wrappedDataset = vi.fn(async () => jsonResponse({ data: { items: [] } }));
    const wrappedAdapter = new OzonAdapter(
      adapterOptions({ fetch: wrappedDataset as unknown as typeof fetch })
    );
    await expect(wrappedAdapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(
      ParserChangedError
    );

    const unsafeUrl = vi.fn(async () =>
      jsonResponse([
        {
          sku: 123456789,
          url: "https://example.com/product/kagocel-123456789/",
          title: "Кагоцел таблетки",
          rating: 4.8,
          reviewCount: 10
        }
      ])
    );
    const unsafeAdapter = new OzonAdapter(
      adapterOptions({ fetch: unsafeUrl as unknown as typeof fetch })
    );
    await expect(unsafeAdapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(
      ParserChangedError
    );
  });

  it("rejects configurations that can exceed actor or project safety limits", () => {
    expect(() => new OzonAdapter(adapterOptions({ maxResults: 0 }))).toThrow(RangeError);
    expect(() => new OzonAdapter(adapterOptions({ maxResults: 10_001 }))).toThrow(RangeError);
    expect(() => new OzonAdapter(adapterOptions({ maxTotalChargeUsd: 4.51 }))).toThrow(RangeError);
    expect(() => new OzonAdapter(adapterOptions({ timeoutSeconds: 301 }))).toThrow(RangeError);
    expect(() => new OzonAdapter(adapterOptions({ apiBaseUrl: "http://api.apify.test" }))).toThrow(
      TypeError
    );
  });
});
