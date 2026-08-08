import { describe, expect, it, vi } from "vitest";

import type { AdapterActivityEvent, AdapterContext, ProductRef } from "../src/shared/types.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { mapWithConcurrency, YandexAdapter } from "../src/server/adapters/yandex.js";
import { analyzeProductIdentity } from "../src/server/utils/product-name.js";
import { hasDeterministicAggregateProof } from "../src/shared/review-aggregates.js";

const INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const MAP_A = "https://reviews.yandex.ru/ugcpub/sitemap_model_0-9999999-0.xml";
const MAP_B = "https://reviews.yandex.ru/ugcpub/sitemap_model_260000000-269999999-0.xml";
const MAP_C = "https://reviews.yandex.ru/ugcpub/sitemap_model_500000000-509999999-0.xml";
const MAP_695 = "https://reviews.yandex.ru/ugcpub/sitemap_model_690000000-699999999-0.xml";
const MAP_588_TOMBSTONE = "https://reviews.yandex.ru/ugcpub/sitemap_model_5880000000-5889999999-0.xml";
const MAP_589_TOMBSTONE = "https://reviews.yandex.ru/ugcpub/sitemap_model_5890000000-5899999999-0.xml";
const MAP_590_TOMBSTONE = "https://reviews.yandex.ru/ugcpub/sitemap_model_5900000000-5909999999-0.xml";
const MAP_602_TOMBSTONE = "https://reviews.yandex.ru/ugcpub/sitemap_model_6020000000-6029999999-0.xml";
const MAP_603_TOMBSTONE = "https://reviews.yandex.ru/ugcpub/sitemap_model_6030000000-6039999999-0.xml";
const CURRENT_INDEX_TOMBSTONES = [
  MAP_588_TOMBSTONE,
  MAP_589_TOMBSTONE,
  MAP_590_TOMBSTONE,
  ...Array.from({ length: 7 }, (_value, index) => {
    const start = 5_910_000_000 + index * 10_000_000;
    return `https://reviews.yandex.ru/ugcpub/sitemap_model_${start}-${start + 9_999_999}-0.xml`;
  }),
  ...Array.from({ length: 4 }, (_value, index) => {
    const start = 5_980_000_000 + index * 10_000_000;
    return `https://reviews.yandex.ru/ugcpub/sitemap_model_${start}-${start + 9_999_999}-0.xml`;
  }),
  MAP_602_TOMBSTONE,
  MAP_603_TOMBSTONE
];
const SHOP_MAP_SYMBOLS = "https://reviews.yandex.ru/ugcpub/sitemap_shop_%25-%26-0.xml";
const SHOP_MAP_DIGITS = "https://reviews.yandex.ru/ugcpub/sitemap_shop_0-1-0.xml";
const SHOP_MAP_DIGITS_END = "https://reviews.yandex.ru/ugcpub/sitemap_shop_9-%3A-0.xml";
const SHOP_MAP_LETTERS = "https://reviews.yandex.ru/ugcpub/sitemap_shop_a-b-0.xml";
const SHOP_MAP_LETTERS_END = "https://reviews.yandex.ru/ugcpub/sitemap_shop_z-%7B-0.xml";

describe("YandexAdapter discovery", () => {
  it("uses the rendered Market search proof and exhausts every advertised page before returning exact cards", async () => {
    const endpoint = "https://market.yandex.ru/search";
    const pageOne = `${endpoint}?text=${encodeURIComponent("Энтеролактис")}`;
    const pageTwo = `${pageOne}&page=2`;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(new Headers(init?.headers).get("x-ratings-browser-mode")).toBe("yandex-market-proof");
      if (url === pageOne) {
        return new Response(JSON.stringify({
          query: "Энтеролактис",
          page: 1,
          hasNext: true,
          products: [
            {
              id: "103552838402",
              name: "Энтеролактис Плюс капсулы 319мг 15шт",
              url: "https://market.yandex.ru/card/enterolaktis-plyus-kaps/103552838402",
              ratingCount: 55,
              rating: 4.9,
              familyId: "101596320306"
            },
            {
              id: "103543425097",
              name: "Энтерол капсулы 250 мг",
              url: "https://market.yandex.ru/card/enterol-kaps-fl/103543425097"
            }
          ]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === pageTwo) {
        return new Response(JSON.stringify({
          query: "Энтеролактис",
          page: 2,
          hasNext: false,
          products: [{
            id: "103552838702",
            name: "Энтеролактис Дуо саше 5г 20шт",
            url: "https://market.yandex.ru/card/enterolaktis-duo-por-sashe/103552838702"
          }]
        }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexMarketBrowserEndpoint?: string };
    fetch.yandexMarketBrowserEndpoint = endpoint;
    const adapter = new YandexAdapter({ fetch });

    const refs = await adapter.discover("Энтеролактис", context({ brands: ["Энтеролактис"] }));

    expect(refs.map(({ listingId }) => listingId).sort()).toEqual(["103552838402", "103552838702"]);
    expect(refs.every(({ url }) => url.endsWith("/reviews"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("sitemap"))).toBe(false);

    await expect(adapter.collect(refs.find(({ listingId }) => listingId === "103552838402")!,
      context({ brands: ["Энтеролактис"] }))).resolves.toMatchObject({
      reviews: 55,
      ratingCount: 55,
      rating: 4.9,
      aggregateGroupId: "yandex:sku:101596320306",
      source: "yandex_market_json_ld_search"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collects a rendered exact Market card with source-bound JSON-LD metrics", async () => {
    const listingId = "103552838402";
    const marketUrl = `https://market.yandex.ru/card/enterolaktis-plyus-kaps/${listingId}/reviews`;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-ratings-browser-mode")).toBe("yandex-market-proof");
      return new Response(marketJsonLdHtml({
        url: marketUrl,
        title: "Энтеролактис Плюс капсулы 319мг 15шт",
        rating: 4.9,
        ratingCount: 55,
        reviewCount: 12
      }), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-ratings-final-url": marketUrl,
          "x-ratings-proof-route": "yandex-market-browser"
        }
      });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexMarketBrowserEndpoint?: string };
    fetch.yandexMarketBrowserEndpoint = "https://market.yandex.ru/search";
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({
      listingId,
      brand: "Энтеролактис",
      url: marketUrl,
      title: "Энтеролактис Плюс капсулы 319мг 15шт"
    }), context({ brands: ["Энтеролактис"] }))).resolves.toMatchObject({
      listingId,
      reviews: 55,
      writtenReviewCount: 12,
      rating: 4.9,
      status: "ok",
      source: "yandex_market_json_ld_browser"
    });
  });

  it("falls back to the exhaustive Reviews index when Market browser proof is unavailable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://market.yandex.ru/search?")) {
        throw new AdapterBlockedError("EdgeOne Sandbox is unavailable: HTTP 524");
      }
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      if (url === MAP_A) return xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/enterolaktis-plyus--111"
      ]));
      throw new Error(`Unexpected URL: ${url}`);
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexMarketBrowserEndpoint?: string };
    fetch.yandexMarketBrowserEndpoint = "https://market.yandex.ru/search";
    const activity: AdapterActivityEvent[] = [];
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 2 });

    const refs = await adapter.discover("Энтеролактис", context({
      brands: ["Энтеролактис"],
      activity: async (event) => { activity.push(event); }
    }));

    expect(refs).toMatchObject([{
      listingId: "111",
      url: "https://reviews.yandex.ru/product/enterolaktis-plyus--111",
      metadata: { discovery: "reviews_sitemap", sourceSitemap: MAP_A }
    }]);
    expect(activity).toContainEqual(expect.objectContaining({
      operationId: "yandex:market-to-reviews-fallback",
      status: "warning"
    }));
  });

  it("opens the unavailable Market route only once for every brand in the same run", async () => {
    let marketCalls = 0;
    let sitemapCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://market.yandex.ru/search?")) {
        marketCalls += 1;
        throw new AdapterBlockedError("Market browser is unavailable: HTTP 502");
      }
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      if (url === MAP_A) {
        sitemapCalls += 1;
        return xmlResponse(modelSitemap([
          "https://reviews.yandex.ru/product/enterolaktis-plyus--111",
          "https://reviews.yandex.ru/product/kagotsel-tabletki--222"
        ]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexMarketBrowserEndpoint?: string };
    fetch.yandexMarketBrowserEndpoint = "https://market.yandex.ru/search";
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 2 });
    const shared = { runId: "run-market-circuit", brands: ["Энтеролактис", "Кагоцел"] };

    const enterolactis = await adapter.discover("Энтеролактис", context(shared));
    const kagocel = await adapter.discover("Кагоцел", context(shared));

    expect(enterolactis.map(({ listingId }) => listingId)).toEqual(["111"]);
    expect(kagocel.map(({ listingId }) => listingId)).toEqual(["222"]);
    expect(marketCalls).toBe(1);
    expect(sitemapCalls).toBe(1);
  });

  it("probes Market again after every brand consumes a failed shared Reviews batch", async () => {
    let marketCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith("https://market.yandex.ru/search?")) {
        marketCalls += 1;
        throw new AdapterBlockedError("Market browser is unavailable: HTTP 502");
      }
      if (url === INDEX) throw new AdapterBlockedError("Reviews index is unavailable: HTTP 502");
      throw new Error(`Unexpected URL: ${url}`);
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexMarketBrowserEndpoint?: string };
    fetch.yandexMarketBrowserEndpoint = "https://market.yandex.ru/search";
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 2 });
    const shared = { runId: "run-market-reprobe", brands: ["Энтеролактис", "Кагоцел"] };

    await expect(adapter.discover("Энтеролактис", context(shared))).rejects.toThrow(/Reviews index/);
    await expect(adapter.discover("Кагоцел", context(shared))).rejects.toThrow(/Reviews index/);
    await expect(adapter.discover("Энтеролактис", context(shared))).rejects.toThrow(/Reviews index/);

    expect(marketCalls).toBe(2);
  });

  it("drains an already-started sitemap worker before surfacing its sibling failure", async () => {
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const work = mapWithConcurrency(["first", "second"], 2, async (value) => {
      if (value === "second") {
        markSecondStarted();
        await secondReleased;
        return value;
      }
      await secondStarted;
      throw new Error("first sitemap failed");
    });
    let settled = false;
    void work.then(() => { settled = true; }, () => { settled = true; });

    await secondStarted;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    releaseSecond();
    await expect(work).rejects.toThrow("first sitemap failed");
  });

  it("discovers model cards by Cyrillic brand transliteration and deduplicates modelId", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B])),
      [MAP_A]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/chasy-kagotsel--111",
        "https://reviews.yandex.ru/product/--3252533"
      ])),
      [MAP_B]: xmlResponse(
        modelSitemap([
          "https://reviews.yandex.ru/product/kagotsel-tabletki-12-mg-20-sht--265149860",
          "https://reviews.yandex.ru/product/kagotsel--265149860",
          "https://reviews.yandex.ru/product/ingavirin--265149861"
        ])
      )
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 10 });

    const refs = await adapter.discover("Кагоцел", context());

    expect(new Set(refs.map(({ listingId }) => listingId))).toEqual(new Set(["265149860", "111"]));
    expect(refs.find(({ listingId }) => listingId === "265149860")?.url).toBe(
      "https://reviews.yandex.ru/product/kagotsel--265149860"
    );
    expect(refs.some(({ listingId }) => listingId === "3252533")).toBe(false);
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

  it("accepts the current mixed root index but scans only product model maps", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([
        SHOP_MAP_SYMBOLS,
        MAP_B,
        SHOP_MAP_DIGITS,
        SHOP_MAP_DIGITS_END,
        SHOP_MAP_LETTERS,
        SHOP_MAP_LETTERS_END
      ])),
      [MAP_B]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/kagotsel--265149860"
      ]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 1 });

    await expect(adapter.discover("kagotsel", context())).resolves.toMatchObject([
      { listingId: "265149860" }
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("sitemap_shop_"), expect.anything());
  });

  it("scans every shard in a live-sized cold index without a synthetic whole-pass deadline", async () => {
    const maps = Array.from({ length: 319 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    let inFlight = 0;
    let peak = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Four workers still inspect all 319 shards. The caller owns the
      // run deadline, so a healthy complete pass is not cut off mid-scan.
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return xmlResponse(modelSitemap(url === maps[17]
        ? ["https://reviews.yandex.ru/product/baktoblis-sashe--170000001"]
        : []));
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 319 });

    await expect(adapter.discover("Бактоблис", context())).resolves.toMatchObject([
      { listingId: "170000001", brand: "Бактоблис" }
    ]);
    expect(fetch).toHaveBeenCalledTimes(320);
    expect(peak).toBe(4);
  });

  it("aggregates an exhaustive 319-shard batch proof without handing every shard back to the Agent", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = Array.from({ length: 319 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    const batches: string[][] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      if (url !== batchEndpoint) throw new Error(`Unexpected per-shard handoff: ${url}`);
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[]; brands: Array<{ brand: string }> };
      batches.push(request.sitemaps);
      const match = request.sitemaps.includes(maps[17]!);
      return new Response(JSON.stringify({
        processed: request.sitemaps.length,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps.at(-1),
        verifiedSitemaps: request.sitemaps,
        matches: match ? [{
          brand: request.brands[0]!.brand,
          url: "https://reviews.yandex.ru/product/oscillococcinum--170000001",
          sitemap: maps[17]
        }] : []
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 319 });

    await expect(adapter.discover("oscillococcinum", context())).resolves.toMatchObject([
      { listingId: "170000001", brand: "oscillococcinum" }
    ]);
    expect(batches.flat()).toEqual(maps);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(maps.length);
    expect(fetchMock.mock.calls.filter(([input]) => maps.includes(String(input)))).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1 + maps.length);
  });

  it("keeps two bounded gateway workers and checkpoints verified full-scan milestones", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = Array.from({ length: 36 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    const processed: string[] = [];
    const activity: AdapterActivityEvent[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      if (url !== batchEndpoint) throw new Error(`Unexpected request: ${url}`);
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[] };
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      processed.push(...request.sitemaps);
      return new Response(JSON.stringify({
        processed: request.sitemaps.length,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps.at(-1),
        verifiedSitemaps: request.sitemaps,
        matches: []
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length });

    await expect(adapter.discover("baktoblis", context({
      activity: async (event) => { activity.push(event); }
    }))).resolves.toEqual([]);

    expect(processed.sort()).toEqual([...maps].sort());
    expect(peak).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(36);
    expect(activity.map((event) => ({ operationId: event.operationId, status: event.status, detail: event.detail }))).toEqual([
      {
        operationId: "yandex:gateway-progress",
        status: "active",
        detail: "Проверено карт индекса: 32 из 36"
      },
      {
        operationId: "yandex:gateway-progress",
        status: "complete",
        detail: "Проверено карт индекса: 36 из 36"
      }
    ]);
  });

  it("rejects a singleton batch proof that omits the requested shard", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = [MAP_A];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[] };
      return new Response(JSON.stringify({
        processed: request.sitemaps.length,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps.at(-1),
        verifiedSitemaps: [],
        matches: []
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length, sitemapRetryAttempts: 1, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("baktoblis", context())).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("retries the same exact batch after a transient gateway network failure", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = [MAP_A];
    let batchAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      if (url !== batchEndpoint) throw new Error(`Unexpected request: ${url}`);
      batchAttempts += 1;
      if (batchAttempts === 1) throw new TypeError("fetch failed");
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[]; brands: Array<{ brand: string }> };
      return new Response(JSON.stringify({
        processed: request.sitemaps.length,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps.at(-1),
        verifiedSitemaps: request.sitemaps,
        matches: [{
          brand: request.brands[0]!.brand,
          url: "https://reviews.yandex.ru/product/baktoblis--170000001",
          sitemap: request.sitemaps[0]
        }]
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({
      fetch,
      maxSitemaps: maps.length,
      sitemapRetryAttempts: 3,
      batchRetryAttempts: 2,
      sitemapRetryBaseMs: 0
    });

    await expect(adapter.discover("baktoblis", context())).resolves.toMatchObject([
      { listingId: "170000001", brand: "baktoblis" }
    ]);
    expect(batchAttempts).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body))
      .toEqual([fetchMock.mock.calls[1]![1]?.body, fetchMock.mock.calls[1]![1]?.body]);
  });

  it.each([500, 502, 503, 504])("retries only the transient HTTP %i batch without restarting proven sitemap chunks", async (failureStatus) => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = [MAP_A];
    let batchAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[]; brands: Array<{ brand: string }> };
      batchAttempts += 1;
      if (batchAttempts === 1) {
        return new Response(JSON.stringify({ error: "transient exact shard timeout" }), {
          status: failureStatus,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        processed: request.sitemaps.length,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps.at(-1),
        verifiedSitemaps: request.sitemaps,
        matches: [{
          brand: request.brands[0]!.brand,
          url: "https://reviews.yandex.ru/product/baktoblis--170000001",
          sitemap: request.sitemaps[0]
        }]
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({
      fetch,
      maxSitemaps: maps.length,
      sitemapRetryAttempts: 2,
      batchRetryAttempts: 2,
      sitemapRetryBaseMs: 0
    });

    await expect(adapter.discover("baktoblis", context())).resolves.toMatchObject([
      { listingId: "170000001", brand: "baktoblis" }
    ]);
    expect(batchAttempts).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body))
      .toEqual([fetchMock.mock.calls[1]![1]?.body, fetchMock.mock.calls[1]![1]?.body]);
  });

  it("finishes healthy shards and recovers only the failed singleton in a serial round", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = [MAP_A, MAP_B];
    const activity: AdapterActivityEvent[] = [];
    let failedShardAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[]; brands: Array<{ brand: string }> };
      const sitemap = request.sitemaps[0]!;
      if (sitemap === MAP_A) {
        failedShardAttempts += 1;
        if (failedShardAttempts <= 1) {
          return new Response(JSON.stringify({ error: "transient exact egress stall" }), {
            status: 502,
            headers: { "content-type": "application/json" }
          });
        }
      }
      return new Response(JSON.stringify({
        processed: 1,
        firstSitemap: sitemap,
        lastSitemap: sitemap,
        verifiedSitemaps: [sitemap],
        matches: sitemap === MAP_A ? [{
          brand: request.brands[0]!.brand,
          url: "https://reviews.yandex.ru/product/baktoblis--1234567",
          sitemap
        }] : []
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("baktoblis", context({
      activity: async (event) => { activity.push(event); }
    }))).resolves.toMatchObject([{ listingId: "1234567", brand: "baktoblis" }]);
    expect(failedShardAttempts).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
    expect(activity.filter((event) => event.operationId === "yandex:gateway-recovery").map(({ status }) => status))
      .toEqual(["active", "complete"]);
  });

  it("defers one failed singleton and retries only its exact proof in the serial recovery round", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = [MAP_A];
    let batchAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      if (url !== batchEndpoint) throw new Error(`Unexpected request: ${url}`);
      batchAttempts += 1;
      return new Response(JSON.stringify({
        error: `Yandex batch shard remained unproven: ${maps[0]}: terminated`
      }), { status: 502, headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("Энтеролактис", context())).rejects.toMatchObject({
      message: expect.stringContaining("terminated")
    });
    expect(batchAttempts).toBe(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body))
      .toEqual(Array.from({ length: 2 }, () => fetchMock.mock.calls[1]![1]?.body));
  });

  it("bounds a gateway request that never returns and fails closed", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      return await new Promise<Response>(() => undefined);
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({
      fetch,
      maxSitemaps: 1,
      sitemapRetryAttempts: 1,
      sitemapRetryBaseMs: 0,
      batchRequestTimeoutMs: 10
    });

    await expect(adapter.discover("Бактоблис", context())).rejects.toMatchObject({
      message: expect.stringContaining("Yandex batch proof request failed")
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("rejects a partial batch aggregate even when an earlier chunk contained a match", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = Array.from({ length: 9 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[]; brands: Array<{ brand: string }> };
      if (request.sitemaps.length === 1) return new Response("transient shard failure", { status: 502 });
      return new Response(JSON.stringify({
        processed: request.sitemaps.length,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps.at(-1),
        verifiedSitemaps: request.sitemaps,
        matches: [{
          brand: request.brands[0]!.brand,
          url: "https://reviews.yandex.ru/product/oscillococcinum--170000001",
          sitemap: request.sitemaps[0]
        }]
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 9, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("oscillococcinum", context())).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("finishes healthy siblings and serially retries only the failed singleton before rejecting", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = Array.from({ length: 4 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    const activity: AdapterActivityEvent[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[] };
      if (request.sitemaps[0] === maps[0]) return new Response(JSON.stringify({
        error: `Yandex batch shard remained unproven: ${maps[0]}`
      }), { status: 502, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        processed: 1,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps[0],
        verifiedSitemaps: request.sitemaps,
        matches: []
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & { yandexBatchEndpoint?: string };
    fetch.yandexBatchEndpoint = batchEndpoint;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("Церетон", context({
      activity: async (event) => { activity.push(event); }
    }))).rejects.toMatchObject({
      message: `Yandex batch proof failed with HTTP 502: Yandex batch shard remained unproven: ${maps[0]}`
    });
    const postedSitemaps = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { sitemaps: string[] }).sitemaps[0]);
    expect(postedSitemaps.filter((sitemap) => sitemap === maps[0])).toHaveLength(2);
    for (const sitemap of maps.slice(1)) expect(postedSitemaps.filter((value) => value === sitemap)).toHaveLength(1);
    expect(activity.filter((event) => event.status === "warning")).toHaveLength(1);
  });

  it("recovers only failed gateway singletons through complete browser XML proof", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = Array.from({ length: 4 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    const activity: AdapterActivityEvent[] = [];
    let directRecoveryRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      if (url === maps[0] && new Headers(init?.headers).get("x-ratings-yandex-direct-recovery") === "1") {
        directRecoveryRequests += 1;
        return xmlResponse(modelSitemap([
          "https://reviews.yandex.ru/product/kagotsel-tabletki--111"
        ]));
      }
      if (url !== batchEndpoint) throw new Error(`Unexpected request: ${url}`);
      const request = JSON.parse(String(init?.body)) as { sitemaps: string[] };
      if (request.sitemaps[0] === maps[0]) {
        return new Response(JSON.stringify({
          error: `Yandex batch shard remained unproven: ${maps[0]}`
        }), { status: 502, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        processed: 1,
        firstSitemap: request.sitemaps[0],
        lastSitemap: request.sitemaps[0],
        verifiedSitemaps: request.sitemaps,
        matches: []
      }), { headers: { "content-type": "application/json" } });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & {
      yandexBatchEndpoint?: string;
      yandexDirectRecovery?: boolean;
    };
    fetch.yandexBatchEndpoint = batchEndpoint;
    fetch.yandexDirectRecovery = true;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length, sitemapRetryBaseMs: 0 });

    const refs = await adapter.discover("Кагоцел", context({
      activity: async (event) => { activity.push(event); }
    }));

    expect(refs).toEqual([
      expect.objectContaining({ listingId: "111", brand: "Кагоцел" })
    ]);
    expect(directRecoveryRequests).toBe(1);
    const postedSitemaps = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { sitemaps: string[] }).sitemaps[0]);
    expect(postedSitemaps.filter((sitemap) => sitemap === maps[0])).toHaveLength(1);
    expect(activity).toContainEqual(expect.objectContaining({
      operationId: "yandex:gateway-recovery",
      status: "complete",
      channels: ["browser"]
    }));
  });

  it("opens the gateway circuit and proves the untouched tail through browser XML", async () => {
    const batchEndpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const maps = Array.from({ length: 12 }, (_value, index) =>
      `https://reviews.yandex.ru/ugcpub/sitemap_model_${index * 10_000_000}-${index * 10_000_000 + 9_999_999}-0.xml`
    );
    const directSitemaps: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex(maps));
      if (maps.includes(url) && new Headers(init?.headers).get("x-ratings-yandex-direct-recovery") === "1") {
        directSitemaps.push(url);
        return xmlResponse(modelSitemap([]));
      }
      if (url !== batchEndpoint) throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify({ error: "fixed gateway quota is unavailable" }), {
        status: 502,
        headers: { "content-type": "application/json" }
      });
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch & {
      yandexBatchEndpoint?: string;
      yandexDirectRecovery?: boolean;
    };
    fetch.yandexBatchEndpoint = batchEndpoint;
    fetch.yandexDirectRecovery = true;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: maps.length, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("Кагоцел", context())).resolves.toEqual([]);

    const gatewayCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(gatewayCalls.length).toBeGreaterThanOrEqual(4);
    expect(gatewayCalls.length).toBeLessThan(maps.length);
    expect(new Set(directSitemaps)).toEqual(new Set(maps));
  });

  it("propagates the caller deadline instead of returning partial sitemap matches", async () => {
    const deadline = new AbortController();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      if (init?.signal?.aborted) throw init.signal.reason;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 1, sitemapRetryAttempts: 1 });

    const discovery = adapter.discover("Бактоблис", context({ signal: deadline.signal }));
    deadline.abort(new Error("run_deadline_exceeded"));

    await expect(discovery).rejects.toThrow("run_deadline_exceeded");
  });

  it("fails closed before scanning when the sitemap index exceeds the cap", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, MAP_B, MAP_C]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 1 });

    await expect(
      adapter.discover("Кагоцел", context({ previousIds: ["yandex:265149860"], refreshDiscovery: true }))
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

  it("assigns an overlapping Yandex model to the longest requested brand only", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/vidora-mikro-tabletki--301",
        "https://reviews.yandex.ru/product/vidora-tabletki--302"
      ]))
    });
    const adapter = new YandexAdapter({ fetch });
    const shared = { runId: "run-overlapping-brands", brands: ["Видора", "Видора Микро"] } as const;

    const [vidora, vidoraMicro] = await Promise.all([
      adapter.discover("Видора", context(shared)),
      adapter.discover("Видора Микро", context(shared))
    ]);

    expect(vidora.map(({ listingId }) => listingId)).toEqual(["302"]);
    expect(vidoraMicro.map(({ listingId }) => listingId)).toEqual(["301"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("isolates one brand candidate overflow without poisoning cached results for other brands", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/canpol-babies-a--101",
        "https://reviews.yandex.ru/product/canpol-babies-b--102",
        "https://reviews.yandex.ru/product/canpol-babies-c--103",
        "https://reviews.yandex.ru/product/kagotsel-tabletki-10--201",
        "https://reviews.yandex.ru/product/kagotsel-tabletki-20--202"
      ]))
    });
    const adapter = new YandexAdapter({ fetch, maxCandidates: 2 });
    const shared = { runId: "run-overflow-isolation", brands: ["Canpol Babies", "kagotsel"] } as const;

    const [canpol, kagotsel] = await Promise.allSettled([
      adapter.discover("Canpol Babies", context(shared)),
      adapter.discover("kagotsel", context(shared))
    ]);

    expect(canpol).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "Yandex discovery for Canpol Babies found more than 2 distinct models"
      })
    });
    expect(kagotsel).toMatchObject({
      status: "fulfilled",
      value: [
        expect.objectContaining({ listingId: "201", brand: "kagotsel" }),
        expect.objectContaining({ listingId: "202", brand: "kagotsel" })
      ]
    });
    await expect(adapter.discover("kagotsel", context(shared))).resolves.toHaveLength(2);
    await expect(adapter.discover("Canpol Babies", context(shared))).rejects.toThrow(
      "Yandex discovery for Canpol Babies found more than 2 distinct models"
    );
    expect(fetch).toHaveBeenCalledTimes(2);
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
          : xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/ingavirin--265000112"]));
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
      { listingId: "265000112", brand: "ingavirin" }
    ]);

    expect(mapARequests).toBe(2);
    expect(mapBRequests).toBe(2);
  });

  it("shares one failed full scan across sequential brands before allowing a later retry", async () => {
    let modelRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_A]));
      if (url === MAP_A) {
        modelRequests += 1;
        return xmlResponse("<html>changed</html>");
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch });
    const shared = { runId: "run-sequential-failure", brands: ["kagotsel", "ingavirin", "arbidol"] } as const;

    await expect(adapter.discover("kagotsel", context(shared))).rejects.toBeInstanceOf(ParserChangedError);
    await expect(adapter.discover("ingavirin", context(shared))).rejects.toBeInstanceOf(ParserChangedError);
    await expect(adapter.discover("arbidol", context(shared))).rejects.toBeInstanceOf(ParserChangedError);
    expect(modelRequests).toBe(1);

    await expect(adapter.discover("kagotsel", context(shared))).rejects.toBeInstanceOf(ParserChangedError);
    expect(modelRequests).toBe(2);
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains an exact saved Market reviews URL for a known-first collection", async () => {
    const fetch = vi.fn(async () => { throw new Error("discovery must not fetch"); }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch });
    const marketUrl = "https://market.yandex.ru/card/mikroginon-tab-po/103544271955/reviews";

    const refs = await adapter.discover("Микрогинон", context({
      previousIds: ["103544271955"],
      previousRefs: [{
        listingId: "103544271955",
        url: marketUrl,
        title: "Микрогинон таблетки п/о 150мкг+30мкг 21шт"
      }]
    }));

    expect(refs).toMatchObject([{
      listingId: "103544271955",
      url: marketUrl,
      title: "Микрогинон таблетки п/о 150мкг+30мкг 21шт",
      metadata: { discovery: "previous_registry" }
    }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks saved models without the index and scans for new cards only on explicit refresh", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: xmlResponse(modelSitemap([
        "https://reviews.yandex.ru/product/kagotsel-new--777"
      ]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: 1 });

    await expect(adapter.healthCheck(context({ previousIds: ["265149860"] }))).resolves.toMatchObject({ ok: true });
    await expect(adapter.discover("Кагоцел", context({ previousIds: ["265149860"] }))).resolves.toMatchObject([
      { listingId: "265149860", metadata: { discovery: "previous_registry" } }
    ]);
    expect(fetch).not.toHaveBeenCalled();

    const refreshed = await adapter.discover("Кагоцел", context({
      previousIds: ["265149860"],
      refreshDiscovery: true
    }));

    expect(refreshed.map((item) => item.listingId)).toEqual(["265149860", "777"]);
    expect(fetch).toHaveBeenCalledTimes(2);
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
          : xmlResponse(sitemapIndex([MAP_B]));
      }
      if (url === MAP_B) {
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
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_B]));
      if (url === MAP_B) {
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
      if (url === INDEX) return xmlResponse(sitemapIndex([MAP_B]));
      if (url === MAP_B) {
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

  it("fails closed when a model sitemap declared by the current index disappears", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A])),
      [MAP_A]: new Response("missing", { status: 404 })
    });
    const adapter = new YandexAdapter({ fetch, sitemapRetryBaseMs: 0 });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts only the current proven Yandex index tombstones as non-product shards", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([...CURRENT_INDEX_TOMBSTONES, MAP_B])),
      ...Object.fromEntries(CURRENT_INDEX_TOMBSTONES.map((sitemap) => [sitemap, new Response(null, { status: 404 })])),
      [MAP_B]: xmlResponse(modelSitemap(["https://reviews.yandex.ru/product/kagotsel--265149860"]))
    });
    const adapter = new YandexAdapter({ fetch, maxSitemaps: CURRENT_INDEX_TOMBSTONES.length + 1 });

    await expect(adapter.discover("kagotsel", context())).resolves.toMatchObject([
      { listingId: "265149860" }
    ]);
    expect(fetch).toHaveBeenCalledTimes(CURRENT_INDEX_TOMBSTONES.length + 2);
  });

  it("fails closed when the root index contains an unknown sitemap shape", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, "https://evil.example/sitemap_model_1-2-0.xml"]))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(ParserChangedError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed when the root index adds an unknown same-origin sitemap family", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([
        MAP_A,
        "https://reviews.yandex.ru/ugcpub/sitemap_brand_a-b-0.xml"
      ]))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(ParserChangedError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    "https://reviews.yandex.ru/ugcpub/sitemap_shop_a-z-0.xml",
    `${SHOP_MAP_DIGITS}?changed=1`,
    `${SHOP_MAP_LETTERS}#changed`
  ])("fails closed for a non-canonical shop sitemap: %s", async (unknownShopMap) => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([MAP_A, unknownShopMap]))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(ParserChangedError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed when the root index contains only shop maps", async () => {
    const fetch = routeFetch({
      [INDEX]: xmlResponse(sitemapIndex([SHOP_MAP_SYMBOLS, SHOP_MAP_DIGITS]))
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.discover("kagotsel", context())).rejects.toBeInstanceOf(ParserChangedError);
    expect(fetch).toHaveBeenCalledOnce();
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
  it("bounds a product request that never returns and fails closed", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const adapter = new YandexAdapter({ fetch: fetch as typeof globalThis.fetch, productRequestTimeoutMs: 10 });

    await expect(adapter.collect(ref({
      listingId: "126122882",
      brand: "Бактоблис",
      url: "https://reviews.yandex.ru/product/126122882"
    }), context())).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not attach a reviewed tablet variant to the source-bound Baktoblis sachet model", async () => {
    const listingId = "5705860403";
    const url = `https://reviews.yandex.ru/product/baktoblis-sashe--${listingId}`;
    const html = productHtml({
      canonical: url,
      product: {
        "@type": "Product",
        name: "БактоБЛИС саше",
        brand: "БактоБЛИС",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 1, ratingCount: 1, ratingValue: 5 }
      }
    }).replace("</body>", `
      <div class="Review-ReasonToTrustText">Товар — Бактоблис+ Таб. д/Рассас.No90</div>
    </body>`);
    const adapter = new YandexAdapter({ fetch: routeFetch({ [url]: htmlResponse(html) }) });

    const observation = await adapter.collect(ref({ listingId, brand: "Бактоблис", url }), context());

    expect(observation).toMatchObject({ product: "БактоБЛИС саше", reviews: 1, rating: 5, status: "ok" });
    expect(observation.productEvidence?.variants).toEqual(["БактоБЛИС саше"]);
    expect(observation.productEvidence?.signals).not.toContainEqual({
      source: "variant",
      text: "Бактоблис+ Таб. д/Рассас.No90"
    });
  });

  it("rejects an incompatible same-form reasonToTrust when the Yandex model title is already exact", async () => {
    const listingId = "1321891876";
    const url = `https://reviews.yandex.ru/product/baktoblis-bez-sakhara-tabletki-dlia-rassasyvaniia-massoi-810-mg-30-sht--${listingId}`;
    const modelTitle = "Бактоблис без сахара таблетки для рассасывания массой 810 мг 30 шт";
    const incompatibleReviewedTitle = "БактоБЛИС+ таблетки для рассасывания 950 мг, 30шт";
    const html = productHtml({
      canonical: url,
      product: {
        "@type": "Product",
        name: modelTitle,
        brand: "БактоБЛИС",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 4, ratingCount: 6, ratingValue: 5 }
      }
    }).replace("</body>", `
      <div class="Review-ReasonToTrustText">Товар — ${incompatibleReviewedTitle}</div>
    </body>`);
    const adapter = new YandexAdapter({ fetch: routeFetch({ [url]: htmlResponse(html) }) });

    const observation = await adapter.collect(ref({ listingId, brand: "Бактоблис", url }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl,
      evidence: observation.productEvidence
    });

    expect(observation.productEvidence).toMatchObject({ scope: "listing", variants: [] });
    expect(observation.productEvidence?.signals).not.toContainEqual({
      source: "variant",
      text: incompatibleReviewedTitle
    });
    expect(identity).toMatchObject({
      label: "без сахара таблетки для рассасывания 810 мг №30",
      granularity: "variant",
      confidence: "exact"
    });
  });

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
      source: "variant",
      text: "Хондрофен мазь для наружного применения 30 г 1 шт"
    });
    expect(identity).toMatchObject({
      label: "мазь 30 г",
      granularity: "variant",
      confidence: "exact"
    });
    expect(identity.label).not.toContain("50 г");
  });

  it("keeps genuinely different source-bound packs visible under one proven Yandex model aggregate", async () => {
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

    expect(identity).toMatchObject({ granularity: "family", confidence: "exact", variantCount: 2 });
    expect(identity.label).toContain("мазь 30 г");
    expect(identity.label).toContain("мазь 50 г");
    expect(hasDeterministicAggregateProof({ ...observation, productIdentity: identity })).toBe(true);
  });

  it("collapses equivalent Trombolix Pro offer spellings into one exact product variant", async () => {
    const listingId = "1016049020";
    const url = `https://reviews.yandex.ru/product/tromboliks-pro--${listingId}`;
    const html = productHtml({
      canonical: url,
      product: {
        "@type": "Product",
        name: "Тромболикс Про",
        brand: "Тромболикс Про",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 17, ratingCount: 25, ratingValue: 4.8 }
      }
    }).replace("</body>", `
      <div class="Review-ReasonToTrustText">Товар — Тромболикс Про раствор для в/в и в/м введ. 600ЛЕ/2мл 2мл 10шт</div>
      <div class="Review-ReasonToTrustText">Товар — Тромболикс Про раствор для в/в и в/м введ 600 ле/2мл 2 мл амп 10 шт</div>
    </body>`);
    const adapter = new YandexAdapter({ fetch: routeFetch({ [url]: htmlResponse(html) }) });

    const observation = await adapter.collect(ref({ listingId, brand: "Тромболикс Про", url }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl,
      evidence: observation.productEvidence
    });

    expect(observation.productEvidence).toMatchObject({ scope: "product_family" });
    expect(observation.productEvidence?.variants).toHaveLength(2);
    expect(identity).toMatchObject({
      label: "раствор для внутривенного и внутримышечного введения 2 мл №10",
      granularity: "variant",
      confidence: "exact"
    });
  });

  it("publishes Cereton packs as one explicit shared-rating model instead of an unconfirmable ambiguity", async () => {
    const listingId = "1778172988";
    const url = `https://reviews.yandex.ru/product/tsereton-kaps--${listingId}`;
    const html = productHtml({
      canonical: url,
      product: {
        "@type": "Product",
        name: "Церетон капс.",
        brand: "Церетон",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 101, ratingCount: 438, ratingValue: 4.7 }
      }
    }).replace("</body>", `
      <div class="Review-ReasonToTrustText">Товар — Церетон, капсулы 400 мг, 112 шт.</div>
      <div class="Review-ReasonToTrustText">Товар — Церетон, капсулы 400 мг, 56 шт.</div>
    </body>`);
    const adapter = new YandexAdapter({ fetch: routeFetch({ [url]: htmlResponse(html) }) });

    const observation = await adapter.collect(ref({ listingId, brand: "Церетон", url }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl,
      evidence: observation.productEvidence
    });

    expect(identity).toMatchObject({ granularity: "family", confidence: "exact", variantCount: 2 });
    expect(identity.label).toContain("капсулы 400 мг №112");
    expect(identity.label).toContain("капсулы 400 мг №56");
    expect(hasDeterministicAggregateProof({ ...observation, productIdentity: identity })).toBe(true);
  });

  it("drops a source-unbound stale model without blocking the complete Yandex partition", async () => {
    const listingId = "5887938423";
    const url = `https://reviews.yandex.ru/product/tsereton-kaps--${listingId}`;
    const adapter = new YandexAdapter({
      fetch: routeFetch({
        [url]: htmlResponse(productHtml({
          // This is the exact malformed canonical currently returned by the
          // first-party page. It cannot bind the aggregate to the discovered
          // model and therefore must never be published.
          canonical: `https://reviews.yandex.ru${listingId}`,
          product: {
            "@type": "Product",
            name: "Церетон капс.",
            aggregateRating: { "@type": "AggregateRating", reviewCount: 3, ratingCount: 31, ratingValue: 4.9 }
          }
        }))
      })
    });

    await expect(adapter.collect(ref({ listingId, brand: "Церетон", url }), context())).resolves.toMatchObject({
      listingId,
      status: "not_found",
      reviews: null,
      rating: null,
      source: "yandex_reviews_missing_candidate"
    });
  });

  it.each([
    ["1897545674", "Церетон р-р д/вн. приема", "Церетон раствор для приема внутрь", 22, 27, 4.8],
    ["1404748455", "Церетон р-р для в/в и в/м введ.", "Церетон раствор для в/в и в/м введ.", 16, 37, 4.7]
  ])("uses the first-party model title as exact family evidence for Cereton model %s", async (
    listingId,
    title,
    expandedTitle,
    reviewCount,
    ratingCount,
    ratingValue
  ) => {
    const url = `https://reviews.yandex.ru/product/tsereton--${listingId}`;
    const adapter = new YandexAdapter({
      fetch: routeFetch({
        [url]: htmlResponse(productHtml({
          canonical: url,
          product: {
            "@type": "Product",
            name: title,
            brand: "Церетон",
            aggregateRating: { "@type": "AggregateRating", reviewCount, ratingCount, ratingValue }
          }
        }))
      })
    });

    const observation = await adapter.collect(ref({ listingId, brand: "Церетон", url }), context());
    const identity = analyzeProductIdentity({
      brand: observation.brand,
      product: observation.product,
      url: observation.canonicalUrl,
      evidence: observation.productEvidence
    });

    expect(observation.productEvidence).toMatchObject({
      scope: "product_family",
      variants: [expandedTitle]
    });
    expect(identity).toMatchObject({
      granularity: "family",
      confidence: "exact",
      missing: [],
      variantCount: 1
    });
    expect(hasDeterministicAggregateProof({ ...observation, productIdentity: identity })).toBe(true);
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

  it("drops a translated 404 candidate without blocking other current Yandex cards", async () => {
    const modelId = "5881130484";
    const directUrl = `https://reviews.yandex.ru/product/baktoblis--${modelId}`;
    const translatedUrl = `https://reviews-yandex-ru.translate.goog/product/${modelId}?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`;
    const fetch = routeFetch({
      [directUrl]: new Response("blocked", { status: 403 }),
      [translatedUrl]: new Response("missing", { status: 404 })
    });
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({ listingId: modelId, brand: "\u0411\u0430\u043a\u0442\u043e\u0431\u043b\u0438\u0441", url: directUrl }), context()))
      .resolves.toMatchObject({
        listingId: modelId,
        reviews: null,
        rating: null,
        status: "not_found",
        source: "yandex_reviews_missing_candidate"
      });
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
      rating: 4.75,
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

  it("collects a saved Market card through the bounded translated JSON-LD route", async () => {
    const listingId = "103544271955";
    const marketUrl = `https://market.yandex.ru/card/mikroginon-tab-po/${listingId}/reviews`;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(
        `https://market-yandex-ru.translate.goog/card/mikroginon-tab-po/${listingId}/reviews?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`
      );
      expect(request.headers.get("x-ratings-browser")).toBeNull();
      return new Response(marketJsonLdHtml({
        url: marketUrl,
        title: "?????????? ???????? ?/? 150???+30??? 21??",
        rating: 5,
        ratingCount: 15,
        reviewCount: 1
      }), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-ratings-final-url": marketUrl
        }
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new YandexAdapter({ fetch });

    await expect(adapter.collect(ref({
      listingId,
      brand: "Микрогинон",
      url: marketUrl,
      title: "Микрогинон таблетки п/о 150мкг+30мкг 21шт"
    }), context({ brands: ["Микрогинон", "Видора Микро", "Видора"] }))).resolves.toMatchObject({
      listingId,
      canonicalUrl: marketUrl,
      product: "Микрогинон таблетки п/о 150мкг+30мкг 21шт",
      reviews: 15,
      writtenReviewCount: 1,
      ratingCount: 15,
      rating: 5,
      status: "ok",
      source: "yandex_market_json_ld_google_translate"
    });
  });

  it("does not accept a saved Видора Микро Market card under the shorter Видора brand", async () => {
    const listingId = "103544253024";
    const marketUrl = `https://market.yandex.ru/card/vidora-mikro-244-tab-po-plen/${listingId}/reviews`;
    const adapter = new YandexAdapter({
      fetch: (async () => new Response(marketCardHtml({
        title: "Видора Микро таблетки п/о плен. 3мг+0,02мг 24+4шт",
        rating: "4.9",
        ratingCount: 18,
        reviewCount: 4
      }), { headers: { "x-ratings-final-url": marketUrl } })) as typeof globalThis.fetch
    });

    await expect(adapter.collect(ref({ listingId, brand: "Видора", url: marketUrl }), context({
      brands: ["Видора Микро", "Видора"]
    }))).resolves.toMatchObject({ status: "needs_review", reviews: 18, rating: 4.9 });
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

function marketCardHtml({
  title,
  rating,
  ratingCount,
  reviewCount
}: {
  title: string;
  rating: string;
  ratingCount: number;
  reviewCount: number;
}): string {
  return `<!doctype html><html><body><h1>${title}</h1>` +
    `<a aria-label="Рейтинг товара: ${rating} из 5"><span>${rating}</span><span>(${ratingCount})</span></a>` +
    `<section><h2>Отзывы и оценки</h2><div>${ratingCount} оценок</div><div>${reviewCount} отзыв</div></section>` +
    `</body></html>`;
}

function marketJsonLdHtml({
  url,
  title,
  rating,
  ratingCount,
  reviewCount
}: {
  url: string;
  title: string;
  rating: number;
  ratingCount: number;
  reviewCount: number;
}): string {
  return `<!doctype html><html><head><base href="${url}"></head><body>` +
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: title,
      url,
      aggregateRating: {
        "@type": "AggregateRating",
        bestRating: 5,
        ratingValue: rating,
        ratingCount,
        reviewCount
      }
    })}</script></body></html>`;
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
