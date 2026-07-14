import { describe, expect, it, vi } from "vitest";

import type { AdapterContext, ProductRef } from "../src/shared/types.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { WildberriesAdapter } from "../src/server/adapters/wildberries.js";

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
    requestIntervalMs: 0,
    blockedRetryBaseMs: 0,
    sleep: async () => undefined,
    now: () => FIXED_TIME,
    ...overrides
  });
}

describe("WildberriesAdapter.discover", () => {
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
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        products: [{ id: 701, name: "BrandX capsules", nmReviewRating: 4.8, nmFeedbacks: 10 }]
      })) as unknown as typeof globalThis.fetch;
    const adapter = createAdapter(fetchMock, { blockedCooldownMs: 0 });
    const runContext = context({ runId: "run-1" });

    await expect(adapter.discover("BrandX", runContext)).rejects.toBeInstanceOf(AdapterBlockedError);
    await expect(adapter.discover("BrandX", runContext)).resolves.toMatchObject([{ listingId: "701" }]);

    expect(fetchMock).toHaveBeenCalledTimes(5);
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

  it("uses the warmed browser API route only after both direct app types remain blocked", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const headers = new Headers(vi.mocked(fetchMock).mock.calls[2][1]?.headers);
    expect(headers.get("x-ratings-browser")).toBe("1");
    expect(headers.get("x-ratings-browser-mode")).toBe("wildberries-api");
    expect(sleeps).toEqual([10, 30]);
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

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [proofInput, proofInit] = vi.mocked(fetchMock).mock.calls[3];
    const proofUrl = new URL(String(proofInput));
    expect(`${proofUrl.origin}${proofUrl.pathname}`).toBe(
      "https://www.wildberries.ru/catalog/0/search.aspx"
    );
    expect(proofUrl.searchParams.get("search")).toBe("MissingBrand");
    expect(new Headers(proofInit?.headers).get("x-ratings-browser-mode")).toBe(
      "wildberries-search-proof"
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
