import { describe, expect, it, vi } from "vitest";
import { Pharmacy009Adapter } from "../src/server/adapters/pharmacy009.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import type { AdapterContext, ProductRef } from "../src/shared/types.js";

const ORIGIN = "https://009.xn--p1ai";
const context: AdapterContext = { region: "Москва", runId: "009-test", brands: ["Лирика"] };

function urlOf(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
}

function sitemapIndex(shards: number): string {
  return `<?xml version="1.0" encoding="utf-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    Array.from({ length: shards }, (_value, index) =>
      `<sitemap><loc>${ORIGIN}/sitemap_${index}.xml</loc><lastmod>2026-08-02</lastmod></sitemap>`
    ).join("")
  }</sitemapindex>`;
}

function urlset(...urls: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    urls.map((url) => `<url><loc>${url}</loc><lastmod>2026-08-02</lastmod></url>`).join("")
  }</urlset>`;
}

function positiveFamily(url: string, options: {
  canonical?: string;
  heading?: string;
  structuredCount?: number;
  visibleCount?: number;
  bestRating?: number;
} = {}): string {
  const canonical = options.canonical ?? url;
  const heading = options.heading ?? "ЛИРИКА ОТЗЫВЫ";
  const structuredCount = options.structuredCount ?? 19;
  const visibleCount = options.visibleCount ?? 19;
  return `<!doctype html><html><head><title>ЛИРИКА отзывы</title><link rel="canonical" href="${canonical}"></head><body>
    <h1 class="reviewsPage__h1">${heading}</h1>
    <section class="drugReviews">
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org/",
        "@type": "Product",
        name: "ЛИРИКА",
        brand: { "@type": "Brand", name: "ЛИРИКА" },
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: 4.4,
          bestRating: options.bestRating ?? 5,
          worstRating: 4,
          ratingCount: structuredCount,
          reviewCount: structuredCount
        }
      })}</script>
      <div class="drugReviews__ratingValue">4,4</div>
      <div class="drugReviews__count">Основано на ${visibleCount} отзывах</div>
      <div class="reviewsList">
        <a class="reviewsList__drugName" href="/product/lirika_kapsuly_25_mg_n14">ЛИРИКА КАПСУЛЫ 25 МГ №14</a>
        <a class="reviewsList__drugName" href="/product/lirika_kapsuly_75_mg_n56">ЛИРИКА КАПСУЛЫ 75 МГ №56</a>
        <a class="reviewsList__drugName" href="/product/pregabalin_kapsuly_75_mg_n14#search">ПРЕГАБАЛИН КАПСУЛЫ 75 МГ №14</a>
      </div>
    </section>
    <div class="productsSlider"><a href="/product/lirika_analog_tabletki_10_mg_n10#search">ЛИРИКА АНАЛОГ</a></div>
  </body></html>`;
}

function zeroFamily(url: string, emptyText = "Нет отзывов. Будьте первым!"): string {
  return `<!doctype html><html><head><title>БАКТОБЛИС отзывы</title><link rel="canonical" href="${url}"></head><body>
    <h1 class="reviewsPage__h1">БАКТОБЛИС ОТЗЫВЫ</h1>
    <section class="drugReviews"><div class="drugReviews__summary empty">
      <div class="drugReviews__emptyReviews">${emptyText}</div>
    </div></section>
  </body></html>`;
}

function familyIdentity(url: string, familyTitle: string): string {
  return `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body>
    <h1 class="reviewsPage__h1">${familyTitle} ОТЗЫВЫ</h1>
  </body></html>`;
}

function positiveHondrogardFamily(url: string, mixedForm = false): string {
  return `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body>
    <h1 class="reviewsPage__h1">ХОНДРОГАРД ОТЗЫВЫ</h1>
    <section class="drugReviews">
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "ХОНДРОГАРД",
        brand: { name: "ХОНДРОГАРД" },
        aggregateRating: { "@type": "AggregateRating", ratingValue: 4.4, bestRating: 5, ratingCount: 5, reviewCount: 5 }
      })}</script>
      <div class="drugReviews__ratingValue">4,4</div>
      <div class="drugReviews__count">Основано на 5 отзывах</div>
      <a class="reviewsList__drugName" href="/product/hondrogard_rastvor_100_mg_ml_2_ml_n25">ХОНДРОГАРД РАСТВОР ДЛЯ ВНУТРИМЫШЕЧНОГО ВВЕДЕНИЯ 100 МГ/МЛ 2 МЛ №25</a>
      <a class="reviewsList__drugName" href="/product/hondrogard_rastvor_100_mg_ml_1_ml_n10">ХОНДРОГАРД РАСТВОР ДЛЯ ВНУТРИМЫШЕЧНОГО ВВЕДЕНИЯ 100 МГ/МЛ 1 МЛ №10</a>
      ${mixedForm ? '<a class="reviewsList__drugName" href="/product/hondrogard_kapsuly_n10">ХОНДРОГАРД КАПСУЛЫ №10</a>' : ""}
    </section>
  </body></html>`;
}

function ref(brand: string, slug: string): ProductRef {
  return {
    domain: "009.xn--p1ai",
    platform: "009.xn--p1ai",
    listingId: `family-${slug}`,
    brand,
    url: `${ORIGIN}/kupit-${slug}/otzyvy`,
    metadata: {}
  };
}

describe("Pharmacy009Adapter", () => {
  it("scans every advertised shard, de-duplicates family URLs and publishes one source-bound aggregate", async () => {
    const family = `${ORIGIN}/kupit-lirika/otzyvy`;
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(2));
      if (url.pathname === "/sitemap_0.xml") {
        return new Response(urlset(
          `${ORIGIN}/product/lirika_kapsuly_25_mg_n14`,
          `${ORIGIN}/kupit-pregabalin/otzyvy`
        ));
      }
      if (url.pathname === "/sitemap_1.xml") {
        return new Response(urlset(
          family,
          family,
          `${ORIGIN}/kupit-lirika/analogs`,
          `${ORIGIN}/product/lirika_kapsuly_75_mg_n56`
        ));
      }
      if (url.pathname === "/kupit-lirika/otzyvy") return new Response(positiveFamily(family));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const evidence = new MemoryEvidenceStore();
    const adapter = new Pharmacy009Adapter(evidence, fetchMock);

    const refs = await adapter.discover("Лирика", context);
    expect(refs).toMatchObject([{
      domain: "009.xn--p1ai",
      listingId: "family-lirika",
      brand: "Лирика",
      url: family,
      metadata: { discovery: "009-complete-family-review-sitemaps" }
    }]);
    expect(requested.filter((path) => path === "/sitemap.xml")).toHaveLength(1);
    expect(requested.filter((path) => path.startsWith("/sitemap_"))).toHaveLength(2);

    const observation = await adapter.collect(refs[0]!, context);
    expect(observation).toMatchObject({
      domain: "009.xn--p1ai",
      listingId: "family-lirika",
      product: "ЛИРИКА",
      reviews: 19,
      writtenReviewCount: 19,
      rating: 4.4,
      ratingCount: 19,
      status: "ok",
      aggregateGroupId: "009:family:lirika",
      source: "009-family-review-jsonld",
      productEvidence: {
        scope: "product_family",
        variants: ["ЛИРИКА КАПСУЛЫ 25 МГ №14", "ЛИРИКА КАПСУЛЫ 75 МГ №56"]
      }
    });
    expect(observation.productEvidence?.variants).not.toContain("ПРЕГАБАЛИН КАПСУЛЫ 75 МГ №14");
    expect(observation.productEvidence?.identifiers).toContainEqual({ type: "product_id", value: "family-lirika" });
    expect(observation.evidenceRef).toMatch(/^evidence:/u);
    expect(evidence.items.size).toBe(1);
    expect(requested.filter((path) => path === "/kupit-lirika/otzyvy")).toHaveLength(1);
  });

  it("refreshes the complete sitemap on a same-run retry after all requested brands finish discovery", async () => {
    const family = `${ORIGIN}/kupit-lirika/otzyvy`;
    let indexRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") {
        indexRequests += 1;
        return new Response(sitemapIndex(1));
      }
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(family));
      if (url.pathname === "/kupit-lirika/otzyvy") return new Response(positiveFamily(family));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Лирика", context)).resolves.toHaveLength(1);
    await expect(adapter.discover("Лирика", context)).resolves.toHaveLength(1);
    expect(indexRequests).toBe(2);
  });

  it("proves candidate family headings before returning refs and ignores a genitive slug false positive", async () => {
    const base = `${ORIGIN}/kupit-trekrezan/otzyvy`;
    const genitive = `${ORIGIN}/kupit-trekrezan-tabletki/otzyvy`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(base, genitive));
      if (url.pathname === "/kupit-trekrezan/otzyvy") return new Response(familyIdentity(base, "ТРЕКРЕЗАН"));
      if (url.pathname === "/kupit-trekrezan-tabletki/otzyvy") {
        return new Response(familyIdentity(genitive, "ТРЕКРЕЗАНА ТАБЛЕТКИ"));
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Трекрезан", { ...context, runId: "trekrezan" })).resolves.toMatchObject([
      { listingId: "family-trekrezan", url: base }
    ]);
  });

  it("maps the portfolio descriptor Хондрогард р-р to the base family without Trio or Quadro", async () => {
    const base = `${ORIGIN}/kupit-hondrogard/otzyvy`;
    const trio = `${ORIGIN}/kupit-hondrogard_trio/otzyvy`;
    const quadro = `${ORIGIN}/kupit-hondrogard_kvadro/otzyvy`;
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(base, trio, quadro));
      if (url.pathname === "/kupit-hondrogard/otzyvy") return new Response(positiveHondrogardFamily(base));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    const hondrogardContext = { ...context, runId: "hondrogard", brands: ["Хондрогард р-р"] };
    const refs = await adapter.discover("Хондрогард р-р", hondrogardContext);
    expect(refs).toMatchObject([
      { listingId: "family-hondrogard", url: base }
    ]);
    expect(requested).not.toContain("/kupit-hondrogard_trio/otzyvy");
    expect(requested).not.toContain("/kupit-hondrogard_kvadro/otzyvy");
    await expect(adapter.collect(refs[0]!, hondrogardContext)).resolves.toMatchObject({
      product: "Хондрогард р-р",
      reviews: 5,
      rating: 4.4,
      status: "ok",
      productEvidence: { scope: "product_family", variants: [
        "ХОНДРОГАРД РАСТВОР ДЛЯ ВНУТРИМЫШЕЧНОГО ВВЕДЕНИЯ 100 МГ/МЛ 2 МЛ №25",
        "ХОНДРОГАРД РАСТВОР ДЛЯ ВНУТРИМЫШЕЧНОГО ВВЕДЕНИЯ 100 МГ/МЛ 1 МЛ №10"
      ] }
    });
  });

  it("fails closed when a descriptor-scoped family mixes solution and non-solution variants", async () => {
    const family = `${ORIGIN}/kupit-hondrogard/otzyvy`;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(positiveHondrogardFamily(family, true))
    ) as unknown as typeof fetch);

    await expect(adapter.collect(ref("Хондрогард р-р", "hondrogard"), {
      ...context,
      runId: "hondrogard-mixed",
      brands: ["Хондрогард р-р"]
    })).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("fails closed when a descriptor-scoped family member has no provable product URL", async () => {
    const family = `${ORIGIN}/kupit-hondrogard/otzyvy`;
    const html = positiveHondrogardFamily(family).replace(
      "</section>",
      '<span class="reviewsList__drugName">ХОНДРОГАРД КАПСУЛЫ №10</span></section>'
    );
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(html)
    ) as unknown as typeof fetch);

    await expect(adapter.collect(ref("Хондрогард р-р", "hondrogard"), {
      ...context,
      runId: "hondrogard-unverified",
      brands: ["Хондрогард р-р"]
    })).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("accepts only an exact source-bound empty family state as zero", async () => {
    const family = `${ORIGIN}/kupit-baktoblis/otzyvy`;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(zeroFamily(family))
    ) as unknown as typeof fetch);

    await expect(adapter.collect(ref("Бактоблис", "baktoblis"), { ...context, brands: ["Бактоблис"] })).resolves.toMatchObject({
      product: "БАКТОБЛИС",
      reviews: 0,
      writtenReviewCount: 0,
      rating: null,
      ratingCount: 0,
      status: "no_reviews",
      aggregateGroupId: "009:family:baktoblis",
      source: "009-family-visible-empty-state",
      productEvidence: { scope: "product_family" }
    });

    const ambiguous = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(zeroFamily(family, "Отзывов пока нет"))
    ) as unknown as typeof fetch);
    await expect(ambiguous.collect(ref("Бактоблис", "baktoblis"), context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it.each([401, 403, 429, 498, 500, 502, 503])("keeps HTTP %s as an external blocker instead of zero", async (status) => {
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response("blocked", { status })
    ) as unknown as typeof fetch);
    await expect(adapter.collect(ref("Лирика", "lirika"), context)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("treats an active HTTP 200 challenge as blocked without matching dormant captcha source strings", async () => {
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response("<html><head><title>Подтвердите, что вы не робот</title></head><body><form action='/captcha'></form></body></html>")
    ) as unknown as typeof fetch);
    await expect(adapter.collect(ref("Лирика", "lirika"), context)).rejects.toBeInstanceOf(AdapterBlockedError);

    const family = `${ORIGIN}/kupit-lirika/otzyvy`;
    const normalWithDormantSource = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(positiveFamily(family).replace("</body>", "<script>window.__NUXT__={captcha:{show:false}}</script></body>"))
    ) as unknown as typeof fetch);
    await expect(normalWithDormantSource.collect(ref("Лирика", "lirika"), context)).resolves.toMatchObject({ reviews: 19, rating: 4.4 });
  });

  it.each([
    ["wrong canonical", { canonical: `${ORIGIN}/kupit-pregabalin/otzyvy` }],
    ["wrong family heading", { heading: "ПРЕГАБАЛИН ОТЗЫВЫ" }],
    ["inconsistent counters", { structuredCount: 18, visibleCount: 19 }],
    ["unexpected rating scale", { bestRating: 10 }]
  ])("fails closed on %s", async (_label, options) => {
    const family = `${ORIGIN}/kupit-lirika/otzyvy`;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(positiveFamily(family, options))
    ) as unknown as typeof fetch);
    await expect(adapter.collect(ref("Лирика", "lirika"), context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("does not claim no results when any advertised sitemap shard is incomplete", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(2));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/sitemap_1.xml") return new Response(`<urlset><url><loc>${ORIGIN}/kupit-lirika/otzyvy</loc></url>`);
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Лирика", context)).rejects.toBeInstanceOf(ParserChangedError);
    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: false });
  });

  it("does not start later sitemap shards after the first exact-proof failure", async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(5));
      if (url.pathname === "/sitemap_0.xml") {
        return new Response(`<urlset><url><loc>${ORIGIN}/kupit-lirika/otzyvy</loc></urlset>`);
      }
      if (/^\/sitemap_[12]\.xml$/u.test(url.pathname)) {
        return new Response(urlset(`${ORIGIN}/kupit-lirika/otzyvy`));
      }
      throw new Error(`later shard started unexpectedly: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.healthCheck({ ...context, runId: "stop-after-shard-failure" })).resolves.toMatchObject({ ok: false });
    expect(requested.filter((path) => path.startsWith("/sitemap_")).sort()).toEqual([
      "/sitemap_0.xml", "/sitemap_1.xml", "/sitemap_2.xml"
    ]);
  });

  it("blocks an unbounded brand-to-slug mapping before requesting candidate pages", async () => {
    const candidatePages = Array.from({ length: 41 }, (_value, index) => `${ORIGIN}/kupit-a-${index}/otzyvy`);
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(...candidatePages));
      throw new Error(`candidate page started unexpectedly: ${url.pathname}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("A", { ...context, runId: "broad-brand", brands: ["A"] }))
      .rejects.toBeInstanceOf(ParserChangedError);
    expect(requested.filter((path) => path.startsWith("/kupit-"))).toEqual([]);
  });

  it("uses bounded exact brand slugs only after a complete sitemap miss and keeps the proven page for collection", async () => {
    const family = `${ORIGIN}/kupit-khloretta/otzyvy`;
    const requested: string[] = [];
    const exactPage = positiveFamily(family, { heading: "ХЛОРЭТТА ОТЗЫВЫ" })
      .replaceAll("ЛИРИКА", "ХЛОРЭТТА");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(2));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/sitemap_1.xml") return new Response(urlset(`${ORIGIN}/kupit-lorista/otzyvy`));
      if (url.pathname === "/kupit-khloretta/otzyvy") return new Response(exactPage);
      if (/^\/kupit-(?:h|x)loretta\/otzyvy$/u.test(url.pathname)) return new Response("missing", { status: 404 });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);
    const fallbackContext = { ...context, runId: "exact-slug-hit", brands: ["Хлорэтта"] };

    const refs = await adapter.discover("Хлорэтта", fallbackContext);
    expect(refs).toMatchObject([{
      listingId: "family-khloretta",
      brand: "Хлорэтта",
      url: family,
      metadata: { discovery: "009-bounded-exact-brand-slug" }
    }]);
    expect(requested.filter((path) => path.startsWith("/kupit-")).sort()).toEqual([
      "/kupit-hloretta/otzyvy", "/kupit-khloretta/otzyvy", "/kupit-xloretta/otzyvy"
    ]);

    await expect(adapter.collect(refs[0]!, fallbackContext)).resolves.toMatchObject({
      listingId: "family-khloretta", product: "ХЛОРЭТТА", reviews: 19, rating: 4.4
    });
    expect(requested.filter((path) => path === "/kupit-khloretta/otzyvy")).toHaveLength(1);
  });

  it("keeps absence unproven when every guessed exact brand slug is terminally absent", async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(2));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/sitemap_1.xml") return new Response(urlset(`${ORIGIN}/kupit-lorista/otzyvy`));
      if (/^\/kupit-(?:h|kh|x)loretta\/otzyvy$/u.test(url.pathname)) {
        return new Response("missing", { status: url.pathname.includes("khloretta") ? 410 : 404 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Хлорэтта", {
      ...context, runId: "complete-empty", brands: ["Хлорэтта"]
    })).rejects.toThrow(/did not prove absence/u);
    expect(requested[0]).toBe("/sitemap.xml");
    expect(requested.slice(1).sort()).toEqual([
      "/kupit-hloretta/otzyvy", "/kupit-khloretta/otzyvy", "/kupit-xloretta/otzyvy",
      "/sitemap_0.xml", "/sitemap_1.xml"
    ]);
  });

  it("does not infer absence when the complete sitemap can use an unexpected family alias", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") {
        return new Response(urlset(`${ORIGIN}/kupit-contraceptive-x/otzyvy`));
      }
      if (/^\/kupit-(?:h|kh|x)loretta\/otzyvy$/u.test(url.pathname)) {
        return new Response("missing", { status: 404 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Хлорэтта", {
      ...context, runId: "unexpected-alias", brands: ["Хлорэтта"]
    })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("does not follow an exact-slug redirect into a terminal miss", async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      requested.push(url.pathname);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/kupit-khloretta/otzyvy") {
        return new Response(null, { status: 302, headers: { location: "/missing-family" } });
      }
      if (/^\/kupit-(?:h|x)loretta\/otzyvy$/u.test(url.pathname)) return new Response("missing", { status: 404 });
      if (url.pathname === "/missing-family") return new Response("missing", { status: 404 });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Хлорэтта", {
      ...context, runId: "redirect-terminal-miss", brands: ["Хлорэтта"]
    })).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(requested).not.toContain("/missing-family");
  });

  it.each([401, 403, 429, 500, 502])("keeps exact-slug HTTP %s as a discovery blocker", async (status) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/kupit-khloretta/otzyvy") return new Response("blocked", { status });
      if (/^\/kupit-(?:h|x)loretta\/otzyvy$/u.test(url.pathname)) return new Response("missing", { status: 404 });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Хлорэтта", {
      ...context, runId: `exact-slug-blocked-${status}`, brands: ["Хлорэтта"]
    })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it.each([200, 404])("keeps an exact-slug HTTP %s challenge blocked", async (status) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/kupit-khloretta/otzyvy") {
        return new Response(
          "<html><head><title>Проверка браузера</title></head><body><form action='/captcha'></form></body></html>",
          { status }
        );
      }
      if (/^\/kupit-(?:h|x)loretta\/otzyvy$/u.test(url.pathname)) return new Response("missing", { status: 404 });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Хлорэтта", {
      ...context, runId: `exact-slug-challenge-${status}`, brands: ["Хлорэтта"]
    })).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it.each([
    ["wrong family", (candidate: string) => familyIdentity(candidate, "ХЛОРЭТТА ПЛЮС")],
    ["incomplete", () => "<html><body><h1 class='reviewsPage__h1'>ХЛОРЭТТА ОТЗЫВЫ</h1></body></html>"]
  ])("rejects an exact-slug HTTP 200 %s identity", async (_label, page) => {
    const candidate = `${ORIGIN}/kupit-khloretta/otzyvy`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.pathname === "/sitemap.xml") return new Response(sitemapIndex(1));
      if (url.pathname === "/sitemap_0.xml") return new Response(urlset(`${ORIGIN}/kupit-pregabalin/otzyvy`));
      if (url.pathname === "/kupit-khloretta/otzyvy") {
        return new Response(page(candidate));
      }
      if (/^\/kupit-(?:h|x)loretta\/otzyvy$/u.test(url.pathname)) return new Response("missing", { status: 404 });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new Pharmacy009Adapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("Хлорэтта", {
      ...context, runId: "exact-slug-wrong-identity", brands: ["Хлорэтта"]
    })).rejects.toBeInstanceOf(ParserChangedError);
  });
});
