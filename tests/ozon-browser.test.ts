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

describe("Ozon browser collector", () => {
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
    const adapter = new OzonBrowserAdapter({ fetch, now: () => new Date("2026-07-13T10:00:00Z") });

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
    const browser = new OzonBrowserAdapter({ fetch: browserFetch });
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
    const adapter = new OzonBrowserAdapter({ fetch, maxPages: 2 });

    await expect(adapter.discover("Кагоцел", context)).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not pay for the same broken fallback schema on every brand", async () => {
    const browser = new OzonBrowserAdapter({
      fetch: vi.fn(async () => new Response("captcha", { status: 403 })) as unknown as typeof fetch
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
