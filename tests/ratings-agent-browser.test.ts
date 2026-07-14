import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserFetch,
  createLazySandboxAcquire,
  hasExplicitWildberriesNoResults
} from "../agents/ratings/index.js";
import { AdapterBlockedError } from "../src/server/adapters/errors.js";

vi.mock("../src/server/utils/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/utils/safe-fetch.js")>();
  return {
    ...actual,
    assertSafePublicDestination: vi.fn(async (input: string) => new URL(input))
  };
});

function sandbox(run: (command: string) => Promise<unknown>) {
  return {
    browser: { cdpUrl: "wss://sandbox.invalid/cdp" },
    commands: { run },
    envdAccessToken: "test-token"
  };
}

describe("ratings Agent lazy Sandbox routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not acquire Sandbox for an external Apify request", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", directFetch);

    const response = await browserFetch(sandbox(run))(
      "https://api.apify.com/v2/acts/example/runs",
      { method: "POST" }
    );

    expect(await response.text()).toBe("ok");
    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("routes iRecommend through the static reader proxy without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL) => new Response("reader html"));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch("https://irecommend.ru/srch?query=test", {
      headers: { "x-ratings-browser": "1", "x-ratings-scroll": "1" }
    });

    expect(await response.text()).toBe("reader html");
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(run).not.toHaveBeenCalled();
  });

  it("routes Pravogolosa through the static function egress without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL) => new Response("proved empty result"));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(
      "https://pravogolosa.net/otzyvcategory?catid=0&page=search&text_search=Тикализис"
    );

    expect(await response.text()).toBe("proved empty result");
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back from direct Wildberries buyer JSON to fixed function egress without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response('{"products":[]}'));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(
      "https://search.wb.ru/exactmatch/ru/common/v14/search?appType=1&query=Тикализис"
    );

    expect(await response.text()).toBe('{"products":[]}');
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(directFetch.mock.calls[1]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(run).not.toHaveBeenCalled();
  });

  it("tries fixed function egress before acquiring the Ozon Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL) => new Response('{"widgetStates":{}}', {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const endpoint = new URL("https://www.ozon.ru/api/composer-api.bx/page/json/v2");
    endpoint.searchParams.set("url", "/search/?text=Тикализис&from_global=true");
    const response = await routedFetch(endpoint, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "ozon-composer" }
    });

    expect(await response.text()).toBe('{"widgetStates":{}}');
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a lazy Sandbox quota failure to AdapterBlockedError", async () => {
    const run = vi.fn(async () => {
      throw new Error("Sandbox quota exceeded");
    });
    const routedFetch = browserFetch(sandbox(run));

    await expect(routedFetch(
      "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fsearch%2F%3Ftext%3Dtest",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "ozon-composer"
        }
      }
    )).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects a Wildberries browser-mode request outside the fixed buyer API before acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const routedFetch = browserFetch(sandbox(run));

    await expect(routedFetch(
      "https://www.wildberries.ru/private/account",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "wildberries-api"
        }
      }
    )).rejects.toThrow(/restricted to the fixed search and card endpoints/);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the bounded Wildberries v14 buyer endpoint eligible for the Sandbox fallback", async () => {
    const run = vi.fn(async () => {
      throw new Error("Sandbox quota exceeded");
    });
    const routedFetch = browserFetch(sandbox(run));

    await expect(routedFetch(
      "https://search.wb.ru/exactmatch/ru/common/v14/search?appType=32&query=Тикализис&page=1",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "wildberries-api"
        }
      }
    )).rejects.toBeInstanceOf(AdapterBlockedError);
    expect(run).toHaveBeenCalledOnce();
  });

  it("matches only the visible Wildberries no-results statement for the requested query", () => {
    expect(hasExplicitWildberriesNoResults(
      "По запросу «Бактоблис» ничего не нашлось. Попробуйте изменить запрос.",
      "Бактоблис"
    )).toBe(true);
    expect(hasExplicitWildberriesNoResults(
      "По запросу «Другой бренд» ничего не нашлось",
      "Бактоблис"
    )).toBe(false);
    expect(hasExplicitWildberriesNoResults(
      "Товары временно недоступны",
      "Бактоблис"
    )).toBe(false);
  });

  it("rejects unbounded Wildberries search-proof URLs before acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const routedFetch = browserFetch(sandbox(run));

    await expect(routedFetch(
      "https://www.wildberries.ru/catalog/0/search.aspx?search=test&redirect=https://evil.example",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "wildberries-search-proof"
        }
      }
    )).rejects.toThrow(/bounded public search URL/);
    expect(run).not.toHaveBeenCalled();
  });

  it("acquires Sandbox once for concurrent browser consumers", async () => {
    const run = vi.fn(async () => undefined);
    const acquire = createLazySandboxAcquire(sandbox(run));

    expect(run).not.toHaveBeenCalled();
    await Promise.all([acquire(), acquire()]);
    expect(run).toHaveBeenCalledOnce();
  });
});
