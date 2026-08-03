import { describe, expect, it, vi } from "vitest";

import type { AdapterContext, ProductRef } from "../src/shared/types.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { WildberriesAdapter } from "../src/server/adapters/wildberries.js";
import { analyzeProductIdentity } from "../src/server/utils/product-name.js";

const FIXED_TIME = new Date("2026-07-13T09:00:00.000Z");

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { region: "Москва", ...overrides };
}

function productRef(overrides: Partial<ProductRef> = {}): ProductRef {
  return {
    domain: "wildberries.ru",
    platform: "wildberries",
    listingId: "101",
    brand: "Арбидол",
    url: "https://www.wildberries.ru/catalog/101/detail.aspx",
    title: "Арбидол Максимум, капсулы 200 мг",
    metadata: {},
    ...overrides
  };
}

function createAdapter(
  fetchImplementation: typeof globalThis.fetch,
  overrides: ConstructorParameters<typeof WildberriesAdapter>[0] = {}
): WildberriesAdapter {
  return new WildberriesAdapter({
    fetch: fetchImplementation,
    productInfoFetch: false,
    searchEndpoint: "https://search.wb.ru/exactmatch/ru/common/v14/search",
    requestIntervalMs: 0,
    blockedRetryBaseMs: 0,
    sleep: async () => undefined,
    now: () => FIXED_TIME,
    ...overrides
  });
}

describe("WildberriesAdapter.discover", () => {
  it("falls back from blocked v14 to free v18 before requesting browser Sandbox", async () => {
    const requests: Array<{ url: URL; browser: boolean }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const browser = new Headers(init?.headers).get("x-ratings-browser") === "1";
      requests.push({ url, browser });
      if (url.pathname.includes("/v14/")) return new Response("rate limited", { status: 429 });
      return jsonResponse({
        total: 3,
        products: [
          { id: 822669569, name: "Оциллококцинум гранулы гомеопатические 30 шт", nmReviewRating: 5, nmFeedbacks: 24 },
          { id: 822660107, name: "Оциллококцинум гранулы гомеопатические 6 шт", nmReviewRating: 4.7, nmFeedbacks: 3 },
          { id: 822679599, name: "Оциллококцинум гранулы гомеопатические 12 шт", nmReviewRating: 4.9, nmFeedbacks: 16 }
        ]
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new WildberriesAdapter({
      fetch: fetchMock,
      requestIntervalMs: 0,
      blockedRetryBaseMs: 0,
      sleep: async () => undefined,
      now: () => FIXED_TIME
    });

    const refs = await adapter.discover("Оциллококцинум", context({ runId: "oscillo-live" }));

    expect(refs.map(({ listingId }) => listingId)).toEqual(["822669569", "822660107", "822679599"]);
    expect(requests.map(({ url }) => `${url.pathname}:${url.searchParams.get("appType")}`)).toEqual([
      "/exactmatch/ru/common/v14/search:1",
      "/exactmatch/ru/common/v14/search:32",
      "/exactmatch/ru/common/v14/search:64",
      "/exactmatch/ru/common/v18/search:1"
    ]);
    expect(requests.every(({ browser }) => !browser)).toBe(true);
  });

  it("reuses a successful discovery within one run without repeating public HTTP requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      total: 1,
      products: [{ id: 701, name: "BrandX capsules", nmReviewRating: 4.8, nmFeedbacks: 10 }]
    })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const runContext = context({ runId: "run-1", previousIds: ["wildberries:702"] });

    const first = await adapter.discover("BrandX", runContext);
    const second = await adapter.discover("BrandX", runContext);

    expect(second).toEqual(first);
    expect(first.map(({ listingId }) => listingId)).toEqual(["701", "702"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a blocked discovery as a successful empty result", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        products: [{ id: 701, name: "BrandX capsules", nmReviewRating: 4.8, nmFeedbacks: 10 }]
      })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { blockedCooldownMs: 0 });
    const runContext = context({ runId: "run-1" });

    await expect(adapter.discover("BrandX", runContext)).rejects.toBeInstanceOf(AdapterBlockedError);
    await expect(adapter.discover("BrandX", runContext)).resolves.toMatchObject([{ listingId: "701" }]);

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("recovers a blocked desktop route through appType 32 and keeps that free route for pagination", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const appType = url.searchParams.get("appType");
      const page = Number(url.searchParams.get("page"));
      if (appType === "1") return new Response("rate limited", { status: 429 });
      return jsonResponse({
        total: 2,
        products: [{
          id: 700 + page,
          name: `BrandX capsules ${page}`,
          nmReviewRating: 4.8,
          nmFeedbacks: 10
        }]
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, {
      blockedRetryBaseMs: 10,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); }
    });

    const refs = await adapter.discover("BrandX", context());

    expect(refs.map(({ listingId }) => listingId)).toEqual(["701", "702"]);
    expect(vi.mocked(fetchMock).mock.calls.map(([input]) =>
      new URL(String(input)).searchParams.get("appType")
    )).toEqual(["1", "32", "32"]);
    expect(sleeps).toEqual([10]);
  });

  it("uses the warmed browser API route only after every direct app type remains blocked", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("x-ratings-browser-mode") !== "wildberries-api") {
        return new Response("blocked", { status: 498 });
      }
      return jsonResponse({
        total: 1,
        products: [{ id: 801, name: "BrandX tablets", nmReviewRating: 4.9, nmFeedbacks: 12 }]
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, {
      blockedRetryBaseMs: 10,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); }
    });

    const refs = await adapter.discover("BrandX", context());

    expect(refs.map(({ listingId }) => listingId)).toEqual(["801"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const headers = new Headers(vi.mocked(fetchMock).mock.calls[3][1]?.headers);
    expect(headers.get("x-ratings-browser")).toBe("1");
    expect(headers.get("x-ratings-browser-mode")).toBe("wildberries-api");
    expect(sleeps).toEqual([10, 20, 40]);
  });

  it("bounds total free-route backoff while preserving endpoint and appType order", async () => {
    const sleeps: number[] = [];
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const browser = new Headers(init?.headers).get("x-ratings-browser") === "1";
      requests.push(`${url.pathname}:${url.searchParams.get("appType")}:${browser ? "browser" : "direct"}`);
      if (url.pathname.includes("/v18/") && url.searchParams.get("appType") === "64") {
        return jsonResponse({
          total: 1,
          products: [{ id: 822669569, name: "Оциллококцинум гранулы 30 шт", nmReviewRating: 5, nmFeedbacks: 24 }]
        });
      }
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new WildberriesAdapter({
      fetch: fetchMock,
      requestIntervalMs: 0,
      blockedRetryBaseMs: 100,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); }
    });

    await expect(adapter.discover("Оциллококцинум", context())).resolves.toMatchObject([
      { listingId: "822669569", metadata: { nmFeedbacks: 24, nmReviewRating: 5 } }
    ]);

    expect(requests).toEqual([
      "/exactmatch/ru/common/v14/search:1:direct",
      "/exactmatch/ru/common/v14/search:32:direct",
      "/exactmatch/ru/common/v14/search:64:direct",
      "/exactmatch/ru/common/v18/search:1:direct",
      "/exactmatch/ru/common/v18/search:32:direct",
      "/exactmatch/ru/common/v18/search:64:direct"
    ]);
    expect(sleeps).toEqual([100, 150, 150, 150, 150]);
    expect(sleeps.reduce((sum, value) => sum + value, 0)).toBe(700);
  });

  it("accepts only an explicit rendered no-results proof after every JSON API route is blocked", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("x-ratings-browser-mode") === "wildberries-search-proof") {
        return jsonResponse({
          products: [],
          total: 0,
          metadata: { source: "wildberries-visible-explicit-no-results" }
        });
      }
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.discover("MissingBrand", context())).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const [proofInput, proofInit] = vi.mocked(fetchMock).mock.calls[4];
    const proofUrl = new URL(String(proofInput));
    expect(`${proofUrl.origin}${proofUrl.pathname}`).toBe(
      "https://www.wildberries.ru/catalog/0/search.aspx"
    );
    expect(proofUrl.searchParams.get("search")).toBe("MissingBrand");
    expect(new Headers(proofInit?.headers).get("x-ratings-browser-mode")).toBe(
      "wildberries-search-proof"
    );
  });

  it("fails closed on an empty first JSON page without explicit total zero", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ products: [] })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { browserFallbackAppType: false });

    await expect(adapter.discover("Тикализис", context())).rejects.toThrow(
      /empty first page without an explicit total/
    );
  });

  it("paginates sequentially, applies strict trade-name matching, deduplicates nmId and adds registry IDs", async () => {
    const responses = [
      jsonResponse({
        total: 5,
        products: [
          {
            id: 101,
            root: 9001,
            name: "Арбидол Максимум, капсулы 200 мг №10",
            nmReviewRating: 4.8,
            nmFeedbacks: 42,
            reviewRating: 4.3,
            feedbacks: 800
          },
          { id: 102, name: "Сувенир Арбидолка", reviewRating: 5, feedbacks: 1 },
          { id: 103, name: "Кагоцел таблетки", reviewRating: 4.9, feedbacks: 50 },
          { id: 101, name: "Арбидол Максимум, рекламная выдача", reviewRating: 4.8, feedbacks: 42 }
        ]
      }),
      jsonResponse({
        total: 5,
        products: [{ id: "104", root: "9004", name: "АРБИДОЛ — капсулы 100 мг", feedbacks: 7 }]
      })
    ];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchMock = vi.fn(async () => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra page request");
      return response;
    }) as unknown as typeof globalThis.fetch;

    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover(
      "Арбидол",
      context({ previousIds: ["wildberries:105", "wildberries.ru:104", "ozon:999", "not-an-id"] })
    );

    expect(refs.map((ref) => ref.listingId)).toEqual(["101", "104", "105"]);
    expect(refs[0]).toMatchObject({
      domain: "wildberries.ru",
      platform: "wildberries",
      brand: "Арбидол",
      url: "https://www.wildberries.ru/catalog/101/detail.aspx",
      metadata: {
        source: "wildberries-search-v18",
        rootId: "9001",
        nmReviewRating: 4.8,
        nmFeedbacks: 42,
        groupReviewRating: 4.3,
        groupFeedbacks: 800
      }
    });
    expect(refs[2]).toMatchObject({ metadata: { source: "previous-registry" } });
    expect(maximumActiveRequests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const urls = vi.mocked(fetchMock).mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(urls.every((url) => url.searchParams.get("query") === "Арбидол")).toBe(true);
    expect(urls.every((url) => url.pathname.endsWith("/common/v14/search"))).toBe(true);
  });

  it("exhausts 100+43 search results, accepts exact source brand or title, and verifies all 134 cards in complete batches", async () => {
    const exact = Array.from({ length: 134 }, (_value, index) => {
      const id = 100_001 + index;
      const bySourceBrand = index < 117;
      return {
        id,
        root: 500_001 + index,
        brand: bySourceBrand ? "Бивиарт" : "Solopharm",
        name: bySourceBrand ? `Капли увлажняющие ${index + 1}` : `Бивиарт раствор ${index + 1}`,
        nmReviewRating: 0,
        nmFeedbacks: 0
      };
    });
    const foreign = Array.from({ length: 9 }, (_value, index) => ({
      id: 200_001 + index,
      root: 600_001 + index,
      brand: "Здоровье XL",
      name: `Раствор увлажняющий ${index + 1}`,
      nmReviewRating: 0,
      nmFeedbacks: 0
    }));
    const cardBatchSizes: number[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") {
        const page = Number(url.searchParams.get("page"));
        return jsonResponse({
          total: 143,
          products: page === 1 ? exact.slice(0, 100) : [...exact.slice(100), ...foreign]
        });
      }
      if (url.hostname === "card.wb.ru") {
        const ids = (url.searchParams.get("nm") ?? "").split(";").filter(Boolean).map(Number);
        cardBatchSizes.push(ids.length);
        return jsonResponse({ products: exact.filter((product) => ids.includes(product.id)) });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const refs = await adapter.discover("Бивиарт", context({ runId: "biviart-134" }));

    expect(refs).toHaveLength(134);
    expect(new Set(refs.map((ref) => ref.listingId)).size).toBe(134);
    expect(refs.filter((ref) => ref.metadata.sourceBrand === "Бивиарт")).toHaveLength(117);
    expect(refs.some((ref) => foreign.some((item) => String(item.id) === ref.listingId))).toBe(false);
    await expect(adapter.collect(refs[0]!, context())).resolves.toMatchObject({
      listingId: "100001",
      reviews: 0,
      rating: null,
      status: "no_reviews",
      source: "wildberries-card-v4-batch"
    });
    expect(cardBatchSizes).toEqual([100, 34]);
    expect(refs.every((ref) => ref.metadata.cardBatchVerified === true)).toBe(true);
    const searchPages = vi.mocked(fetchMock).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.hostname === "search.wb.ru")
      .map((url) => url.searchParams.get("page"));
    expect(searchPages).toEqual(["1", "2"]);
  });

  it("keeps all three exact Okusalin nmIds and excludes foreign search matches", async () => {
    const exact = [
      { id: 353140005, root: 338289765, brand: "Окусалин", name: "Офтальмологический раствор для промывания глаз 3%, 10шт*1уп", nmReviewRating: 0, nmFeedbacks: 0 },
      { id: 353140006, root: 338289765, brand: "Окусалин", name: "Офтальмологический раствор для промывания глаз 3%, 10шт*2уп", nmReviewRating: 0, nmFeedbacks: 0 },
      { id: 353140007, root: 338289765, brand: "Окусалин", name: "Офтальмологический раствор для промывания глаз 3%, 10шт*3уп", nmReviewRating: 5, nmFeedbacks: 1 }
    ];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") {
        return jsonResponse({
          total: 6,
          products: [
            ...exact,
            { id: 1, brand: "Оксолин", name: "Оксолин мазь", nmReviewRating: 5, nmFeedbacks: 20 },
            { id: 2, brand: "Нитроксолин", name: "Нитроксолин таблетки", nmReviewRating: 5, nmFeedbacks: 10 },
            { id: 3, brand: "", name: "Аптечка для лекарств", nmReviewRating: 0, nmFeedbacks: 0 }
          ]
        });
      }
      if (url.hostname === "card.wb.ru") return jsonResponse({ products: exact });
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const refs = await adapter.discover("Окусалин", context({ runId: "okusalin-3" }));
    expect(refs.map((ref) => ref.listingId)).toEqual(["353140005", "353140006", "353140007"]);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context())));
    expect(observations.map(({ listingId, reviews, rating, status }) => ({ listingId, reviews, rating, status }))).toEqual([
      { listingId: "353140005", reviews: 0, rating: null, status: "no_reviews" },
      { listingId: "353140006", reviews: 0, rating: null, status: "no_reviews" },
      { listingId: "353140007", reviews: 1, rating: 5, status: "ok" }
    ]);
    expect(observations.every((item) => item.aggregateGroupId === undefined)).toBe(true);
  });

  it("retries only an nmId omitted by a complete card batch", async () => {
    const searchProducts = [
      { id: 701, root: 9001, brand: "BrandX", name: "capsules one", nmReviewRating: 0, nmFeedbacks: 0 },
      { id: 702, root: 9002, brand: "BrandX", name: "capsules two", nmReviewRating: 0, nmFeedbacks: 0 }
    ];
    const fetchSpy = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 2, products: searchProducts });
      if (url.hostname === "card.wb.ru") {
        return jsonResponse({
          products: url.searchParams.get("nm") === "702" ? [searchProducts[1]] : [searchProducts[0]]
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const fetchMock = fetchSpy as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("BrandX", context({ runId: "incomplete-card-batch" }));

    const first = await adapter.collect(refs[0]!, context());
    const second = await adapter.collect(refs[1]!, context());

    expect([first.listingId, second.listingId]).toEqual(["701", "702"]);
    expect(refs.every((ref) => ref.metadata.cardBatchVerified === true)).toBe(true);
    expect(fetchSpy.mock.calls.filter(([input]) => new URL(String(input)).hostname === "card.wb.ru")
      .map(([input]) => new URL(String(input)).searchParams.get("nm"))).toEqual(["701;702", "702"]);
  });

  it("keeps an exact source-bound search card when card batch and singleton both omit it", async () => {
    const searchProducts = [
      { id: 701, root: 9001, brand: "BrandX", name: "BrandX capsules one", nmReviewRating: 4.8, nmFeedbacks: 12 },
      { id: 702, root: 9002, brand: "BrandX", name: "BrandX capsules two", nmReviewRating: 5, nmFeedbacks: 3 }
    ];
    const fetchSpy = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 2, products: searchProducts });
      if (url.hostname === "card.wb.ru") {
        return jsonResponse({ products: url.searchParams.get("nm") === "702" ? [] : [searchProducts[0]] });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const adapter = createAdapter(fetchSpy as unknown as typeof globalThis.fetch);
    const refs = await adapter.discover("BrandX", context({ runId: "search-card-fallback" }));

    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context())));

    expect(observations).toMatchObject([
      { listingId: "701", reviews: 12, rating: 4.8, source: "wildberries-card-v4-batch" },
      { listingId: "702", reviews: 3, rating: 5, source: "wildberries-search-exact-fallback" }
    ]);
    expect(refs.every((ref) => ref.metadata.cardBatchVerified === true)).toBe(true);
  });

  it("fails closed when batch and singleton verification both omit an nmId", async () => {
    const searchProducts = [
      { id: 701, root: 9001, brand: "BrandX", name: "capsules one", nmReviewRating: 0, nmFeedbacks: 0 },
      { id: 702, root: 9002, brand: "BrandX", name: "capsules two", nmReviewRating: 0, nmFeedbacks: 0 }
    ];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 2, products: searchProducts });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products: [searchProducts[0]] });
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("BrandX", context({ runId: "incomplete-singleton-card" }));

    await expect(adapter.collect(refs[0]!, context())).rejects.toThrow(/singleton card request returned unexpected nmId 701/);
    expect(refs.every((ref) => ref.metadata.cardBatchVerified !== true)).toBe(true);
  });

  it("uses complete nm distributions instead of duplicating equal root-level card metrics", async () => {
    const products = [
      { id: 197525583, root: 223990643, brand: "Solopharm", name: "Капли для глаз Бивиарт Комфорт 10 мл", nmReviewRating: 4.9, nmFeedbacks: 5616 },
      { id: 220076217, root: 223990643, brand: "Solopharm", name: "Капли для глаз Бивиарт Ультра 10 мл", nmReviewRating: 4.9, nmFeedbacks: 5616 }
    ];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 2, products });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products });
      if (url.hostname === "feedbacks1.wb.ru") {
        return jsonResponse({
          feedbackCount: 5501,
          valuation: 4.8,
          nmValuationDistribution: [
            { nm: 197525583, valuationDistribution: { 1: 50, 2: 21, 3: 53, 4: 181, 5: 2973 } },
            { nm: 220076217, valuationDistribution: { 1: 34, 2: 17, 3: 38, 4: 118, 5: 2003 } }
          ]
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("Бивиарт", context({ runId: "root-nm-distribution" }));

    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context())));
    expect(observations).toMatchObject([
      { listingId: "197525583", reviews: 3278, ratingCount: 3278, rating: 4.8, source: "wildberries-root-nm-distribution" },
      { listingId: "220076217", reviews: 2210, ratingCount: 2210, rating: 4.8, source: "wildberries-root-nm-distribution" }
    ]);
    expect(observations.every((item) => item.aggregateGroupId === undefined)).toBe(true);
  });

  it("recovers three exact Kagocel cards when card v4 omits nm metrics", async () => {
    const searchProducts = [
      { id: 822662670, root: 907227394, brand: "Кагоцел", name: "Кагоцел таблетки 12 мг 10 шт", nmFeedbacks: 68, nmReviewRating: 5 },
      { id: 822686443, root: 907251168, brand: "Кагоцел", name: "Кагоцел таблетки 12 мг 20 шт", nmFeedbacks: 110, nmReviewRating: 4.9 },
      { id: 822671923, root: 907236647, brand: "Кагоцел", name: "Кагоцел таблетки 12 мг 30 шт", nmFeedbacks: 79, nmReviewRating: 5 }
    ];
    const cardProducts = searchProducts.map(({ nmFeedbacks: _count, nmReviewRating: _rating, ...product }) => ({
      ...product,
      feedbacks: 999,
      reviewRating: 4.1
    }));
    const distributions = new Map<string, Record<string, number>>([
      ["907227394", { 1: 0, 2: 0, 3: 0, 4: 7, 5: 61 }],
      ["907251168", { 1: 0, 2: 0, 3: 0, 4: 11, 5: 99 }],
      ["907236647", { 1: 0, 2: 0, 3: 0, 4: 1, 5: 78 }]
    ]);
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 3, products: searchProducts });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products: cardProducts });
      if (url.hostname === "feedbacks1.wb.ru") {
        const rootId = url.pathname.split("/").at(-1)!;
        const product = searchProducts.find(({ root }) => String(root) === rootId)!;
        return jsonResponse({
          feedbackCount: 999,
          valuation: 4.1,
          nmValuationDistribution: [{ nm: product.id, valuationDistribution: distributions.get(rootId) }]
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("Кагоцел", context({ runId: "kagocel-card-v4-without-nm" }));

    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context())));

    expect(observations).toMatchObject([
      { listingId: "822662670", reviews: 68, ratingCount: 68, rating: 4.9, source: "wildberries-root-nm-distribution" },
      { listingId: "822686443", reviews: 110, ratingCount: 110, rating: 4.9, source: "wildberries-root-nm-distribution" },
      { listingId: "822671923", reviews: 79, ratingCount: 79, rating: 5, source: "wildberries-root-nm-distribution" }
    ]);
    expect(observations.every((item) => item.aggregateGroupId === undefined)).toBe(true);
  });

  it("keeps a card-v4 nm omission blocked when the root lacks the exact nm distribution", async () => {
    const searchProduct = {
      id: 822662670,
      root: 907227394,
      brand: "Кагоцел",
      name: "Кагоцел таблетки 12 мг 10 шт",
      nmFeedbacks: 68,
      nmReviewRating: 5
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 1, products: [searchProduct] });
      if (url.hostname === "card.wb.ru") {
        const { nmFeedbacks: _count, nmReviewRating: _rating, ...card } = searchProduct;
        return jsonResponse({ products: [{ ...card, feedbacks: 68, reviewRating: 5 }] });
      }
      if (url.hostname === "feedbacks1.wb.ru") {
        return jsonResponse({
          feedbackCount: 68,
          valuation: 0,
          nmValuationDistribution: [
            { nm: 999999999, valuationDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 68 } }
          ]
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("Кагоцел", context({ runId: "kagocel-missing-exact-nm-distribution" }));

    await expect(adapter.collect(refs[0]!, context())).rejects.toThrow(
      /does not contain exact nm distribution for 822662670/
    );
  });

  it("accepts a source-bound root zero when Wildberries has not calculated rating distributions", async () => {
    const searchProduct = {
      id: 393735497,
      root: 393735497,
      brand: "Энтеролактис",
      name: "Энтеролактис Плюс капсулы"
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 1, products: [searchProduct] });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products: [searchProduct] });
      if (url.hostname === "feedbacks1.wb.ru") {
        return jsonResponse({
          feedbackCount: 0,
          valuation: "",
          valuationDistribution: null,
          nmValuationDistribution: null
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("Энтеролактис", context({ runId: "explicit-root-zero" }));

    const observation = await adapter.collect(refs[0]!, context());

    expect(observation).toMatchObject({
      listingId: "393735497",
      reviews: 0,
      writtenReviewCount: 0,
      ratingCount: 0,
      rating: null,
      status: "no_reviews",
      aggregateGroupId: "wildberries:root:393735497",
      source: "wildberries-root-explicit-zero"
    });
    expect(observation.evidenceRef).toBe("https://feedbacks1.wb.ru/feedbacks/v2/393735497");
    expect(observation).not.toHaveProperty("rawRating");
  });

  it("collapses a root aggregate when card v4 omits metrics and the nm distribution covers only one variant", async () => {
    const products = [790240262, 790240263, 790240264, 790240265].map((id, index) => ({
      id,
      root: 828092104,
      brand: "Энтеролактис",
      name: `Энтеролактис Плюс капсулы вариант ${index + 1}`
    }));
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: products.length, products });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products });
      if (url.hostname === "feedbacks1.wb.ru") {
        return jsonResponse({
          feedbackCount: 1,
          valuation: "5.0",
          valuationDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
          nmValuationDistribution: [{
            nm: 790240265,
            valuationDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }
          }]
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("Энтеролактис", context({ runId: "partial-nm-root-aggregate" }));

    const observations = await Promise.all(refs.map((item) => adapter.collect(item, context())));

    expect(observations).toHaveLength(4);
    expect(observations.every((item) => item.reviews === 1 && item.writtenReviewCount === 1 &&
      item.ratingCount === 1 && item.rating === 5 &&
      item.aggregateGroupId === "wildberries:root:828092104" &&
      item.source === "wildberries-root-family-aggregate")).toBe(true);
  });

  it("marks a proven root-only aggregate for family-row collapse", async () => {
    const products = [
      { id: 801, root: 9901, brand: "BrandX", name: "BrandX comfort", nmReviewRating: 4.8, nmFeedbacks: 50 },
      { id: 802, root: 9901, brand: "BrandX", name: "BrandX ultra", nmReviewRating: 4.8, nmFeedbacks: 50 }
    ];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 2, products });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products });
      if (url.hostname === "feedbacks1.wb.ru") {
        return jsonResponse({
          feedbackCount: 50,
          valuation: 4.8,
          valuationDistribution: { 1: 1, 2: 1, 3: 1, 4: 2, 5: 45 }
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("BrandX", context({ runId: "root-family-aggregate" }));

    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context())));
    expect(observations).toMatchObject([
      { reviews: 50, writtenReviewCount: 50, ratingCount: 50, rating: 4.8, aggregateGroupId: "wildberries:root:9901" },
      { reviews: 50, writtenReviewCount: 50, ratingCount: 50, rating: 4.8, aggregateGroupId: "wildberries:root:9901" }
    ]);
    expect(observations.every((item) => item.source === "wildberries-root-family-aggregate")).toBe(true);
  });

  it("collapses a valid root aggregate when Wildberries omits one duplicated nm distribution", async () => {
    const products = [
      { id: 493939488, root: 501370411, brand: "Бактоблис", name: "Бактоблис Плюс 90 таблеток", nmReviewRating: 5, nmFeedbacks: 2 },
      { id: 493941788, root: 501370411, brand: "Бактоблис", name: "Бактоблис Плюс 90 таблеток 2 упаковки", nmReviewRating: 5, nmFeedbacks: 2 }
    ];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "search.wb.ru") return jsonResponse({ total: 2, products });
      if (url.hostname === "card.wb.ru") return jsonResponse({ products });
      if (url.hostname === "feedbacks1.wb.ru") {
        return jsonResponse({
          feedbackCount: 3,
          valuation: 5,
          valuationDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 },
          nmValuationDistribution: [
            { nm: 493939488, valuationDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 } }
          ]
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);
    const refs = await adapter.discover("Бактоблис", context({ runId: "partial-root-distribution" }));

    const persistedSecondRef = { ...refs[1]!, metadata: { ...refs[1]!.metadata } };
    const observations = [
      await adapter.collect(refs[0]!, context()),
      await adapter.collect(persistedSecondRef, context())
    ];
    expect(observations).toMatchObject([
      { reviews: 3, ratingCount: 2, rating: 5, aggregateGroupId: "wildberries:root:501370411" },
      { reviews: 3, ratingCount: 2, rating: 5, aggregateGroupId: "wildberries:root:501370411" }
    ]);
    expect(observations.every((item) => item.source === "wildberries-root-family-aggregate")).toBe(true);
  });

  it("excludes a foreign first-party brand even when the product title contains the requested brand name", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      total: 2,
      products: [
        { id: 9101, brand: "Андромакс", name: "Андромакс порошок 10 г №30", nmReviewRating: 4.8, nmFeedbacks: 12 },
        { id: 9102, brand: "Персональный подарок", name: "Кружка Андромакс с именем", nmReviewRating: 5, nmFeedbacks: 1 }
      ]
    })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const refs = await adapter.discover("Андромакс", context({ runId: "andromax-brand-authority" }));

    expect(refs.map((ref) => ref.listingId)).toEqual(["9101"]);
    expect(refs[0]?.metadata.sourceBrand).toBe("Андромакс");
  });

  it("fails closed at the configured maximum when every page remains non-empty", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return jsonResponse({ products: [{ id: 200 + page, name: `Арбидол упаковка ${page}` }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { maxPages: 2 });

    await expect(adapter.discover("Арбидол", context())).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the endpoint repeats an identical page", async () => {
    const page = { products: [{ id: 301, name: "Арбидол капсулы" }] };
    const fetchMock = vi.fn(async () => jsonResponse(page)) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { maxPages: 10 });

    await expect(adapter.discover("Арбидол", context())).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts the last allowed page when total proves exhaustion", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return jsonResponse({
        total: 2,
        products: [{ id: 400 + page, name: `Арбидол упаковка ${page}` }]
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { maxPages: 2 });

    const refs = await adapter.discover("Арбидол", context());

    expect(refs.map((ref) => ref.listingId)).toEqual(["401", "402"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an empty page contradicts the advertised total", async () => {
    const responses = [
      jsonResponse({ total: 2, products: [{ id: 501, name: "Арбидол упаковка 1" }] }),
      jsonResponse({ total: 2, products: [] })
    ];
    const adapter = createAdapter(
      vi.fn(async () => responses.shift()!) as unknown as typeof globalThis.fetch,
      { maxPages: 2 }
    );

    await expect(adapter.discover("Арбидол", context())).rejects.toBeInstanceOf(AdapterBlockedError);
  });
});

describe("WildberriesAdapter.collect", () => {
  it("recovers exact Enterolactis variants and seller bundles from truncated buyer titles", async () => {
    const adapter = createAdapter(vi.fn(async () => {
      throw new Error("no fallback request is needed for source-bound search metrics");
    }) as unknown as typeof globalThis.fetch);
    const examples = [
      ["Энтеролактис Дуо 2 шт", "Энтеролактис Дуо саше 5 г №20 ×2 упаковки", undefined],
      ["Энтеролактис дуо симбиотик 20 шт. 3 упаковки", "Энтеролактис Дуо саше 5 г №20 ×3 упаковки", undefined],
      ["Энтеролактис ПЛЮС Enterolactis PLUS капсулы массой 319 мг 15…", "Энтеролактис Плюс капсулы 319 мг №15", undefined],
      ["Энтеролактис Фибра 4 шт", "Энтеролактис Фибра сироп 10 мл №12 ×4 упаковки", undefined],
      ["Пробиотики + пребиотики для кишечника №12", "Энтеролактис Фибра сироп 10 мл №12", "ЭНТЕРОЛАКТИС"],
      ["Пробиотик с лактобактериями для взрослых и детей", "Энтеролактис Плюс капсулы 319 мг №15", "ЭНТЕРОЛАКТИС"]
    ] as const;

    const observations = await Promise.all(examples.map(([title, expected, sourceBrand], index) =>
      adapter.collect(productRef({
        listingId: String(900_000 + index),
        brand: "Энтеролактис",
        title,
        metadata: {
          source: "wildberries-search-v18",
          ...(sourceBrand ? { sourceBrand } : {}),
          nmReviewRating: 5,
          nmFeedbacks: 1
        }
      }), context()).then((observation) => ({ observation, expected }))
    ));

    for (const { observation, expected } of observations) {
      expect(observation).toMatchObject({ product: expected, reviews: 1, rating: 5, status: "ok" });
      expect(analyzeProductIdentity({
        brand: observation.brand,
        product: observation.product,
        url: observation.canonicalUrl
      }).granularity).toBe("variant");
    }
  });

  it("restores the exact package count from the same-nm product card when the buyer API title is truncated", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("basket-37.wbbasket.ru");
      expect(url.pathname).toBe("/vol8226/part822665/822665269/info/ru/card.json");
      return jsonResponse({
        nm_id: 822665269,
        imt_name: "Тромболикс Про раствор для в/в и в/м введ 600 ЛЕ/2мл 2 мл амп 10 шт",
        options: [{ name: "Количество капсул/таблеток", value: "10 шт." }]
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { productInfoFetch: fetchMock });

    const observation = await adapter.collect(productRef({
      listingId: "822665269",
      brand: "Тромболикс Про",
      url: "https://www.wildberries.ru/catalog/822665269/detail.aspx",
      title: "Тромболикс Про раствор для в/в и в/м введ 600 ЛЕ/2мл 2 мл амп…",
      metadata: {
        source: "wildberries-search-v18",
        nmReviewRating: 4.9,
        nmFeedbacks: 8
      }
    }), context());

    expect(observation).toMatchObject({
      product: "Тромболикс Про раствор для в/в и в/м введ 600 ЛЕ/2мл 2 мл амп 10 шт",
      reviews: 8,
      rating: 4.9,
      status: "ok"
    });
    expect(analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl
    })).toMatchObject({
      label: "раствор для внутривенного и внутримышечного введения 2 мл №10",
      granularity: "variant",
      confidence: "exact"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      listingId: "430159965",
      host: "basket-24.wbbasket.ru",
      path: "/vol4301/part430159/430159965/info/ru/card.json",
      currentTitle: "без сахара, таблетки для рассасывания",
      payload: {
        nm_id: 430159965,
        imt_name: "БактоБЛИС без сахара, таблетки для рассасывания",
        options: [
          { name: "Количество капсул/таблеток", value: "30 шт." },
          { name: "Форма выпуска", value: "таблетки" }
        ]
      },
      expectedLabel: "без сахара таблетки для рассасывания №30"
    },
    {
      listingId: "485107441",
      host: "basket-26.wbbasket.ru",
      path: "/vol4851/part485107/485107441/info/ru/card.json",
      currentTitle: "БактоБЛИСбезсахаратаблд рассасх30",
      payload: {
        nm_id: 485107441,
        imt_name: "БактоБЛИСбезсахаратаблд/рассасх30",
        options: [
          { name: "Количество капсул/таблеток", value: "30 шт." },
          { name: "Форма выпуска", value: "таблетки" },
          {
            name: "Торговое наименование",
            value: "Биологически активная добавка к пище «БактоБЛИС без сахара» / «Bactoblis sugar free», таблетки массой 810 мг."
          }
        ]
      },
      expectedLabel: "без сахара таблетки 810 мг №30"
    }
  ])("uses exact first-party card options for Baktoblis nmId $listingId", async ({
    listingId, host, path, currentTitle, payload, expectedLabel
  }) => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe(host);
      expect(url.pathname).toBe(path);
      return jsonResponse(payload);
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { productInfoFetch: fetchMock });

    const observation = await adapter.collect(productRef({
      listingId,
      brand: "Бактоблис",
      url: `https://www.wildberries.ru/catalog/${listingId}/detail.aspx`,
      title: currentTitle,
      metadata: {
        source: "wildberries-search-v18",
        sourceBrand: "БактоБЛИС",
        nmReviewRating: 5,
        nmFeedbacks: 1
      }
    }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl
    });

    expect(observation).toMatchObject({ reviews: 1, rating: 5, status: "ok" });
    expect(identity).toMatchObject({
      label: expectedLabel,
      granularity: "variant",
      confidence: "exact"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a same-nm Baktoblis card review-only when first-party data has no pack count", async () => {
    const listingId = "613426833";
    const fetchMock = vi.fn(async () => jsonResponse({
      nm_id: Number(listingId),
      imt_name: "БактоБЛИС без сахара таблетки для рассасывания массой 810 мг",
      options: [{ name: "Срок годности", value: "1 год" }]
    })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { productInfoFetch: fetchMock });

    const observation = await adapter.collect(productRef({
      listingId,
      brand: "Бактоблис",
      url: `https://www.wildberries.ru/catalog/${listingId}/detail.aspx`,
      title: "БактоБЛИС без сахара таблетки для рассасывания массой 810 мг",
      metadata: {
        source: "wildberries-search-v18",
        nmReviewRating: 5,
        nmFeedbacks: 1
      }
    }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl
    });

    expect(identity).toMatchObject({
      granularity: "unresolved",
      confidence: "partial",
      missing: ["pack"]
    });
  });

  it("never borrows a package count from basket metadata for another nmId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      nm_id: 822665270,
      imt_name: "Тромболикс Про раствор 2 мл ампулы №20"
    })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { productInfoFetch: fetchMock });

    const observation = await adapter.collect(productRef({
      listingId: "822665269",
      brand: "Тромболикс Про",
      title: "Тромболикс Про раствор 2 мл…",
      metadata: {
        source: "wildberries-search-v18",
        nmReviewRating: 4.9,
        nmFeedbacks: 8
      }
    }), context());

    expect(observation.product).toBe("Тромболикс Про раствор 2 мл…");
    expect(observation.product).not.toContain("№20");
  });

  it("collects current-search nm metrics without calling the card endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("card endpoint must not be called");
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const observation = await adapter.collect(productRef({
      metadata: {
        source: "wildberries-search-v18",
        rootId: "9001",
        nmReviewRating: 4.7,
        nmFeedbacks: 12,
        groupReviewRating: 1.2,
        groupFeedbacks: 999
      }
    }), context());

    expect(observation).toMatchObject({
      listingId: "101",
      product: "Арбидол Максимум, капсулы 200 мг",
      reviews: 12,
      rating: 4.7,
      rawRating: 4.7,
      rawRatingScale: 5,
      status: "ok",
      groupId: "9001",
      source: "wildberries-search-v18"
    });
    expect(observation).not.toHaveProperty("evidenceRef");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps zero-review current-search cards ratingless and applies the strict title check", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("card endpoint must not be called");
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const zero = await adapter.collect(productRef({
      metadata: { source: "wildberries-search-v18", nmReviewRating: 5, nmFeedbacks: 0 }
    }), context());
    const wrongBrand = await adapter.collect(productRef({
      title: "Кагоцел таблетки",
      metadata: { source: "wildberries-search-v18", nmReviewRating: 4.9, nmFeedbacks: 30 }
    }), context());

    expect(zero).toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
    expect(zero).not.toHaveProperty("rawRating");
    expect(wrongBrand).toMatchObject({ reviews: 30, rating: 4.9, status: "needs_review" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the card endpoint when current-search nm metrics are incomplete", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      products: [{ id: 101, name: "Арбидол капсулы", nmReviewRating: 4.6, nmFeedbacks: 8 }]
    })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const observation = await adapter.collect(productRef({
      metadata: {
        source: "wildberries-search-v18",
        groupReviewRating: 4.9,
        groupFeedbacks: 500
      }
    }), context());

    expect(observation).toMatchObject({ reviews: 8, rating: 4.6, source: "wildberries-card-v4" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers nm-specific review metrics and retains the root grouping ID", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        products: [
          {
            id: 101,
            root: 9001,
            name: "Арбидол Максимум, капсулы 200 мг №10",
            nmReviewRating: 4.7,
            nmFeedbacks: 12,
            reviewRating: 4.1,
            feedbacks: 999
          }
        ]
      })
    ) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const observation = await adapter.collect(productRef(), context());

    expect(observation).toMatchObject({
      domain: "wildberries.ru",
      platform: "wildberries",
      listingId: "101",
      brand: "Арбидол",
      canonicalUrl: "https://www.wildberries.ru/catalog/101/detail.aspx",
      product: "Арбидол Максимум, капсулы 200 мг №10",
      reviews: 12,
      rating: 4.7,
      rawRating: 4.7,
      rawRatingScale: 5,
      status: "ok",
      capturedAt: "2026-07-13T09:00:00.000Z",
      groupId: "9001",
      source: "wildberries-card-v4"
    });
    expect(observation.evidenceRef).toContain("card.wb.ru/cards/v4/detail");
    expect(new URL(observation.evidenceRef!).searchParams.get("nm")).toBe("101");
  });

  it("never substitutes group aggregates for nm-specific metrics", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          products: [
            { id: "101", name: "Арбидол капсулы", reviewRating: "4.6", feedbacks: "18" }
          ]
        }
      })
    ) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.collect(productRef(), context())).rejects.toThrow(
      /group aggregates are not a substitute/
    );
  });

  it("reports a confirmed zero-review card without inventing a rating", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        products: [
          { id: 101, root: 9001, name: "Арбидол капсулы", nmReviewRating: 5, nmFeedbacks: 0 }
        ]
      })
    ) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const observation = await adapter.collect(productRef(), context());

    expect(observation).toMatchObject({ reviews: 0, rating: null, status: "no_reviews" });
    expect(observation).not.toHaveProperty("rawRating");
  });

  it("marks a card for review when its title no longer matches the requested trade name", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        products: [{ id: 101, name: "Кагоцел таблетки", nmReviewRating: 4.9, nmFeedbacks: 30 }]
      })
    ) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const observation = await adapter.collect(productRef(), context());

    expect(observation).toMatchObject({ reviews: 30, rating: 4.9, status: "needs_review" });
  });

  it("returns not_found when a previously registered nmId has disappeared", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ products: [] })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const observation = await adapter.collect(
      productRef({ metadata: { source: "previous-registry", rootId: "9001" } }),
      context()
    );

    expect(observation).toMatchObject({
      reviews: null,
      rating: null,
      status: "not_found",
      groupId: "9001"
    });
  });

  it("serializes concurrent card requests to preserve the low-rate buyer API contract", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const id = new URL(String(input)).searchParams.get("nm")!;
      activeRequests -= 1;
      return jsonResponse({
        products: [{ id, name: "Арбидол капсулы", nmReviewRating: 4.8, nmFeedbacks: 10 }]
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await Promise.all([
      adapter.collect(productRef({ listingId: "401" }), context()),
      adapter.collect(productRef({ listingId: "402" }), context()),
      adapter.collect(productRef({ listingId: "403" }), context())
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maximumActiveRequests).toBe(1);
  });

  it("fails closed when review-count fields disappear", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ products: [{ id: 101, name: "Арбидол капсулы", nmReviewRating: 4.8 }] })
    ) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.collect(productRef(), context())).rejects.toBeInstanceOf(ParserChangedError);
  });
});

describe("WildberriesAdapter blocking and health checks", () => {
  it.each([429, 498])("classifies HTTP %s as an adapter block", async (status) => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.discover("Арбидол", context())).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("classifies a successful Proof-of-Work page as an adapter block", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html><title>Proof of Work</title><body>captcha challenge</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    ) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.discover("Арбидол", context())).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("fails closed when the buyer API schema changes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.discover("Арбидол", context())).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("returns a deterministic healthy canary result for a valid search response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ products: [] })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    await expect(adapter.healthCheck(context())).resolves.toEqual({
      ok: true,
      checkedAt: "2026-07-13T09:00:00.000Z",
      message: "Wildberries search schema is valid"
    });
  });

  it("reports a blocked canary as unhealthy instead of hiding the failure", async () => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status: 429 })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock);

    const result = await adapter.healthCheck(context());

    expect(result.ok).toBe(false);
    expect(result.checkedAt).toBe("2026-07-13T09:00:00.000Z");
    expect(result.message).toContain("blocked the request");
  });
});
