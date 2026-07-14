import { describe, expect, it, vi } from "vitest";
import type { AdapterContext, Observation, ProductRef, SiteAdapter } from "../src/shared/types.js";
import { BudgetedAdapter } from "../src/server/adapters/budgeted.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { OzonBrowserAdapter } from "../src/server/adapters/ozon-browser.js";
import { ResilientOzonAdapter } from "../src/server/adapters/ozon-resilient.js";

const context: AdapterContext = { runId: "run-1", brands: ["Кагоцел"], region: "Москва", month: "2026-07" };

function tile(sku: number, title: string, rating = "4,9", reviews = "1 234") {
  return {
    sku,
    action: { link: `/product/kagotsel-${sku}/?from=search` },
    mainState: [
      { id: "name", textDS: { text: title } },
      {
        id: "rating",
        labelListV2: {
          icon: "ic_s_star",
          items: [
            { type: "text", text: { text: rating } },
            { type: "text", text: { text: reviews } }
          ]
        }
      }
    ]
  };
}

function page(items: unknown[], totalPages?: number) {
  return {
    widgetStates: { "tileGridDesktop-1-default-1": JSON.stringify({ items }) },
    shared: JSON.stringify({ catalog: totalPages === undefined ? {} : { totalPages } })
  };
}

function sourceUrlFromTranslate(input: URL): URL {
  const source = new URL(input.toString());
  source.hostname = "www.ozon.ru";
  source.searchParams.delete("_x_tr_sl");
  source.searchParams.delete("_x_tr_tl");
  source.searchParams.delete("_x_tr_hl");
  return source;
}

function translatedTile(sku: string, title: string, ratingValue?: string, reviews?: number): string {
  const slug = `product-${sku}`;
  const metrics = ratingValue === undefined || reviews === undefined
    ? ""
    : `<div><svg style="color:var(--graphicRating)"></svg><span>${ratingValue}</span><svg></svg><span>${reviews} \u043e\u0442\u0437\u044b\u0432\u043e\u0432</span></div>`;
  return `<div class="tile-root">
    <a href="https://www-ozon-ru.translate.goog/product/${slug}/?_x_tr_sl=ru"></a>
    <a href="https://www-ozon-ru.translate.goog/product/${slug}/?_x_tr_sl=ru"><span>${title}</span></a>
    ${metrics}
  </div>`;
}

function translatedTileWithRawMetric(sku: string, title: string, ratingValue: string, rawCount: string): string {
  const slug = `product-${sku}`;
  return `<div class="tile-root">
    <a href="https://www-ozon-ru.translate.goog/product/${slug}/?_x_tr_sl=ru"></a>
    <a href="https://www-ozon-ru.translate.goog/product/${slug}/?_x_tr_sl=ru"><span>${title}</span></a>
    <div><svg style="color:var(--graphicRating)"></svg><span>${ratingValue}</span><span>${rawCount}</span></div>
  </div>`;
}

function translatedHtml(sourceUrl: URL, tiles: string[], totalPages: number, empty = false): string {
  const escapedSource = sourceUrl.toString().replaceAll("&", "&amp;");
  const state = empty ? `catalog.searchEmptyState \"totalPages\":${totalPages}` : `\"totalPages\":${totalPages}`;
  return `<html><head><base href="${escapedSource}"></head><body>
    ${tiles.length ? `<div data-widget="tileGridDesktop">${tiles.join("")}</div>` : ""}
    <script>window.__NUXT__={};window.__NUXT__.state='{"proof":"${state}"}';window.__NUXT__.__CONFIG__='{}';</script>
  </body></html>`;
}

function translatedProductHtml(sourceUrl: URL, sku: string, title: string, ratingValue: number, reviews: number): string {
  const escapedSource = sourceUrl.toString().replaceAll("&", "&amp;");
  const scoreText = `${ratingValue} \u2022 ${reviews} \u043e\u0442\u0437\u044b\u0432\u043e\u0432`;
  const product = {
    "@context": "http://schema.org",
    "@type": "Product",
    sku,
    name: title,
    aggregateRating: { "@type": "AggregateRating", ratingValue: String(ratingValue), reviewCount: String(reviews) }
  };
  return `<html><head><base href="${escapedSource}"><script type="application/ld+json">${JSON.stringify(product)}</script></head><body>
    <div id="state-webSingleProductScore-1" data-state='${JSON.stringify({ text: scoreText })}'></div>
    <script>window.__NUXT__={};window.__NUXT__.state='{}';</script>
  </body></html>`;
}

describe("Ozon browser collector", () => {
  it("uses the fixed translate render path, exhausts pages and deduplicates SKU", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const proxy = new URL(String(input));
      expect(proxy.hostname).toBe("www-ozon-ru.translate.goog");
      expect(new Headers(init?.headers).has("x-ratings-browser")).toBe(false);
      const source = sourceUrlFromTranslate(proxy);
      if (source.pathname.startsWith("/product/")) {
        const sku = source.pathname.match(/-(\d+)\/$/)![1]!;
        const fixture = sku === "101001"
          ? translatedProductHtml(source, sku, "\u0422\u0438\u043a\u0430\u043b\u0438\u0437\u0438\u0441 90 \u043c\u0433 60 \u0448\u0442", 4.9, 1234)
          : translatedProductHtml(source, sku, "\u0422\u0438\u043a\u0430\u043b\u0438\u0437\u0438\u0441 60 \u043c\u0433 60 \u0448\u0442", 5, 1);
        return new Response(fixture, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const html = source.searchParams.get("page") === "2"
        ? translatedHtml(source, [
            translatedTile("202002", "\u0422\u0438\u043a\u0430\u043b\u0438\u0437\u0438\u0441 60 \u043c\u0433 60 \u0448\u0442", "5.0", 1)
          ], 2)
        : translatedHtml(source, [
            translatedTileWithRawMetric("101001", "\u0422\u0438\u043a\u0430\u043b\u0438\u0437\u0438\u0441 90 \u043c\u0433 60 \u0448\u0442", "4,9", "1,2 \u0442\u044b\u0441."),
            translatedTileWithRawMetric("101001", "\u0422\u0438\u043a\u0430\u043b\u0438\u0437\u0438\u0441 90 \u043c\u0433 60 \u0448\u0442", "4,9", "1,2 \u0442\u044b\u0441.")
          ], 2);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OzonBrowserAdapter({ fetch, now: () => new Date("2026-07-14T10:00:00Z") });

    const refs = await adapter.discover("\u0422\u0438\u043a\u0430\u043b\u0438\u0437\u0438\u0441", context);
    expect(fetch).toHaveBeenCalledTimes(4);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(observations).toMatchObject([
      { listingId: "101001", reviews: 1234, rating: 4.9, source: "ozon:search-html:google-translate" },
      { listingId: "202002", reviews: 1, rating: 5, source: "ozon:search-html:google-translate" }
    ]);
  });

  it("follows only Ozon's bounded category-prediction redirect", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const proxy = new URL(String(input));
      const source = sourceUrlFromTranslate(proxy);
      if (source.pathname === "/search/") {
        const redirected = new URL("https://www.ozon.ru/category/lekarstvennye-sredstva-30000/arbidol-87397189/");
        redirected.searchParams.set("brand_was_predicted", "true");
        redirected.searchParams.set("category_was_predicted", "true");
        redirected.searchParams.set("deny_category_prediction", "true");
        redirected.searchParams.set("from_global", "true");
        redirected.searchParams.set("text", source.searchParams.get("text")!);
        return new Response(`<html><script>location.replace(${JSON.stringify(redirected.toString())})</script></html>`, {
          headers: { "content-type": "text/html" }
        });
      }
      if (source.pathname.startsWith("/product/")) {
        return new Response(translatedProductHtml(
          source,
          "303003",
          "\u041a\u0430\u0433\u043e\u0446\u0435\u043b 12 \u043c\u0433 20 \u0448\u0442",
          5,
          25
        ), { headers: { "content-type": "text/html" } });
      }
      return new Response(translatedHtml(source, [
        translatedTile("303003", "\u041a\u0430\u0433\u043e\u0446\u0435\u043b 12 \u043c\u0433 20 \u0448\u0442", "5.0", 25)
      ], 1), { headers: { "content-type": "text/html" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OzonBrowserAdapter({ fetch: fetchMock });

    const refs = await adapter.discover("\u041a\u0430\u0433\u043e\u0446\u0435\u043b", context);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refs).toMatchObject([{ listingId: "303003", metadata: { reviewCount: 25, rating: 5 } }]);
  });

  it("prefetches exact product proofs with bounded concurrency and collect does not refetch", async () => {
    let activeDetails = 0;
    let maximumActiveDetails = 0;
    const detailCalls: string[] = [];
    const items = Array.from({ length: 9 }, (_value, index) => {
      const sku = String(700000 + index);
      return translatedTile(sku, `\u041a\u0430\u0433\u043e\u0446\u0435\u043b 12 \u043c\u0433 ${index + 10} \u0448\u0442`, "5.0", index + 1);
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const endpoint = new URL(String(input));
      const source = sourceUrlFromTranslate(endpoint);
      if (!source.pathname.startsWith("/product/")) {
        return new Response(translatedHtml(source, items, 1), { headers: { "content-type": "text/html" } });
      }
      const sku = source.pathname.match(/-(\d+)\/$/)![1]!;
      activeDetails += 1;
      maximumActiveDetails = Math.max(maximumActiveDetails, activeDetails);
      detailCalls.push(sku);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDetails -= 1;
      return new Response(translatedProductHtml(
        source,
        sku,
        `\u041a\u0430\u0433\u043e\u0446\u0435\u043b 12 \u043c\u0433 ${Number(sku) - 699990} \u0448\u0442`,
        5,
        Number(sku) - 699999
      ), { headers: { "content-type": "text/html" } });
    });
    const adapter = new OzonBrowserAdapter({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      detailConcurrency: 4
    });

    const refs = await adapter.discover("\u041a\u0430\u0433\u043e\u0446\u0435\u043b", context);
    const callsAfterDiscovery = fetchMock.mock.calls.length;
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));

    expect(refs).toHaveLength(9);
    expect(detailCalls).toHaveLength(9);
    expect(maximumActiveDetails).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterDiscovery);
    expect(observations.every((item) => item.source === "ozon:search-html:google-translate")).toBe(true);
  });

  it("stops scheduling new detail proofs after the first failed product", async () => {
    const items = Array.from({ length: 9 }, (_value, index) => {
      const sku = String(710000 + index);
      return translatedTile(sku, `Кагоцел 12 мг ${index + 10} шт`, "5.0", index + 1);
    });
    let detailCalls = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const source = sourceUrlFromTranslate(new URL(String(input)));
      if (!source.pathname.startsWith("/product/")) {
        return new Response(translatedHtml(source, items, 1), { headers: { "content-type": "text/html" } });
      }
      detailCalls += 1;
      if (detailCalls === 1) return new Response("upstream failed", { status: 502, headers: { "content-type": "text/html" } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const sku = source.pathname.match(/-(\d+)\/$/)![1]!;
      return new Response(translatedProductHtml(source, sku, `Кагоцел ${sku}`, 5, 1), {
        headers: { "content-type": "text/html" }
      });
    });
    const adapter = new OzonBrowserAdapter({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      detailConcurrency: 4
    });

    await expect(adapter.discover("Кагоцел", context)).rejects.toThrow(/HTTP 502/);
    expect(detailCalls).toBeLessThanOrEqual(4);
  });

  it("accepts zero products only with an explicit Ozon empty-state proof", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "www.ozon.ru") return new Response("captcha", { status: 403 });
      const source = sourceUrlFromTranslate(url);
      return new Response(translatedHtml(source, [], 1, true), { headers: { "content-type": "text/html" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OzonBrowserAdapter({ fetch });

    await expect(adapter.discover("\u041d\u0435\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0439", context)).resolves.toEqual([]);

    const ambiguousFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "www.ozon.ru") return new Response("captcha", { status: 403 });
      const source = sourceUrlFromTranslate(url);
      return new Response(translatedHtml(source, [], 1, false), { headers: { "content-type": "text/html" } });
    }) as unknown as typeof globalThis.fetch;
    const ambiguous = new OzonBrowserAdapter({ fetch: ambiguousFetch });
    await expect(ambiguous.discover("\u041d\u0435\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0439", context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("exhausts composer pagination and returns exact tile metrics", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const composerUrl = new URL(String(input));
      const searchUrl = new URL(composerUrl.searchParams.get("url")!, "https://www.ozon.ru");
      const payload = searchUrl.searchParams.get("page") === "2"
        ? page([tile(202, "Кагоцел таблетки 30 шт.", "5", "0")], 2)
        : page([tile(101, "Кагоцел таблетки 20 шт.")], 2);
      expect(new Headers(init?.headers).get("x-ratings-browser-mode")).toBe("ozon-composer");
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OzonBrowserAdapter({ fetch, now: () => new Date("2026-07-13T10:00:00Z"), translateEnabled: false });

    const refs = await adapter.discover("Кагоцел", context);
    const observations = await Promise.all(refs.map((ref) => adapter.collect(ref, context)));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(observations).toMatchObject([
      { listingId: "101", reviews: 1234, rating: 4.9, status: "ok", source: "ozon:composer-api:edgeone-browser" },
      { listingId: "202", reviews: 0, rating: null, status: "no_reviews", source: "ozon:composer-api:edgeone-browser" }
    ]);
  });

  it("uses the capped fallback only when browser discovery is blocked", async () => {
    const browserFetch = vi.fn(async () => new Response("captcha", { status: 403 })) as unknown as typeof fetch;
    const browser = new OzonBrowserAdapter({ fetch: browserFetch, translateEnabled: false });
    const fallbackRef: ProductRef = {
      domain: "ozon.ru", platform: "ozon", listingId: "7", brand: "Кагоцел",
      url: "https://www.ozon.ru/product/7/", title: "Кагоцел", metadata: { source: "apify" }
    };
    const fallback: SiteAdapter = {
      id: "ozon", supportedDomains: ["ozon.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover() { return [fallbackRef]; },
      async collect(ref): Promise<Observation> {
        return { domain: ref.domain, platform: ref.platform, listingId: ref.listingId, brand: ref.brand, canonicalUrl: ref.url, product: ref.title!, reviews: 1, rating: 5, status: "ok", capturedAt: new Date().toISOString() };
      }
    };

    const adapter = new ResilientOzonAdapter(browser, fallback);
    await expect(adapter.discover("Кагоцел", context)).resolves.toEqual([fallbackRef]);
    await expect(adapter.discover("Арбидол", context)).resolves.toEqual([fallbackRef]);
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the page cap is reached without a proven end", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(page([tile(101, "Кагоцел таблетки")])), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof globalThis.fetch;
    const adapter = new OzonBrowserAdapter({ fetch, maxPages: 2, translateEnabled: false });

    await expect(adapter.discover("Кагоцел", context)).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not pay for the same broken fallback schema on every brand", async () => {
    const browser = new OzonBrowserAdapter({
      fetch: vi.fn(async () => new Response("captcha", { status: 403 })) as unknown as typeof fetch,
      translateEnabled: false
    });
    const fallback = {
      id: "ozon",
      supportedDomains: ["ozon.ru"],
      healthCheck: vi.fn(async () => ({ ok: true, checkedAt: new Date().toISOString() })),
      discover: vi.fn(async () => { throw new ParserChangedError("fallback dataset has no title"); }),
      collect: vi.fn(async () => { throw new Error("not used"); })
    } satisfies SiteAdapter;
    const adapter = new ResilientOzonAdapter(browser, fallback);

    await expect(adapter.discover("Кагоцел", context)).rejects.toThrow("fallback dataset has no title");
    await expect(adapter.discover("Арбидол", context)).rejects.toThrow("fallback dataset has no title");
    expect(fallback.discover).toHaveBeenCalledTimes(1);
  });
});

describe("Apify fallback budget", () => {
  it("checks live usage before every sequential fallback without a cumulative synthetic ledger", async () => {
    const usage = vi.fn(async () => 0.59);
    const inner: SiteAdapter = {
      id: "ozon", supportedDomains: ["ozon.ru"],
      async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
      async discover() { return []; },
      async collect() { throw new Error("not used"); }
    };
    const adapter = new BudgetedAdapter(inner, { reservePerDiscovery: 0.25, monthlyLimit: 4.5, externalUsageUsd: usage });

    await adapter.discover("Кагоцел", context);
    await adapter.discover("Кагоцел", context);
    await adapter.discover("Арбидол", context);

    expect(usage).toHaveBeenCalledTimes(3);
  });
});
