import { describe, expect, it, vi } from "vitest";
import type { SiteProfile } from "../src/shared/types.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import { MemoryRepository } from "../src/server/repository.js";
import { apifyFallbackEnabled, createCollectorRuntime } from "../src/server/runtime.js";

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
  it("treats only the exact string true as paid-fallback opt-in", () => {
    expect(apifyFallbackEnabled("true")).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", " true ", "1"]) {
      expect(apifyFallbackEnabled(value)).toBe(false);
    }
  });

  it("uses one capped 0.25 USD Ozon batch reservation and ignores stale v2 reservations", async () => {
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
      repository: new MemoryRepository({
        usage: {
          [`apify:v2:${new Date().toISOString().slice(0, 7)}`]: 4.48,
          [`apify:v3:${new Date().toISOString().slice(0, 7)}:${Math.floor(Date.now() / (30 * 60 * 1000))}`]: 4.48
        }
      }),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      env: { APIFY_FALLBACK_ENABLED: "true", APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
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
    expect(actorCalls[0].url.searchParams.get("maxTotalChargeUsd")).toBe("0.25");
    expect(actorCalls[0].body.searchQueries).toEqual(["Brand A", "Brand B"]);
  });

  it("does not turn a second proven-empty Ozon run into quota_exceeded while live usage still lags", async () => {
    let usageChecks = 0;
    let actorCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.hostname === "www.ozon.ru") {
        return new Response("captcha", { status: 403 });
      }
      if (url.hostname === "api.apify.com" && url.pathname === "/v2/users/me/usage/monthly") {
        usageChecks += 1;
        return json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 4.19 } });
      }
      if (url.hostname === "api.apify.com" && url.pathname.endsWith("run-sync-get-dataset-items")) {
        actorCalls += 1;
        return json([]);
      }
      if (url.hostname === "api.apify.com") return json({ data: { id: "actor" } });
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      env: { APIFY_FALLBACK_ENABLED: "true", APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });
    const runRequest = {
      ...request,
      domains: ["ozon.ru"],
      brands: ["No Such Brand"]
    };

    const first = await runtime.service.executeRun((await runtime.service.createRun(runRequest)).id);
    const second = await runtime.service.executeRun((await runtime.service.createRun(runRequest)).id);

    expect(first.partitions).toMatchObject([{ status: "no_results", discovered: 0, collected: 0 }]);
    expect(second.partitions).toMatchObject([{ status: "no_results", discovered: 0, collected: 0 }]);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(actorCalls).toBe(2);
    expect(usageChecks).toBe(2);
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

  it("uses only free adapters by default and reports their failures without touching Apify", async () => {
    const requestedUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requestedUrls.push(url);
      if (url.hostname === "www.ozon.ru") return new Response("captcha", { status: 403 });
      if (url.hostname === "search.wb.ru") return new Response("rate limited", { status: 429 });
      if (url.hostname === "reviews.yandex.ru" && url.pathname === "/ugcpub/sitemap.xml") {
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (url.hostname === "api.apify.com") {
        return json({ data: { totalUsageCreditsUsdAfterVolumeDiscount: 0 } });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      reviewsFetch: fetchMock,
      // A configured token and even an invalid paid-budget value are inert
      // without the explicit opt-in flag.
      env: { APIFY_TOKEN: "must-not-be-used", APIFY_MONTHLY_BUDGET_USD: "not-a-budget" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun({
      ...request,
      domains: ["ozon.ru", "wildberries.ru", "market.yandex.ru"]
    })).id);

    expect(run.observations).toEqual([]);
    expect(run.partitions).toHaveLength(3);
    expect(run.partitions.every((partition) => partition.status === "blocked")).toBe(true);
    expect(run.partitions.every((partition) => !/apify|quota_exceeded|квот/i.test(partition.message ?? ""))).toBe(true);
    expect(requestedUrls.some((url) => url.hostname === "api.apify.com")).toBe(false);
  });

  it("preserves the capped paid marketplace fallbacks only after explicit opt-in", async () => {
    const mocked = marketplaceFetch(1);
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: mocked.fetchMock,
      reviewsFetch: mocked.fetchMock,
      env: { APIFY_FALLBACK_ENABLED: "true", APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
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
    expect(mocked.paidPaths.some((path) => path.includes("piotrv1001~wildberries-listings-scraper"))).toBe(true);
    expect(mocked.paidPaths.some((path) => path.includes("yandex-market-scraper"))).toBe(true);
    expect(mocked.maximumPaidCalls()).toBe(1);
    expect(mocked.requestedUrls.some((url) => url.hostname === "card.wb.ru")).toBe(false);
  });

  it("fails every explicitly enabled paid fallback against the common budget before Actor start", async () => {
    const mocked = marketplaceFetch(4.3);
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: mocked.fetchMock,
      env: { APIFY_FALLBACK_ENABLED: "true", APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });

    const run = await runtime.service.executeRun((await runtime.service.createRun(request)).id);

    expect(run.observations).toEqual([]);
    expect(run.partitions).toHaveLength(2);
    expect(run.partitions.every((partition) => partition.status === "blocked")).toBe(true);
    expect(run.partitions.every((partition) => partition.message?.includes("quota_exceeded"))).toBe(true);
    expect(run.errors).toHaveLength(2);
    expect(run.errors.every((error) => error.message.includes("quota_exceeded"))).toBe(true);
    expect(mocked.paidPaths).toEqual([]);
  });

  it("retries a failed Yandex partition through the same exhaustive free path without any Apify request", async () => {
    const indexUrl = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
    const modelMapUrl = "https://reviews.yandex.ru/ugcpub/sitemap_model_260000000-269999999-0.xml";
    const productUrl = "https://reviews.yandex.ru/product/kagotsel--265149860";
    const requestedUrls: URL[] = [];
    let indexCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requestedUrls.push(url);
      if (url.toString() === indexUrl) {
        indexCalls += 1;
        if (indexCalls <= 3) return new Response("temporarily unavailable", { status: 503 });
        return new Response(
          `<?xml version="1.0"?><sitemapindex><sitemap><loc>${modelMapUrl}</loc></sitemap></sitemapindex>`,
          { status: 200, headers: { "content-type": "application/xml" } }
        );
      }
      if (url.toString() === modelMapUrl) {
        return new Response(
          `<?xml version="1.0"?><urlset><url><loc>${productUrl}</loc></url></urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } }
        );
      }
      if (url.toString() === productUrl || url.pathname === "/product/model--265149860") {
        return new Response(`<script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Product",
          name: "Кагоцел таблетки 12 мг №20",
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: 4.7,
            reviewCount: 711,
            ratingCount: 1827,
            bestRating: 5
          }
        })}</script>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }) as unknown as typeof fetch;
    const runtime = await createCollectorRuntime({
      repository: new MemoryRepository(),
      evidence: new MemoryEvidenceStore(),
      fetch: fetchMock,
      reviewsFetch: fetchMock,
      env: { APIFY_TOKEN: "must-not-be-used", APIFY_MONTHLY_BUDGET_USD: "4.50" }
    });
    const created = await runtime.service.createRun({
      ...request,
      domains: ["market.yandex.ru"]
    });

    const first = await runtime.service.executeRun(created.id);
    expect(first.partitions).toEqual([{
      domain: "market.yandex.ru",
      brand: "Кагоцел",
      status: "blocked",
      discovered: 0,
      collected: 0,
      message: "parser_changed: Yandex is unavailable for https://reviews.yandex.ru/ugcpub/sitemap.xml: HTTP 503"
    }]);

    const retried = await runtime.service.executeRun(created.id);
    expect(retried.partitions).toMatchObject([{
      domain: "market.yandex.ru",
      brand: "Кагоцел",
      status: "complete",
      discovered: 1,
      collected: 1
    }]);
    expect(retried.observations).toMatchObject([{
      domain: "market.yandex.ru",
      listingId: "265149860",
      reviews: 711,
      rating: 4.7,
      status: "ok",
      source: "yandex_reviews_json_ld"
    }]);
    expect(requestedUrls.some((url) => url.hostname === "api.apify.com")).toBe(false);
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
      env: { APIFY_FALLBACK_ENABLED: "true", APIFY_TOKEN: "test-token", APIFY_MONTHLY_BUDGET_USD: "0.50" }
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
