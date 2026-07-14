import { describe, expect, it, vi } from "vitest";
import type { SiteProfile } from "../src/shared/types.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import { MemoryRepository } from "../src/server/repository.js";
import { createCollectorRuntime } from "../src/server/runtime.js";

const request = {
  sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
  month: "2026-07",
  region: "Москва",
  domains: ["wildberries.ru", "market.yandex.ru"],
  brands: ["Кагоцел"]
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function urlOf(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function marketplaceFetch(usageUsd: number) {
  let activePaidCalls = 0;
  let maximumPaidCalls = 0;
  const paidPaths: string[] = [];
  const requestedUrls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    requestedUrls.push(url);

    if (url.hostname === "search.wb.ru") {
      return new Response("rate limited", { status: 429 });
    }
    if (url.hostname === "reviews.yandex.ru" && url.pathname === "/ugcpub/sitemap.xml") {
      return new Response("unavailable", { status: 503 });
    }
    if (url.hostname === "reviews.yandex.ru" && url.pathname === "/product/model--265149860") {
      const product = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: `${request.brands[0]} таблетки 12 мг, 20 шт.`,
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: 4.7,
          reviewCount: 711,
          ratingCount: 1827,
          bestRating: 5
        }
      };
      return new Response(
        `<script type="application/ld+json">${JSON.stringify(product)}</script>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    if (url.hostname === "api.apify.com" && url.pathname === "/v2/users/me/usage/monthly") {
      return json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: usageUsd } });
    }
    if (url.hostname === "api.apify.com" && !url.pathname.endsWith("run-sync-get-dataset-items")) {
      return json({ data: { id: "actor" } });
    }
    if (url.hostname === "api.apify.com" && url.pathname.endsWith("run-sync-get-dataset-items")) {
      activePaidCalls += 1;
      maximumPaidCalls = Math.max(maximumPaidCalls, activePaidCalls);
      paidPaths.push(url.pathname);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activePaidCalls -= 1;
      if (url.pathname.includes("piotrv1001~wildberries-listings-scraper")) {
        return json([{
          id: 822686443,
          url: "https://www.wildberries.ru/catalog/822686443/detail.aspx",
          name: "Кагоцел таблетки 12 мг 20 шт",
          rating: 4.9,
          reviewsCount: 106
        }]);
      }
      if (url.pathname.includes("zen-studio~yandex-market-scraper-parser")) {
        return json([{
          modelId: 265149860,
          title: "Кагоцел таблетки 12 мг, 20 шт.",
          canonicalUrl: "https://market.yandex.ru/product--kagotsel/265149860",
          rating: 4.7,
          reviewCount: 711
        }]);
      }
    }

    throw new Error(`Unexpected test request: ${url}`);
  }) as unknown as typeof fetch;

  return {
    fetchMock,
    paidPaths,
    requestedUrls,
    maximumPaidCalls: () => maximumPaidCalls
  };
}

describe("collector runtime fallback integration", () => {
  it("uses one 0.75 USD Ozon batch reservation for every brand in the run", async () => {
    let usageChecks = 0;
    const actorCalls: Array<{ url: URL; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.hostname === "www.ozon.ru") {
        return new Response("captcha", { status: 403 });
      }
      if (url.hostname === "api.apify.com" && url.pathname === "/v2/users/me/usage/monthly") {
        usageChecks += 1;
        return json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 1 } });
      }
      if (url.hostname === "api.apify.com" && url.pathname.endsWith("run-sync-get-dataset-items")) {
        actorCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json([
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
          }
        ]);
      }
      if (url.hostname === "api.apify.com") return json({ data: { id: "actor" } });
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      env: { APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun({
      ...request,
      domains: ["ozon.ru"],
      brands: ["Brand A", "Brand B"]
    })).id);

    expect(run.partitions).toMatchObject([
      { domain: "ozon.ru", brand: "Brand A", status: "complete", discovered: 1, collected: 1 },
      { domain: "ozon.ru", brand: "Brand B", status: "complete", discovered: 1, collected: 1 }
    ]);
    expect(actorCalls).toHaveLength(1);
    expect(usageChecks).toBe(1);
    expect(actorCalls[0].url.searchParams.get("maxTotalChargeUsd")).toBe("0.75");
    expect(actorCalls[0].body.searchQueries).toEqual(["Brand A", "Brand B"]);
  });

  it("completes Wildberries through the alternate free app type without checking or spending Apify", async () => {
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requestedUrls.push(url);
      if (url.hostname === "search.wb.ru") {
        if (url.searchParams.get("appType") === "1") {
          return new Response("rate limited", { status: 429 });
        }
        const isRequestedBrand = url.searchParams.get("query") === request.brands[0];
        return json(isRequestedBrand ? {
          total: 1,
          products: [{
            id: 822686443,
            name: `${request.brands[0]} tablets 12 mg`,
            nmReviewRating: 4.9,
            nmFeedbacks: 106
          }]
        } : { total: 0, products: [] });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      env: { APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun({
      ...request,
      domains: ["wildberries.ru"]
    })).id);

    expect(run.partitions).toMatchObject([{
      domain: "wildberries.ru",
      status: "complete",
      discovered: 1,
      collected: 1
    }]);
    expect(run.observations).toMatchObject([{
      listingId: "822686443",
      reviews: 106,
      rating: 4.9,
      source: "wildberries-search-v18"
    }]);
    expect(requestedUrls.filter((url) => url.hostname === "search.wb.ru").map((url) =>
      url.searchParams.get("appType")
    )).toEqual(["1", "32", "32"]);
    expect(requestedUrls.some((url) => url.hostname === "api.apify.com")).toBe(false);
  });

  it("routes blocked Wildberries and Yandex primary collectors through capped Apify and back to fallback collect", async () => {
    const mocked = marketplaceFetch(1);
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: mocked.fetchMock,
      reviewsFetch: mocked.fetchMock,
      env: { APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun(request)).id);

    expect(run.partitions).toMatchObject([
      { domain: "wildberries.ru", brand: "Кагоцел", status: "complete", discovered: 1, collected: 1 },
      { domain: "market.yandex.ru", brand: "Кагоцел", status: "complete", discovered: 1, collected: 1 }
    ]);
    expect(run.observations).toHaveLength(2);
    expect(run.observations.find((item) => item.domain === "wildberries.ru")).toMatchObject({
      listingId: "822686443",
      reviews: 106,
      rating: 4.9,
      status: "ok",
      source: "apify:piotrv1001/wildberries-listings-scraper:listing"
    });
    expect(run.observations.find((item) => item.domain === "market.yandex.ru")).toMatchObject({
      listingId: "265149860",
      reviews: 711,
      rating: 4.7,
      status: "ok",
      source: "yandex_reviews_json_ld"
    });
    expect(mocked.paidPaths).toHaveLength(2);
    expect(mocked.maximumPaidCalls()).toBe(1);
    expect(mocked.requestedUrls.some((url) => url.hostname === "card.wb.ru")).toBe(false);
  });

  it("fails both fallbacks closed against the common live monthly budget before starting an Actor", async () => {
    const mocked = marketplaceFetch(4.3);
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: mocked.fetchMock,
      env: { APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun(request)).id);

    expect(run.observations).toEqual([]);
    expect(run.partitions).toHaveLength(2);
    expect(run.partitions.every((partition) => partition.status === "blocked")).toBe(true);
    expect(run.errors).toHaveLength(2);
    expect(run.errors.every((error) => error.message.includes("quota_exceeded"))).toBe(true);
    expect(mocked.paidPaths).toEqual([]);
  });

  it("keeps a persistent shared reservation floor when Apify live usage is delayed", async () => {
    const paidCalls: URL[] = [];
    let usageChecks = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.hostname === "search.wb.ru") {
        return new Response("rate limited", { status: 429 });
      }
      if (url.hostname === "api.apify.com" && url.pathname === "/v2/users/me/usage/monthly") {
        usageChecks += 1;
        // Simulate an eventually-consistent usage endpoint which has not yet
        // observed either of the preceding paid Actor calls.
        return json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 0 } });
      }
      if (url.hostname === "api.apify.com" && url.pathname.endsWith("run-sync-get-dataset-items")) {
        paidCalls.push(url);
        return json([]);
      }
      if (url.hostname === "api.apify.com") return json({ data: { id: "actor" } });
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      env: { APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "0.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun({
      ...request,
      domains: ["wildberries.ru"],
      brands: ["Brand A", "Brand B", "Brand C"]
    })).id);

    expect(usageChecks).toBe(3);
    expect(paidCalls).toHaveLength(2);
    expect(paidCalls.every((url) => url.searchParams.get("maxTotalChargeUsd") === "0.25")).toBe(true);
    expect(run.partitions.filter((partition) => partition.status === "no_results")).toHaveLength(2);
    expect(run.partitions.filter((partition) => partition.status === "blocked")).toHaveLength(1);
    expect(run.qa?.ok).toBe(false);
    expect(run.errors.some((error) => error.message.includes("quota_exceeded"))).toBe(true);
  });

  it("leaves an approved unknown domain on the generic adapter path without touching Apify", async () => {
    const profile: SiteProfile = {
      domain: "example.com",
      version: 1,
      status: "approved",
      searchUrlTemplate: "https://example.com/search?q={query}",
      sitemapUrls: [],
      titleSelector: "h1",
      reviewCountSelector: ".reviews",
      ratingSelector: ".rating",
      ratingScale: 5,
      reviewCountMeaning: "reviews",
      rateLimitMs: 0,
      canaryUrls: ["https://example.com/products/kagocel"],
      testExamples: [{ url: "https://example.com/products/kagocel", title: "Кагоцел таблетки" }],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      approvedAt: "2026-07-13T00:00:00.000Z",
      notes: []
    };
    const html = `
      <a href="/products/kagocel">Кагоцел таблетки 12 мг</a>
      <h1>Кагоцел таблетки 12 мг</h1>
      <span class="reviews">12 отзывов</span>
      <span class="rating">4,8</span>
      <script type="application/ld+json">{
        "@type":"Product","name":"Кагоцел таблетки 12 мг",
        "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"12"}
      }</script>`;
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requestedUrls.push(url);
      if (url.hostname !== "example.com") throw new Error(`Unexpected test request: ${url}`);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const repository = new MemoryRepository({ profiles: { "example.com": profile } });
    const runtime = await createCollectorRuntime({
      repository,
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      env: { APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun({
      ...request,
      domains: ["example.com"]
    })).id);

    expect(run.partitions).toMatchObject([
      { domain: "example.com", status: "complete", discovered: 1, collected: 1 }
    ]);
    expect(run.observations).toMatchObject([
      { domain: "example.com", product: "Кагоцел таблетки 12 мг", reviews: 12, rating: 4.8, profileVersion: 1 }
    ]);
    expect(requestedUrls.every((url) => url.hostname === "example.com")).toBe(true);
  });
});
