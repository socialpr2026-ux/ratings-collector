import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserFetch,
  createLazySandboxAcquire,
  hasExplicitWildberriesNoResults,
  shouldAutoRetryInitialCollection
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

  it("routes an exact ru.otzyv.com product through fixed function egress without Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("compact product aggregate"));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch("https://ru.otzyv.com/kagotsel");

    expect(await response.text()).toBe("compact product aggregate");
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body)))
      .toEqual({ url: "https://ru.otzyv.com/kagotsel" });
    expect(run).not.toHaveBeenCalled();
  });

  it("prefers fixed function egress for Wildberries buyer JSON without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn().mockResolvedValueOnce(new Response('{"products":[]}'));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(
      "https://search.wb.ru/exactmatch/ru/common/v14/search?appType=1&query=Тикализис"
    );

    expect(await response.text()).toBe('{"products":[]}');
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(run).not.toHaveBeenCalled();
  });

  it("retries one transient Wildberries function response before any direct or Sandbox route", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response("temporary upstream block", { status: 429 }))
      .mockResolvedValueOnce(new Response('{"total":3,"products":[{"id":1}]}'));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(
      "https://search.wb.ru/exactmatch/ru/common/v14/search?appType=64&query=Оциллококцинум"
    );

    expect(await response.text()).toContain('"total":3');
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls.every(([input]) => input === "https://ratings.example/api/internal/static-review-fetch")).toBe(true);
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

  it("routes the exact Ozon Translate render host through fixed function egress", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      directFetch.mock.calls.length === 1
        ? new Response("transient gateway failure", { status: 502 })
        : new Response("translated Ozon html", { headers: { "content-type": "text/html; charset=utf-8" } })
    );
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const target = new URL("https://www-ozon-ru.translate.goog/search/");
    target.searchParams.set("text", "Кагоцел");
    target.searchParams.set("from_global", "true");
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");

    const response = await routedFetch(target, { headers: { accept: "text/html" } });

    expect(await response.text()).toBe("translated Ozon html");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    const init = directFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ url: target.toString() });
    expect(directFetch.mock.calls[1]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(run).not.toHaveBeenCalled();
  });

  it("routes the exact pharmacy Translate hosts through fixed function egress without Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("compact pharmacy proof", {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    for (const target of [
      "https://farmlend-ru.translate.goog/search?keyword=Кагоцел&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://okapteka-ru.translate.goog/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://www-asna-ru.translate.goog/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://polza-ru.translate.goog/product/otsillokoktsinum/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://apteka-ru.translate.goog/preparation/otsillokoktsinum/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://nfapteka-ru.translate.goog/catalog/?q=Оциллококцинум&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://www-budzdorov-ru.translate.goog/forms/ocillokokcinum?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
    ]) {
      const response = await routedFetch(target);
      expect(await response.text()).toBe("compact pharmacy proof");
      const call = directFetch.mock.calls.at(-1)!;
      expect(call[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ url: new URL(target).toString() });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("routes only exact Apteka.ru preparation and product paths through fixed function egress", async () => {
    const directFetch = vi.fn(async (_input: RequestInfo | URL) => new Response("apteka proof", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    for (const target of [
      "https://apteka.ru/preparation/otsillokoktsinum/",
      "https://apteka.ru/product/oczillokokczinum-30-sht-granuly-5e3268eaca7bdc000192d316/",
      "https://apteka.ru/sitemap-product.xml?slugs=hondrofen%2Ckhondrofen%2Cxondrofen"
    ]) {
      expect(await (await routedFetch(target)).text()).toBe("apteka proof");
    }
    expect(run).not.toHaveBeenCalled();
    expect(directFetch.mock.calls.every(([input]) => input === "https://ratings.example/api/internal/static-review-fetch")).toBe(true);
  });

  it("retries one transient ASNA function failure and remains fail-closed without Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL) => directFetch.mock.calls.length === 1
      ? new Response("temporary egress failure", { status: 502 })
      : new Response("compact ASNA aggregate proof", { headers: { "content-type": "text/html; charset=utf-8" } }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(
      "https://www-asna-ru.translate.goog/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
    );

    expect(await response.text()).toBe("compact ASNA aggregate proof");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls.every(([input]) => input === "https://ratings.example/api/internal/static-review-fetch")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to fixed function egress for exact Yandex sitemap and Zdravcity routes", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input !== "string") throw new TypeError("direct egress failed");
      const requested = JSON.parse(String(init?.body)) as { url: string };
      return new Response(requested.url.includes("sitemap") ? "<urlset></urlset>" : "<html>zdravcity proof</html>");
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    for (const target of [
      "https://reviews.yandex.ru/ugcpub/sitemap_model_590000000-599999999-0.xml",
      "https://zdravcity.ru/g_kagocel/"
    ]) {
      const response = await routedFetch(target);
      expect(response.ok).toBe(true);
      const proxyCall = directFetch.mock.calls.at(-1)!;
      expect(proxyCall[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
      expect(JSON.parse(String((proxyCall[1] as RequestInit).body))).toEqual({ url: target });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back when direct Yandex egress returns a successful but incomplete sitemap", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => input instanceof Request
      ? new Response("<html><body>temporary edge response</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })
      : new Response("<?xml version=\"1.0\"?><urlset><url><loc>https://reviews.yandex.ru/product/test--1792372750</loc></url></urlset>", {
          status: 200,
          headers: { "content-type": "application/xml" }
        }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const target = "https://reviews.yandex.ru/ugcpub/sitemap_model_1790000000-1799999999-0.xml";

    const response = await routedFetch(target);

    expect(await response.text()).toContain("test--1792372750");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(directFetch.mock.calls[1]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(JSON.parse(String((directFetch.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ url: target });
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

describe("ratings Agent initial recovery pass", () => {
  it.each([408, 425, 429, 498, 499, 500, 502, 599])(
    "retries a proven transient HTTP %i failure on the initial collection",
    (statusCode) => {
      expect(shouldAutoRetryInitialCollection("queued", [
        { status: "complete" },
        { status: "blocked", message: `blocked: upstream returned HTTP ${statusCode}` }
      ])).toBe(true);
    }
  );

  it("retries a CAPTCHA failure and keeps non-transient states manual", () => {
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "error", message: "CAPTCHA challenge interrupted collection" }
    ])).toBe(true);
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "complete" },
      { status: "no_results" }
    ])).toBe(false);
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "blocked", message: "blocked: upstream returned HTTP 403" }
    ])).toBe(false);
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "blocked", message: "blocked: blocked_free_mode" }
    ])).toBe(false);
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "blocked", message: "quota_exceeded: HTTP 429; monthly limit reached" }
    ])).toBe(false);
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "blocked", message: "parser_changed: HTTP 502 appeared in malformed evidence" }
    ])).toBe(false);
    expect(shouldAutoRetryInitialCollection("review", [
      { status: "error", message: "HTTP 502" }
    ])).toBe(false);
  });

  it("does not repeat a mixed transient and permanent failure set", () => {
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "blocked", message: "blocked: HTTP 502" },
      { status: "blocked", message: "quota_exceeded: monthly limit reached" }
    ])).toBe(false);
  });

  it("bounds automatic recovery by run and failure size", () => {
    const complete = Array.from({ length: 40 }, () => ({ status: "complete" }));
    const failures = Array.from({ length: 10 }, () => ({ status: "blocked", message: "blocked: HTTP 502" }));
    expect(shouldAutoRetryInitialCollection("queued", [...complete, ...failures])).toBe(true);
    expect(shouldAutoRetryInitialCollection("queued", [...complete, ...failures, { status: "complete" }])).toBe(false);
    expect(shouldAutoRetryInitialCollection("queued", [
      ...failures,
      { status: "blocked", message: "blocked: HTTP 502" }
    ])).toBe(false);
  });
});
