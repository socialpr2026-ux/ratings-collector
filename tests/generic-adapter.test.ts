import { describe, expect, it } from "vitest";
import { GenericSiteAdapter } from "../src/server/generic/adapter.js";
import { extractJsonLdProducts } from "../src/server/generic/jsonld.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import { createAdapterResolver } from "../src/server/orchestrator.js";
import { MemoryRepository } from "../src/server/repository.js";
import { AdapterBlockedError } from "../src/server/adapters/errors.js";
import type { ProductRef, SiteAdapter, SiteProfile } from "../src/shared/types.js";

const profile = (overrides: Partial<SiteProfile> = {}): SiteProfile => ({
  domain: "example.com", version: 1, status: "approved", searchUrlTemplate: "https://example.com/search?q={query}",
  sitemapUrls: [], titleSelector: "h1", reviewCountSelector: ".reviews", ratingSelector: ".score",
  ratingScale: 10, reviewCountMeaning: "reviews", rateLimitMs: 0, canaryUrls: [], testExamples: [],
  createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z", notes: [], ...overrides
});
const ref: ProductRef = { domain: "example.com", platform: "example.com", listingId: "anvifen", brand: "Анвифен", url: "https://example.com/anvifen", metadata: {} };

describe("generic site onboarding", () => {
  it("extracts reviewCount separately from ratingCount in JSON-LD", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Анвифен капсулы","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"12","ratingCount":"55"}}</script>`;
    expect(extractJsonLdProducts(html, ref.url)[0]).toMatchObject({ rating: 4.8, reviewCount: 12, ratingCount: 55 });
  });

  it("collects a non-standard visible DOM profile and normalizes a 10-point scale", async () => {
    const adapter = new GenericSiteAdapter(profile(), new MemoryEvidenceStore());
    const fetchMock = async () => new Response(`<html><h1>Анвифен капсулы 250 мг</h1><b class="reviews">1 234 отзыва</b><i class="score">8,6 из 10</i></html>`, { status: 200 });
    const result = await adapter.collect(ref, { region: "Москва", fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ product: "Анвифен капсулы 250 мг", reviews: 1234, rating: 4.3, status: "ok", source: "visible-dom" });
  });

  it("keeps hundredths produced by a precise alternate-scale score", async () => {
    const adapter = new GenericSiteAdapter(profile(), new MemoryEvidenceStore());
    const fetchMock = async () => new Response(`<html><h1>Анвифен капсулы 250 мг</h1><b class="reviews">12 отзывов</b><i class="score">9,87 из 10</i></html>`, { status: 200 });
    const result = await adapter.collect(ref, { region: "Москва", fetch: fetchMock as typeof fetch });
    expect(result).toMatchObject({ reviews: 12, rating: 4.94, rawRating: 9.87, rawRatingScale: 10 });
  });

  it("accepts a confirmed JSON-LD ratingCount-only profile", async () => {
    const adapter = new GenericSiteAdapter(profile({ reviewCountMeaning: "ratings" }), new MemoryEvidenceStore());
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: ref.brand,
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4.8, ratingCount: 55 }
    })}</script>`;

    const result = await adapter.collect(ref, {
      region: "Москва",
      fetch: (async () => new Response(html)) as typeof fetch
    });

    expect(result).toMatchObject({ reviews: null, ratingCount: 55, rating: 4.8, status: "ok" });
  });

  it("keeps an unapproved generated profile in needs_review", async () => {
    const adapter = new GenericSiteAdapter(profile({ status: "draft", reviewCountMeaning: "unknown" }), new MemoryEvidenceStore());
    const result = await adapter.collect(ref, { region: "Москва", fetch: (async () => new Response(`<h1>Анвифен</h1><span class="reviews">5</span><span class="score">9</span>`)) as typeof fetch });
    expect(result.status).toBe("needs_review");
  });

  it("walks detected search pagination until later product cards", async () => {
    const adapter = new GenericSiteAdapter(profile({ nextPageSelector: "a[rel='next']" }), new MemoryEvidenceStore());
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.searchParams.get("page") === "2") return new Response(`<a href="/products/anvifen-250">Анвифен 250 мг</a>`);
      return new Response(`<a rel="next" href="/search?q=Анвифен&page=2">Далее</a>`);
    };
    const refs = await adapter.discover("Анвифен", { region: "Москва", fetch: fetchMock as typeof fetch });
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe("https://example.com/products/anvifen-250");
  });

  it("uses the Agent fetch passed by the resolver when execute context has no fetch", async () => {
    const repository = new MemoryRepository({ profiles: { "example.com": profile() } });
    const fetchMock = (async () =>
      new Response(`<a href="/products/anvifen-250">Анвифен 250 мг</a>`)
    ) as typeof fetch;
    const resolve = createAdapterResolver([], repository, new MemoryEvidenceStore(), fetchMock);
    const adapter = await resolve("example.com", {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["example.com"],
      brands: ["Анвифен"]
    });

    const refs = await adapter.discover("Анвифен", { region: "Москва" });

    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe("https://example.com/products/anvifen-250");
  });

  it("keeps unknown domains on the generic profile path when known adapters use resilient fallbacks", async () => {
    const unknownProfile = profile({
      domain: "unknown.example",
      searchUrlTemplate: "https://unknown.example/search?q={query}"
    });
    const repository = new MemoryRepository({ profiles: { "unknown.example": unknownProfile } });
    const known: SiteAdapter = {
      id: "wildberries",
      supportedDomains: ["wildberries.ru", "www.wildberries.ru"],
      async healthCheck() { return { ok: true, checkedAt: "2026-07-13T00:00:00.000Z" }; },
      async discover() { return []; },
      async collect() { throw new Error("not used"); }
    };
    const resolve = createAdapterResolver(
      [known],
      repository,
      new MemoryEvidenceStore(),
      (async () => new Response("")) as typeof fetch
    );
    const request = {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["wildberries.ru", "unknown.example"],
      brands: ["Кагоцел"]
    };

    await expect(resolve("wildberries.ru", request)).resolves.toBe(known);
    const unknown = await resolve("unknown.example", request);
    expect(unknown).toBeInstanceOf(GenericSiteAdapter);
    expect(unknown.id).toBe("generic:unknown.example:v1");
  });

  it("fails closed when search pagination still has work after 50 pages", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(`<a rel="next" href="/search?q=Анвифен&page=${page + 1}">Далее</a>`);
    }) as typeof fetch;
    const adapter = new GenericSiteAdapter(
      profile({ nextPageSelector: "a[rel='next']" }),
      new MemoryEvidenceStore(),
      fetchMock
    );

    await expect(adapter.discover("Анвифен", { region: "Москва" })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("fails closed when a sitemap queue still has work after 50 documents", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const page = Number(url.pathname.match(/map-(\d+)\.xml$/)?.[1] ?? "1");
      return new Response(`<sitemapindex><sitemap><loc>https://example.com/map-${page + 1}.xml</loc></sitemap></sitemapindex>`);
    }) as typeof fetch;
    const adapter = new GenericSiteAdapter(
      profile({ searchUrlTemplate: undefined, sitemapUrls: ["https://example.com/map-1.xml"] }),
      new MemoryEvidenceStore(),
      fetchMock
    );

    await expect(adapter.discover("Анвифен", { region: "Москва" })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("fails closed instead of truncating more than 500 unique product URLs", async () => {
    const links = Array.from(
      { length: 501 },
      (_, index) => `<a href="/products/anvifen-${index}">Анвифен ${index}</a>`
    ).join("");
    const adapter = new GenericSiteAdapter(
      profile(),
      new MemoryEvidenceStore(),
      (async () => new Response(links)) as typeof fetch
    );

    await expect(adapter.discover("Анвифен", { region: "Москва" })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("fails closed when a queued search page returns non-2xx after partial discovery", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.searchParams.get("page") === "2") return new Response("unavailable", { status: 503 });
      return new Response(
        `<a href="/products/anvifen-250">Анвифен 250 мг</a>` +
        `<a rel="next" href="/search?q=Анвифен&page=2">Далее</a>`
      );
    }) as typeof fetch;
    const adapter = new GenericSiteAdapter(
      profile({ nextPageSelector: "a[rel='next']" }),
      new MemoryEvidenceStore(),
      fetchMock
    );

    await expect(adapter.discover("Анвифен", { region: "Москва" })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("fails closed when one queued sitemap returns non-2xx", async () => {
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/map-2.xml") return new Response("missing", { status: 404 });
      return new Response(
        `<sitemapindex><sitemap><loc>https://example.com/map-2.xml</loc></sitemap></sitemapindex>`
      );
    }) as typeof fetch;
    const adapter = new GenericSiteAdapter(
      profile({ searchUrlTemplate: undefined, sitemapUrls: ["https://example.com/map-1.xml"] }),
      new MemoryEvidenceStore(),
      fetchMock
    );

    await expect(adapter.discover("Анвифен", { region: "Москва" })).rejects.toBeInstanceOf(AdapterBlockedError);
  });
});
