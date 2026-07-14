import { afterEach, describe, expect, it, vi } from "vitest";
import { observationSchema, type AdapterContext } from "../src/shared/types.js";
import {
  AdapterBlockedError,
  AdapterQuotaError,
  ParserChangedError
} from "../src/server/adapters/errors.js";
import {
  WildberriesApifyAdapter,
  type WildberriesApifyAdapterOptions
} from "../src/server/adapters/wildberries-apify.js";

const NOW = new Date("2026-07-13T17:20:00.000Z");
const CONTEXT: AdapterContext = { region: "Москва", month: "2026-07", runId: "run-1" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function listing(
  id: number,
  name: string,
  rating: number,
  reviewsCount: number
): Record<string, unknown> {
  return {
    id,
    url: `https://www.wildberries.ru/catalog/${id}/detail.aspx?targetUrl=GP`,
    name,
    rating,
    reviewsCount
  };
}

function options(overrides: Partial<WildberriesApifyAdapterOptions> = {}): WildberriesApifyAdapterOptions {
  return {
    token: "test-token",
    maxItems: 10,
    maxTotalChargeUsd: 0.01,
    timeoutSeconds: 120,
    now: () => NOW,
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WildberriesApifyAdapter discovery", () => {
  it("uses the bounded Moscow listing contract and returns unique matching nmIds", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      listing(822686443, "Кагоцел таблетки 12 мг 20 шт", 4.9, 106),
      listing(822686443, "Кагоцел таблетки 12 мг 20 шт", 4.9, 106),
      listing(822662670, "Кагоцел таблетки 12 мг 10 шт", 0, 0),
      listing(1211776162, "5-ярусный ящик для хранения лекарств Аптечка", 0, 0)
    ]));
    const adapter = new WildberriesApifyAdapter(options({
      fetch: fetchSpy as unknown as typeof fetch
    }));

    const refs = await adapter.discover("Кагоцел", CONTEXT);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, CONTEXT)));

    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => ref.listingId)).toEqual(["822686443", "822662670"]);
    expect(refs[0]).toMatchObject({
      domain: "wildberries.ru",
      platform: "wildberries",
      listingId: "822686443",
      url: "https://www.wildberries.ru/catalog/822686443/detail.aspx",
      title: "Кагоцел таблетки 12 мг 20 шт",
      metadata: {
        collector: "wildberries-apify",
        rating: 4.9,
        reviewCount: 106,
        capturedAt: NOW.toISOString(),
        source: "apify:piotrv1001/wildberries-listings-scraper:listing"
      }
    });
    expect(observations).toMatchObject([
      { listingId: "822686443", reviews: 106, rating: 4.9, status: "ok" },
      { listingId: "822662670", reviews: 0, rating: null, status: "no_reviews" }
    ]);
    for (const observation of observations) {
      expect(() => observationSchema.parse(observation)).not.toThrow();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(request));
    expect(url.pathname).toBe(
      "/v2/acts/piotrv1001~wildberries-listings-scraper/run-sync-get-dataset-items"
    );
    expect(url.searchParams.get("maxItems")).toBe("10");
    expect(url.searchParams.get("maxTotalChargeUsd")).toBe("0.01");
    expect(url.searchParams.get("timeout")).toBe("120");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("clean")).toBe("1");
    expect(url.searchParams.get("restartOnError")).toBe("false");
    expect(url.searchParams.get("token")).toBeNull();
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json; charset=utf-8"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      searchQueries: ["Кагоцел"],
      maxItems: 10,
      enrichDetails: false,
      scrapeReviews: false,
      dest: "-1257786",
      sort: "popular",
      maxPagesPerList: 100
    });
  });

  it("accepts a proven empty result", async () => {
    const adapter = new WildberriesApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse([])) as unknown as typeof fetch
    }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).resolves.toEqual([]);
  });

  it("fails closed when the raw dataset reaches the configured cap", async () => {
    const adapter = new WildberriesApifyAdapter(options({
      maxItems: 2,
      fetch: vi.fn(async () => jsonResponse([
        listing(822686443, "Кагоцел таблетки 20 шт", 4.9, 106),
        listing(822662670, "Кагоцел таблетки 10 шт", 5, 68)
      ])) as unknown as typeof fetch
    }));

    const discovery = adapter.discover("Кагоцел", CONTEXT);
    await expect(discovery).rejects.toBeInstanceOf(AdapterQuotaError);
    await expect(discovery).rejects.toThrow("complete discovery was not proven");
  });

  it("fails closed when duplicate nmIds disagree", async () => {
    const adapter = new WildberriesApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse([
        listing(822686443, "Кагоцел таблетки 20 шт", 4.9, 106),
        listing(822686443, "Кагоцел таблетки 20 шт", 4.8, 107)
      ])) as unknown as typeof fetch
    }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toThrow(
      "conflicting duplicates for nmId 822686443"
    );
  });

  it.each([
    ["id", { url: "https://www.wildberries.ru/catalog/1/detail.aspx", name: "Кагоцел", rating: 5, reviewsCount: 1 }],
    ["URL", { id: 1, name: "Кагоцел", rating: 5, reviewsCount: 1 }],
    ["name", { id: 1, url: "https://www.wildberries.ru/catalog/1/detail.aspx", rating: 5, reviewsCount: 1 }],
    ["rating", { id: 1, url: "https://www.wildberries.ru/catalog/1/detail.aspx", name: "Кагоцел", rating: 6, reviewsCount: 1 }],
    ["reviewsCount", { id: 1, url: "https://www.wildberries.ru/catalog/1/detail.aspx", name: "Кагоцел", rating: 5, reviewsCount: 1.5 }],
    ["zero rating", { id: 1, url: "https://www.wildberries.ru/catalog/1/detail.aspx", name: "Кагоцел", rating: 0, reviewsCount: 1 }],
    ["conflicting URL", { id: 1, url: "https://www.wildberries.ru/catalog/2/detail.aspx", name: "Кагоцел", rating: 5, reviewsCount: 1 }],
    ["external URL", { id: 1, url: "https://example.com/catalog/1/detail.aspx", name: "Кагоцел", rating: 5, reviewsCount: 1 }]
  ])("rejects an item with invalid mandatory %s", async (_case, item) => {
    const adapter = new WildberriesApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse([item])) as unknown as typeof fetch
    }));

    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(ParserChangedError);
  });
});

describe("WildberriesApifyAdapter failures and health", () => {
  it("checks Actor availability without starting a paid run", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: { id: "actor" } }));
    const adapter = new WildberriesApifyAdapter(options({
      fetch: fetchSpy as unknown as typeof fetch
    }));

    await expect(adapter.healthCheck(CONTEXT)).resolves.toEqual({
      ok: true,
      checkedAt: NOW.toISOString(),
      message: "Wildberries Apify fallback is available"
    });
    const [request, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(request)).toBe(
      "https://api.apify.com/v2/acts/piotrv1001~wildberries-listings-scraper"
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("does not make requests without APIFY_TOKEN", async () => {
    vi.stubEnv("APIFY_TOKEN", "");
    const fetchSpy = vi.fn();
    const adapter = new WildberriesApifyAdapter({
      token: "",
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW
    });

    await expect(adapter.healthCheck(CONTEXT)).resolves.toEqual({
      ok: false,
      checkedAt: NOW.toISOString(),
      message: "APIFY_TOKEN is not configured"
    });
    await expect(adapter.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps Apify quota and Actor item failures to fail-closed errors", async () => {
    const quota = new WildberriesApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse({
        error: { type: "not-enough-usage", message: "Not enough usage credits" }
      }, 402)) as unknown as typeof fetch
    }));
    await expect(quota.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterQuotaError);

    const itemFailure = new WildberriesApifyAdapter(options({
      fetch: vi.fn(async () => jsonResponse([{ error: "Search request failed" }])) as unknown as typeof fetch
    }));
    await expect(itemFailure.discover("Кагоцел", CONTEXT)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("rejects configurations that can exceed fallback safety limits", () => {
    expect(() => new WildberriesApifyAdapter(options({ maxItems: 0 }))).toThrow(RangeError);
    expect(() => new WildberriesApifyAdapter(options({ maxItems: 251 }))).toThrow(RangeError);
    expect(() => new WildberriesApifyAdapter(options({ maxTotalChargeUsd: 0 }))).toThrow(RangeError);
    expect(() => new WildberriesApifyAdapter(options({ maxTotalChargeUsd: 0.251 }))).toThrow(RangeError);
    expect(() => new WildberriesApifyAdapter(options({ timeoutSeconds: 301 }))).toThrow(RangeError);
    expect(() => new WildberriesApifyAdapter(options({ apiBaseUrl: "http://api.apify.test" }))).toThrow(TypeError);
  });
});
