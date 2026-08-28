import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserFetch,
  createBrowserLaneScheduler,
  createStaticProxyScheduler,
  createLazySandboxAcquire,
  extractYandexMarketSearchHtmlProof,
  hasExplicitWildberriesNoResults,
  hasExplicitYandexMarketNoResults,
  PHARMACY009_DIRECT_TIMEOUT_MS,
  OZON_LEASE_HEARTBEAT_MS,
  OZON_LEASE_MS,
  runWithRenewableLease,
  STATIC_PROXY_REQUEST_TIMEOUT_MS,
  YANDEX_BATCH_GATEWAY_TIMEOUT_MS
} from "../agents/ratings/index.js";
import { AdapterBlockedError, AdapterQuotaError } from "../src/server/adapters/errors.js";
import { VaptekeAdapter } from "../src/server/adapters/vapteke.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

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

function exactOkaptekaMissingPage(source: string, challenge = false): string {
  return `<!doctype html><html><head><link rel="canonical" href="${source}"></head><body>` +
    `<!-- ${"verified-first-party-template ".repeat(45)} -->` +
    `${challenge ? '<form data-sitekey="captcha"></form>' : ""}` +
    `<div class="error-page"><img class="error-page__image" src="/error.png" alt="404">` +
    `<h1 class="error-page__header">Похоже Вы потерялись</h1>` +
    `<h3 class="error-page__message">Попробуйте вернуться назад или поищите что-нибудь другое.</h3>` +
    `<a href="/" class="btn">Вернуться на главную</a></div></body></html>`;
}

function exactOkaptekaGroupPage(source: string): string {
  return `<!doctype html><html><head><link rel="canonical" href="${source}"></head><body>` +
    `<!-- ${"verified-first-party-group ".repeat(45)} -->` +
    `<article class="product"><a href="/kagotsyel-tab-12mg-30-529011/">Кагоцел таблетки 12мг №30</a></article>` +
    `<article class="product"><a href="/kagotsyel-tab-12mg-20-529012/">Кагоцел таблетки 12мг №20</a></article>` +
    `<article class="product"><a href="/kagotsyel-tab-12mg-10-30687/">Кагоцел таблетки 12мг №10</a></article>` +
    `</body></html>`;
}

describe("ratings Agent lazy Sandbox routing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renews the short Ozon lease and releases the latest fenced handle", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const repository = {
      renewLease: vi.fn(async (lease: { token: string; keys: string[]; scope?: string }) => ({
        ...lease,
        keys: [...lease.keys, "locks/renewed.json"]
      })),
      releaseLease: vi.fn(async () => undefined)
    };
    const pending = runWithRenewableLease(repository as never, {
      token: "lease", keys: ["locks/original.json"], scope: "collection:ozon"
    }, () => operation);

    await vi.advanceTimersByTimeAsync(OZON_LEASE_HEARTBEAT_MS + 1);
    expect(repository.renewLease).toHaveBeenCalledWith(expect.objectContaining({ token: "lease" }), OZON_LEASE_MS);
    finish();
    await pending;

    expect(repository.releaseLease).toHaveBeenCalledWith(expect.objectContaining({
      keys: ["locks/original.json", "locks/renewed.json"]
    }));
  });

  it("bounds a stalled Ozon translated static-proxy request before the Agent loses the partition checkpoint", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const request = routedFetch(
      "https://www-ozon-ru.translate.goog/search/?text=%D0%92%D0%B8%D0%B0%D1%80%D0%B4%D0%BE+%D0%A4%D0%BE%D1%80%D1%82%D0%B5&page=7&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
    );
    const rejection = expect(request).rejects.toSatisfy((error: unknown) =>
      error instanceof AdapterBlockedError &&
      error.message === `Static proxy request exceeded ${STATIC_PROXY_REQUEST_TIMEOUT_MS} ms`
    );

    await vi.advanceTimersByTimeAsync(STATIC_PROXY_REQUEST_TIMEOUT_MS + 1);

    await rejection;
    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back directly only for one bounded Ozon translated product after fixed egress fails", async () => {
    const run = vi.fn(async () => undefined);
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("reader unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-private-header")).toBeNull();
      return new Response("exact product proof", { status: 200 });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target, {
      headers: {
        authorization: "Bearer must-not-forward",
        cookie: "session=must-not-forward",
        "x-private-header": "must-not-forward"
      }
    });

    expect(await response.text()).toBe("exact product proof");
    expect(directFetch).toHaveBeenCalledTimes(3);
    expect(run).not.toHaveBeenCalled();
  });

  it("buffers the Ozon direct proof before disposing its per-attempt signal", async () => {
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("fixed failure", { status: 502 });
      }
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("detached exact proof"));
          setTimeout(() => signal?.aborted
            ? controller.error(new DOMException("aborted", "AbortError"))
            : controller.close(), 0);
        }
      }), { status: 200, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    await expect((await routedFetch(target)).text()).resolves.toBe("detached exact proof");
  });

  it("recovers one bounded Ozon translated GET after fixed-egress transport failure", async () => {
    const run = vi.fn(async () => undefined);
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        throw new Error("fixed egress transport unavailable");
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response("direct exact proof");
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    await expect((await routedFetch(target)).text()).resolves.toBe("direct exact proof");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers one bounded Ozon translated GET after the fixed-egress timeout", async () => {
    vi.useFakeTimers();
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Promise<Response>(() => undefined);
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.method).toBe("GET");
      return Promise.resolve(new Response("direct after timeout"));
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const pending = routedFetch(target);
    await vi.advanceTimersByTimeAsync(STATIC_PROXY_REQUEST_TIMEOUT_MS + 1);

    expect(await (await pending).text()).toBe("direct after timeout");
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

  it("does not accept a redirect from the bounded Ozon direct fallback", async () => {
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("fixed failure", { status: 502 });
      }
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(502);
    expect(directFetch).toHaveBeenCalledTimes(3);
  });

  it("bounds a stalled Ozon direct-product fallback and preserves the fixed-route blocker", async () => {
    vi.useFakeTimers();
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn((input: RequestInfo | URL) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return Promise.resolve(new Response("fixed failure", { status: 502 }));
      }
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const pending = routedFetch(target);
    await vi.advanceTimersByTimeAsync(201);
    await vi.advanceTimersByTimeAsync(STATIC_PROXY_REQUEST_TIMEOUT_MS + 1);
    const response = await pending;

    expect(response.status).toBe(502);
    expect(directFetch).toHaveBeenCalledTimes(3);
  });

  it("never uses the Ozon direct-product fallback for POST", async () => {
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe("https://ratings.example/api/internal/static-review-fetch");
      return new Response("fixed failure", { status: 502 });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target, { method: "POST", body: "must-not-forward" });

    expect(response.status).toBe(502);
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

  it("does not use direct egress for an unbounded Ozon translated product query", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async () => new Response("reader unavailable", { status: 502 }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const target = "https://www-ozon-ru.translate.goog/product/hloretta-21sht-4499023625/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en&evil=1";

    const response = await routedFetch(target);

    expect(response.status).toBe(502);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

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

  it("routes Vseotzyvy search and product proof through fixed egress without Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("compact Vseotzyvy proof"));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const targets = [
      "https://vseotzyvy.ru/search?q=Кагоцел",
      "https://vseotzyvy.ru/otzyvy/kagotsel-49555"
    ];

    for (const target of targets) {
      const response = await routedFetch(target);
      expect(await response.text()).toBe("compact Vseotzyvy proof");
      const call = directFetch.mock.calls.at(-1)!;
      expect(call[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ url: new URL(target).toString() });
    }
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

  it("routes a bounded ru.otzyv.com search through fixed function egress without Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("compact search proof"));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const url = "https://ru.otzyv.com/search/?q=%D0%A2%D0%B8%D1%80%D0%B7%D0%B5%D1%82%D1%82%D0%B0";

    const response = await routedFetch(url);

    expect(await response.text()).toBe("compact search proof");
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ url });
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

  it("permits one exact Ozon product composer path and rejects nested unsafe paths", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async () => new Response('{"widgetStates":{}}', {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const exact = new URL("https://www.ozon.ru/api/composer-api.bx/page/json/v2");
    exact.searchParams.set("url", "/product/baktoblis-sashe-123456789/");

    await expect(routedFetch(exact, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "ozon-composer" }
    })).resolves.toBeInstanceOf(Response);

    const unsafe = new URL("https://www.ozon.ru/api/composer-api.bx/page/json/v2");
    unsafe.searchParams.set("url", "https://metadata.google.internal/latest/meta-data/");
    await expect(routedFetch(unsafe, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "ozon-composer" }
    })).rejects.toThrow("restricted to product search or one exact product card");
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

  it("routes exact Vapteke autocomplete and product requests through fixed function egress", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"success":true}', { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    await routedFetch("https://vapteke.ru/ajax/autocomplete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ query: "Бивиарт" })
    });
    await routedFetch("https://vapteke.ru/product/biviart-komfort-018-10-ml-682542");

    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls.map(([input]) => input)).toEqual([
      "https://ratings.example/api/internal/static-review-fetch",
      "https://ratings.example/api/internal/static-review-fetch"
    ]);
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      url: "https://vapteke.ru/ajax/autocomplete",
      vaptekeAutocomplete: { query: "Бивиарт" }
    });
    expect(JSON.parse(String((directFetch.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      url: "https://vapteke.ru/product/biviart-komfort-018-10-ml-682542"
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the complete Vapteke adapter path off Sandbox when fixed egress succeeds", async () => {
    const run = vi.fn(async () => {
      throw new Error("Sandbox quota exceeded");
    });
    const brand = "\u0411\u0430\u043a\u0442\u043e\u0431\u043b\u0438\u0441";
    const productId = "659414";
    const productSlug = `baktoblis-poroshok-1500-mg-15-sht-${productId}`;
    const productTitle = `${brand} \u043f\u043e\u0440\u043e\u0448\u043e\u043a 1500 \u043c\u0433 \u211615`;
    let productAttempts = 0;
    const productPage = (input: {
      id: string;
      brand: string;
      title: string;
      slug: string;
      rating: number;
      votes: number;
    }) => `<!doctype html><html><head>
      <link rel="canonical" href="https://vapteke.ru/product/${input.slug}">
      <script type="application/ld+json">{
        "@context":"https://schema.org","@type":"Product","name":"${input.brand}",
        "description":"${input.title}","aggregateRating":{
          "@type":"AggregateRating","bestRating":"5.0","worstRating":"1.0",
          "ratingValue":"${input.rating}","reviewCount":"${input.votes}"
        }
      }</script>
    </head><body>
      <h1 class="q-product__header-title">${input.title}</h1>
      <div><span>${input.brand}</span><div id="active_rating" class="item-rating">
        <div class="item-rating-stars" data-id="${input.id}"></div>
        <span class="rating-value">${input.rating}</span>
        <span class="rating-count">(<span>${input.votes}</span> \u0433\u043e\u043b\u043e\u0441\u043e\u0432)</span>
      </div></div>
    </body></html>`;
    const directFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        url: string;
        vaptekeAutocomplete?: { query: string };
      };
      if (payload.vaptekeAutocomplete) {
        expect(payload.vaptekeAutocomplete.query).toBe(brand);
        return Response.json({
          success: true,
          data: {
            total: { value: 1, relation: "eq" },
            hits: [{
              product_id: Number(productId),
              name: productTitle,
              slug: productSlug,
              is_active: true
            }]
          },
          error: "200"
        });
      }
      if (payload.url.includes("-365917")) {
        return new Response(productPage({
          id: "365917",
          brand: "\u0410\u043a\u0432\u0430\u041e\u043f\u0442\u0438\u043a",
          title: "\u0410\u043a\u0432\u0430\u041e\u043f\u0442\u0438\u043a \u0440\u0430\u0441\u0442\u0432\u043e\u0440 60 \u043c\u043b",
          slug: "rastvor-dlya-uhoda-za-kontaktnymi-linzami-akvaoptik-mnogofunktsionalnyy-60-ml-365917",
          rating: 5,
          votes: 1
        }), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      expect(payload.url).toBe(`https://vapteke.ru/product/${productSlug}`);
      productAttempts += 1;
      if (productAttempts === 1) {
        return new Response("transient upstream failure", { status: 502 });
      }
      return new Response(productPage({
        id: productId,
        brand,
        title: productTitle,
        slug: productSlug,
        rating: 5,
        votes: 15
      }), { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), routedFetch);
    const context = { region: "\u041c\u043e\u0441\u043a\u0432\u0430" };

    await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: true });
    const refs = await adapter.discover(brand, context);
    expect(refs).toHaveLength(1);
    await expect(adapter.collect(refs[0]!, context)).resolves.toMatchObject({
      listingId: productId,
      brand,
      reviews: 15,
      rating: 5,
      ratingCount: 15,
      status: "ok"
    });
    expect(directFetch).toHaveBeenCalledTimes(4);
    expect(directFetch.mock.calls.every(([input]) =>
      input === "https://ratings.example/api/internal/static-review-fetch"
    )).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the hardened browser for a marked Vapteke product instead of the blocked fixed egress", async () => {
    const run = vi.fn(async () => { throw new Error("Sandbox quota exceeded"); });
    const directFetch = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    await expect(routedFetch(
      "https://vapteke.ru/product/biviart-komfort-018-10-ml-682542",
      { headers: { "x-ratings-browser": "1" } }
    )).rejects.toBeInstanceOf(AdapterQuotaError);
    expect(run).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("falls back from one exact blocked Maksavit Translate card to the dedicated browser lane", async () => {
    const run = vi.fn(async () => { throw new Error("Sandbox quota exceeded"); });
    const directFetch = vi.fn(async () => new Response("Google Translate shell", { status: 400 }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run));
    const target = "https://maksavit-ru.translate.goog/catalog/945425/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";

    await expect(routedFetch(target)).rejects.toBeInstanceOf(AdapterQuotaError);

    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it("never acquires the Maksavit browser for an unbounded translated path", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async () => new Response("blocked", { status: 400 }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run));

    const response = await routedFetch(
      "https://maksavit-ru.translate.goog/catalog/private/export/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
    );

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers a Megamarket product after two transient translated-route failures", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => directFetch.mock.calls.length <= 2
      ? new Response("transient translated product failure", { status: 502 })
      : new Response("compact Megamarket product proof", {
        headers: { "content-type": "text/html; charset=utf-8" }
      }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const target = "https://megamarket-ru.translate.goog/catalog/details/cereton-rastvor-250-mg-ml-4-ml-5-sht-100024500895/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";

    const response = await routedFetch(target);

    expect(await response.text()).toBe("compact Megamarket product proof");
    expect(directFetch).toHaveBeenCalledTimes(3);
    expect(directFetch.mock.calls.every(([input]) => input === "https://ratings.example/api/internal/static-review-fetch")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("routes exact pharmacy and Yandex Market Translate hosts through fixed function egress without Sandbox", async () => {
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
      "https://www-asna-ru.translate.goog/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://polza-ru.translate.goog/product/otsillokoktsinum/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://apteka-ru.translate.goog/preparation/otsillokoktsinum/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://nfapteka-ru.translate.goog/catalog/?q=Оциллококцинум&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://www-budzdorov-ru.translate.goog/forms/ocillokokcinum?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://market-yandex-ru.translate.goog/card/mikroginon-tab-po/103544271955/reviews?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://vitaexpress.ru/product/baktoblis_tabletki_bad_30/"
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

  it("recovers an exact Apteka.ru GET directly after fixed egress fails", async () => {
    const target = "https://apteka.ru/product/xloretta-2-mg--003-mg-63-sht-tabletki-pokrytye-plenochnoj-obolochkoj-69cfc7f2fe56bf3a18668d99/";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("fixed route unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response("exact first-party Apteka proof", {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("exact first-party Apteka proof");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("proves an empty Okapteka brand only from the exact first-party terminal response", async () => {
    const translatedTarget = "https://okapteka-ru.translate.goog/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const source = "https://okapteka.ru/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input).url).toBe(source);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response(exactOkaptekaMissingPage(source), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(translatedTarget);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("okapteka-first-party-missing");
    expect(await response.text()).toContain('data-ratings-empty="first-party-404"');
    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("source-binds an exact healthy first-party Okapteka group instead of returning raw HTML without a base", async () => {
    const translatedTarget = "https://okapteka-ru.translate.goog/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const source = "https://okapteka.ru/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input).url).toBe(source);
      expect(init?.redirect).toBe("manual");
      return new Response(exactOkaptekaGroupPage(source), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(translatedTarget);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("okapteka-first-party-ssr");
    expect(await response.text()).toContain(`<base href="${source}">`);
    expect(directFetch).toHaveBeenCalledOnce();
  });

  it("never turns an exact first-party Okapteka CAPTCHA 404 into an empty brand proof", async () => {
    const translatedTarget = "https://okapteka-ru.translate.goog/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const source = "https://okapteka.ru/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/";
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      const requested = new Request(input).url;
      if (requested === source) {
        return new Response(exactOkaptekaMissingPage(source, true), { status: 404 });
      }
      return new Response("upstream blocked", { status: 502 });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(translatedTarget);

    expect(response.status).toBe(502);
    expect(response.headers.get("x-ratings-source")).toBeNull();
    expect(await response.text()).not.toContain("data-ratings-empty");
  });

  it("falls back to fixed egress when the exact first-party Okapteka route is nonterminal", async () => {
    const translatedTarget = "https://okapteka-ru.translate.goog/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL) =>
      input === "https://ratings.example/api/internal/static-review-fetch"
        ? new Response("compact fixed proof", { headers: { "content-type": "text/html" } })
        : new Response("source unavailable", { status: 503 })
    );
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(translatedTarget);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("compact fixed proof");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not turn a direct Apteka.ru 404 into product absence after fixed egress fails", async () => {
    const target = "https://apteka.ru/product/xloretta-2-mg--003-mg-63-sht-tabletki-pokrytye-plenochnoj-obolochkoj-69cfc7f2fe56bf3a18668d99/";
    const directFetch = vi.fn(async (input: RequestInfo | URL) =>
      input === "https://ratings.example/api/internal/static-review-fetch"
        ? new Response("fixed route unavailable", { status: 502 })
        : new Response("direct missing", { status: 404 })
    );
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("fixed route unavailable");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("routes exact 009.рф sitemap and family-review pages directly with manual redirects", async () => {
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new Request(input).url;
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response(requested.endsWith(".xml") ? "<urlset></urlset>" : "<html>family proof</html>");
    });
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    for (const target of [
      "https://009.xn--p1ai/sitemap.xml",
      "https://009.xn--p1ai/sitemap_6.xml",
      "https://009.xn--p1ai/kupit-lirika/otzyvy"
    ]) {
      await routedFetch(target);
      const call = directFetch.mock.calls.at(-1)!;
      expect(new Request(call[0]).url).toBe(target);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to direct egress for a transient Vseotzyvy reader failure without accepting a failed route", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("reader unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe("https://vseotzyvy.ru/otzyvy/velgiya-eko-111962");
      return new Response("exact public aggregate");
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch("https://vseotzyvy.ru/otzyvy/velgiya-eko-111962");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("exact public aggregate");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to direct egress for a transient Pravogolosa reader failure", async () => {
    const run = vi.fn(async () => undefined);
    const target = "https://pravogolosa.net/otzyvcategory?catid=92997&page=show_category";
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("reader unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe(target);
      return new Response("exact category aggregate");
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("exact category aggregate");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["https://009.xn--p1ai/sitemap_2.xml", 200, 200],
    ["https://009.xn--p1ai/kupit-hloretta/otzyvy", 404, 404]
  ])("returns the exact first-party 009.рф status for adapter-level proof: %s", async (target, directStatus, expectedStatus) => {
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input).url).toBe(target);
      expect(init?.redirect).toBe("manual");
      return new Response(directStatus === 200 ? "<urlset></urlset>" : "missing", { status: directStatus });
    });
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(expectedStatus);
    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to fixed egress when an exact 009.рф direct request throws", async () => {
    const target = "https://009.xn--p1ai/sitemap_2.xml";
    const failedDirect = { signal: undefined as AbortSignal | undefined };
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("<urlset><url><loc>https://009.xn--p1ai/kupit-kagocel/otzyvy</loc></url></urlset>", {
          headers: { "content-type": "application/xml; charset=utf-8" }
        });
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.redirect).toBe("manual");
      failedDirect.signal = init?.signal ?? undefined;
      throw new TypeError("direct transport failed");
    });
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<urlset>");
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(failedDirect.signal?.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts a stalled exact 009.рф direct request before starting fixed egress", async () => {
    vi.useFakeTimers();
    const target = "https://009.xn--p1ai/sitemap_2.xml";
    const stalled = { signal: undefined as AbortSignal | undefined };
    const directFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return Promise.resolve(new Response(
          "<urlset><url><loc>https://009.xn--p1ai/kupit-kagocel/otzyvy</loc></url></urlset>"
        ));
      }
      stalled.signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        stalled.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });
    const pending = routedFetch(target);

    await vi.advanceTimersByTimeAsync(PHARMACY009_DIRECT_TIMEOUT_MS + 1);
    const response = await pending;

    expect(stalled.signal?.aborted).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<urlset>");
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

  it("returns an exact 009.рф family redirect without following it", async () => {
    const target = "https://009.xn--p1ai/kupit-hloretta/otzyvy";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input).url).toBe(target);
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "/404" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    expect((await routedFetch(target)).status).toBe(302);
    expect(directFetch).toHaveBeenCalledOnce();
  });

  it("does not recover an unbounded 009.рф path directly", async () => {
    const directFetch = vi.fn(async () => new Response("fixed route unavailable", { status: 502 }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    expect((await routedFetch("https://009.xn--p1ai/catalog/?q=Хлорэтта")).status).toBe(502);
    expect(directFetch).toHaveBeenCalledOnce();
  });

  it("preserves a first-party terminal status for one exact ru.otzyv.com product after reader failure", async () => {
    const run = vi.fn(async () => undefined);
    const target = "https://ru.otzyv.com/hloretta";
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("reader unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe(target);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(404);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers one bounded ru.otzyv.com brand search after reader failure", async () => {
    const run = vi.fn(async () => undefined);
    const target = "https://ru.otzyv.com/search/?q=%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("reader unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.redirect).toBe("manual");
      return new Response('<div class="no-results">Ничего не найдено</div>', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(200);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not use direct egress for an arbitrary ru.otzyv.com URL", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async () => new Response("reader unavailable", { status: 502 }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch("https://ru.otzyv.com/search/?q=%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0&page=2");

    expect(response.status).toBe(502);
    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not follow a redirect from an exact ru.otzyv.com product fallback", async () => {
    const run = vi.fn(async () => undefined);
    const target = "https://ru.otzyv.com/hloretta";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "https://ratings.example/api/internal/static-review-fetch") {
        return new Response("reader unavailable", { status: 502 });
      }
      expect(new Request(input).url).toBe(target);
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/not-found" }
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(502);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps exact Wildberries root feedback off the shared Sandbox queue", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn().mockResolvedValueOnce(new Response('{"feedbackCount":5}'));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const url = "https://feedbacks1.wb.ru/feedbacks/v2/214718282?appType=1";

    const response = await routedFetch(url);

    expect(await response.text()).toBe('{"feedbackCount":5}');
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ url });
    expect(run).not.toHaveBeenCalled();
  });

  it("routes only bounded ASNA card sitemaps through fixed function egress", async () => {
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } })
    );
    vi.stubGlobal("fetch", directFetch);
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "t".repeat(32)
    });

    const target = "https://www.asna.ru/sitemap/sitemap_cards1.xml?slugs=cereton%2Ctsereton";
    expect(await (await routedFetch(target)).text()).toBe("<urlset></urlset>");
    expect(run).not.toHaveBeenCalled();
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ url: target });
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

  it("forwards one synthetic Yandex batch as one static proof request without Sandbox or shard handoffs", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      processed: 2,
      firstSitemap: "a",
      lastSitemap: "b",
      verifiedSitemaps: ["a", "b"],
      matches: []
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    }) as typeof fetch & { yandexBatchEndpoint?: string };
    const payload = {
      sitemaps: [
        "https://reviews.yandex.ru/ugcpub/sitemap_model_0-9999999-0.xml",
        "https://reviews.yandex.ru/ugcpub/sitemap_model_10000000-19999999-0.xml"
      ],
      brands: [{ brand: "oscillococcinum", tokens: ["oscillococcinum"] }]
    };

    const response = await routedFetch(routedFetch.yandexBatchEndpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    expect(response.status).toBe(200);
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      url: "https://reviews.yandex.ru/ugcpub/__ratings_batch__",
      yandexBatch: payload
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503, 504])("splits a Yandex batch after HTTP %i and recombines complete proofs", async (failureStatus) => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const forwarded = JSON.parse(String(init?.body)) as {
        yandexBatch: { sitemaps: string[]; brands: Array<{ brand: string }> };
      };
      const sitemaps = forwarded.yandexBatch.sitemaps;
      if (sitemaps.length === 4) return new Response("function could not prove the full group", { status: failureStatus });
      return new Response(JSON.stringify({
        processed: sitemaps.length,
        firstSitemap: sitemaps[0],
        lastSitemap: sitemaps.at(-1),
        verifiedSitemaps: sitemaps,
        tombstonedSitemaps: sitemaps[0] === "a" ? ["b"] : ["c"],
        matches: sitemaps[0] === "a" ? [{
          brand: forwarded.yandexBatch.brands[0]!.brand,
          url: "https://reviews.yandex.ru/product/cereton--123",
          sitemap: "a"
        }] : []
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    }) as typeof fetch & { yandexBatchEndpoint?: string };
    const payload = {
      sitemaps: ["a", "b", "c", "d"],
      brands: [{ brand: "Церетон", tokens: ["cereton"] }]
    };

    const response = await routedFetch(routedFetch.yandexBatchEndpoint!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const proof = await response.json() as {
      processed: number;
      firstSitemap: string;
      lastSitemap: string;
      verifiedSitemaps: string[];
      tombstonedSitemaps?: string[];
      matches: Array<{ brand: string; url: string; sitemap: string }>;
    };

    expect(response.status).toBe(200);
    expect(proof).toEqual({
      processed: 4,
      firstSitemap: "a",
      lastSitemap: "d",
      verifiedSitemaps: ["a", "b", "c", "d"],
      tombstonedSitemaps: ["b", "c"],
      matches: [{ brand: "Церетон", url: "https://reviews.yandex.ru/product/cereton--123", sitemap: "a" }]
    });
    expect(directFetch).toHaveBeenCalledTimes(3);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts both Yandex split halves before waiting for either proof", async () => {
    const run = vi.fn(async () => undefined);
    const releases = new Map<string, (response: Response) => void>();
    const singletonCalls: string[] = [];
    const directFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const forwarded = JSON.parse(String(init?.body)) as {
        yandexBatch: { sitemaps: string[]; brands: Array<{ brand: string }> };
      };
      const sitemaps = forwarded.yandexBatch.sitemaps;
      if (sitemaps.length === 2) return new Response("split this group", { status: 504 });
      const sitemap = sitemaps[0]!;
      singletonCalls.push(sitemap);
      return await new Promise<Response>((resolve) => releases.set(sitemap, resolve));
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    }) as typeof fetch & { yandexBatchEndpoint?: string };

    const pending = routedFetch(routedFetch.yandexBatchEndpoint!, {
      method: "POST",
      body: JSON.stringify({
        sitemaps: ["left", "right"],
        brands: [{ brand: "Кагоцел", tokens: ["kagotsel"] }]
      })
    });

    await vi.waitFor(() => expect(singletonCalls).toEqual(["left", "right"]));
    for (const sitemap of singletonCalls) {
      releases.get(sitemap)!(new Response(JSON.stringify({
        processed: 1,
        firstSitemap: sitemap,
        lastSitemap: sitemap,
        verifiedSitemaps: [sitemap],
        matches: []
      }), { headers: { "content-type": "application/json" } }));
    }

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processed: 2,
      firstSitemap: "left",
      lastSitemap: "right",
      verifiedSitemaps: ["left", "right"]
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a persistent singleton Yandex failure without retrying the same payload", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "one shard remained unproven" }), { status: 502 })
    );
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    }) as typeof fetch & { yandexBatchEndpoint?: string };

    const response = await routedFetch(routedFetch.yandexBatchEndpoint!, {
      method: "POST",
      body: JSON.stringify({
        sitemaps: ["first"],
        brands: [{ brand: "Церетон", tokens: ["cereton"] }]
      })
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "one shard remained unproven" });
    expect(directFetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a hanging Yandex gateway transport into a splittable 504", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      let transportAborted = false;
      const directFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          transportAborted = true;
          reject(init.signal?.reason);
        }, { once: true });
      }));
      vi.stubGlobal("fetch", directFetch);
      const routedFetch = browserFetch(sandbox(run), {
        endpoint: "https://ratings.example/api/internal/static-review-fetch",
        token: "internal-token"
      }) as typeof fetch & { yandexBatchEndpoint?: string };

      const pending = routedFetch(routedFetch.yandexBatchEndpoint!, {
        method: "POST",
        body: JSON.stringify({
          sitemaps: ["first"],
          brands: [{ brand: "Бактоблис", tokens: ["baktoblis"] }]
        })
      });
      await vi.advanceTimersByTimeAsync(YANDEX_BATCH_GATEWAY_TIMEOUT_MS);
      const response = await pending;

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "Yandex batch gateway transport timed out" });
      expect(directFetch).toHaveBeenCalledOnce();
      expect(transportAborted).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses fixed function egress before a hanging direct Yandex request", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) return new Promise<Response>(() => undefined);
      expect(input).toBe("https://ratings.example/api/internal/static-review-fetch");
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://reviews.yandex.ru/ugcpub/sitemap.xml"
      });
      return new Response("<?xml version=\"1.0\"?><sitemapindex></sitemapindex>", {
        headers: { "content-type": "application/xml" }
      });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch("https://reviews.yandex.ru/ugcpub/sitemap.xml");

    expect(response.ok).toBe(true);
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).not.toBeInstanceOf(Request);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not probe direct Yandex egress before the complete fixed-route sitemap", async () => {
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
    expect(directFetch).toHaveBeenCalledOnce();
    expect(directFetch.mock.calls[0]?.[0]).toBe("https://ratings.example/api/internal/static-review-fetch");
    expect(JSON.parse(String((directFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ url: target });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a lazy Sandbox quota failure to AdapterQuotaError", async () => {
    const run = vi.fn(async () => {
      throw new Error("Sandbox quota exceeded");
    });
    const routedFetch = browserFetch(sandbox(run));

    await expect(routedFetch(
      "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=%2Fsearch%2F%3Ftext%3Dtest%26from_global%3Dtrue",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "ozon-composer"
        }
      }
    )).rejects.toBeInstanceOf(AdapterQuotaError);
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
    )).rejects.toBeInstanceOf(AdapterQuotaError);
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

  it("returns an explicit static Wildberries no-results proof without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "По запросу «Бактоблис» ничего не нашлось. Попробуйте изменить запрос.",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )));
    const routedFetch = browserFetch(sandbox(run));

    const response = await routedFetch(
      "https://www.wildberries.ru/catalog/0/search.aspx?search=Бактоблис&page=1",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "wildberries-search-proof"
        }
      }
    );

    await expect(response.json()).resolves.toMatchObject({
      products: [],
      total: 0,
      metadata: { source: "wildberries-static-explicit-no-results", query: "Бактоблис" }
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("acquires Sandbox once for concurrent browser consumers", async () => {
    const run = vi.fn(async () => undefined);
    const acquire = createLazySandboxAcquire(sandbox(run));

    expect(run).not.toHaveBeenCalled();
    await Promise.all([acquire(), acquire()]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not memoize a rejected Sandbox acquisition across a transient recovery pass", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Sandbox HTTP 502"))
      .mockResolvedValue(undefined);
    const acquire = createLazySandboxAcquire(sandbox(run));

    await expect(acquire()).rejects.toBeInstanceOf(AdapterBlockedError);
    await expect(acquire()).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("exposes only the fixed Yandex Market browser-search capability", async () => {
    const run = vi.fn(async () => undefined);
    const routedFetch = browserFetch(sandbox(run)) as typeof fetch & { yandexMarketBrowserEndpoint?: string };

    expect(routedFetch.yandexMarketBrowserEndpoint).toBe("https://market.yandex.ru/search");
    await expect(routedFetch(
      "https://market.yandex.ru/profile/orders",
      {
        headers: {
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "yandex-market-proof"
        }
      }
    )).rejects.toThrow(/restricted to bounded search or exact reviews routes/);
    expect(run).not.toHaveBeenCalled();
  });

  it("buffers a streamed Wildberries function response before releasing its attempt signal", async () => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal!;
      return new Response(new ReadableStream({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('{"total":1,"products":[{"id":1}]}'));
            controller.close();
          }, 10);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            controller.error(signal.reason);
          }, { once: true });
        }
      }));
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(
      "https://search.wb.ru/exactmatch/ru/common/v14/search?appType=1&query=Андродоз"
    );

    await expect(response.text()).resolves.toContain('"total":1');
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    "https://apteka-ru.translate.goog/product/enterolaktis-duo-20-sht-sashe-po-5-g-6267ea3630197ea53c0caa2c/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
    "https://www-budzdorov-ru.translate.goog/product/enterolaktis-duo-sashe-5g-no20-bad-5005750?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
    "https://www-asna-ru.translate.goog/cards/enterolaktis_plyus_kaps_n15_sofar_spa.html?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
  ])("recovers an exact pharmacy Translate page through free Agent egress after fixed egress fails: %s", async (target) => {
    const run = vi.fn(async () => undefined);
    const directFetch = vi.fn(async (input: RequestInfo | URL) =>
      typeof input === "string"
        ? new Response("transient fixed egress failure", { status: 502 })
        : new Response("exact pharmacy page", { headers: { "content-type": "text/html; charset=utf-8" } })
    );
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(await response.text()).toBe("exact pharmacy page");
    expect(directFetch).toHaveBeenCalledTimes(3);
    expect(directFetch.mock.calls.slice(0, 2).every(([input]) => input === "https://ratings.example/api/internal/static-review-fetch")).toBe(true);
    expect(directFetch.mock.calls[2]![0]).toBeInstanceOf(Request);
    expect((directFetch.mock.calls[2]![0] as Request).url).toBe(new URL(target).toString());
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts only an explicit Yandex Market no-results statement for the requested query", () => {
    expect(hasExplicitYandexMarketNoResults(
      "По запросу «Энтеролактис» ничего не нашли",
      "Энтеролактис"
    )).toBe(true);
    expect(hasExplicitYandexMarketNoResults(
      "По запросу «Другой бренд» ничего не нашли",
      "Энтеролактис"
    )).toBe(false);
    expect(hasExplicitYandexMarketNoResults("Товары временно недоступны", "Энтеролактис")).toBe(false);
  });

  it("extracts exact search metrics and shared SKU proof from first-party Yandex JSON-LD", () => {
    const html = `<html><body>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Энтеролактис — купить по низкой цене на Яндекс Маркете",
        itemListElement: [{
          "@type": "ListItem",
          position: 1,
          item: {
            "@type": "Product",
            name: "Энтеролактис Плюс капсулы 319мг 15шт",
            url: "https://market.yandex.ru/card/enterolaktis-plyus-kaps/103552838402",
            sku: "101596320306",
            aggregateRating: { "@type": "AggregateRating", ratingValue: 4.9, ratingCount: 55 }
          }
        }]
      })}</script>
      <a href="/search?text=${encodeURIComponent("Энтеролактис")}&amp;page=2">Вперёд</a>
    </body></html>`;

    expect(extractYandexMarketSearchHtmlProof(html, "Энтеролактис", 1)).toEqual({
      query: "Энтеролактис",
      page: 1,
      hasNext: true,
      products: [{
        id: "103552838402",
        name: "Энтеролактис Плюс капсулы 319мг 15шт",
        url: "https://market.yandex.ru/card/enterolaktis-plyus-kaps/103552838402",
        ratingCount: 55,
        rating: 4.9,
        familyId: "101596320306"
      }]
    });
    expect(extractYandexMarketSearchHtmlProof(html.replace("ratingCount\":55", "ratingCount\":null"),
      "Энтеролактис", 1)?.products[0]).not.toHaveProperty("ratingCount");
  });

  it("uses fixed Yandex search JSON-LD proof without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      name: "Энтеролактис — купить на Яндекс Маркете",
      itemListElement: [{
        item: {
          "@type": "Product",
          name: "Энтеролактис Дуо саше 5г 20шт",
          url: "https://market.yandex.ru/card/enterolaktis-duo-por-sashe/103552838702",
          sku: "101758091850",
          aggregateRating: { ratingValue: 4.8, ratingCount: 24 }
        }
      }]
    })}</script>`;
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const url = `https://market.yandex.ru/search?text=${encodeURIComponent("Энтеролактис")}`;

    const response = await routedFetch(url, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "yandex-market-proof" }
    });

    await expect(response.json()).resolves.toMatchObject({
      query: "Энтеролактис",
      page: 1,
      hasNext: false,
      products: [{ id: "103552838702", ratingCount: 24, rating: 4.8, familyId: "101758091850" }]
    });
    expect(directFetch).toHaveBeenCalledOnce();
    const translatedRequest = new URL(JSON.parse(String((directFetch.mock.calls[0]![1] as RequestInit).body)).url);
    expect(translatedRequest.hostname).toBe("market-yandex-ru.translate.goog");
    expect(translatedRequest.pathname).toBe("/search");
    expect(translatedRequest.searchParams.get("text")).toBe("Энтеролактис");
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers Polza through one bounded direct Translate request after fixed egress 502", async () => {
    const target = "https://polza-ru.translate.goog/catalog/hloretta-tabletki-2-mg-30-mkg-21-sht_78690/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en";
    const directFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "https://ratings.example/api/internal/static-review-fetch"
        ? new Response("fixed route failed", { status: 502 })
        : new Response("exact direct proof", { headers: { "content-type": "text/html" } })
    );
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch", token: "internal-token"
    });

    expect(await (await routedFetch(target)).text()).toBe("exact direct proof");
    expect(directFetch).toHaveBeenCalledTimes(3);
    expect(new Request(directFetch.mock.calls.at(-1)?.[0]!).url).toBe(target);
  });

  it("preserves authoritative proxy 404 for an exact Zdravcity brand route", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const directFetch = vi.fn(async (input: RequestInfo | URL) =>
      new Request(input).url === target
        ? new Response("forbidden", { status: 403 })
        : new Response("missing", { status: 404 })
    );
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch", token: "internal-token"
    });

    const response = await routedFetch(target);
    expect(response.status).toBe(404);
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

  it("recovers an exact missing Zdravcity brand through the bounded first-party BFF proof", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const staticEndpoint = "https://ratings.example/api/internal/static-review-fetch";
    const directFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requested = new Request(input).url;
      if (requested === target) return new Response("forbidden", { status: 403 });
      if (requested === staticEndpoint) return new Response("fixed route unavailable", { status: 502 });
      const bff = new URL(requested);
      expect(bff.origin + bff.pathname).toBe("https://zdravcity.ru/bff/query");
      expect(init?.method).toBe("GET");
      expect(bff.searchParams.get("operationName")).toBe("ExactGroupPresence");
      expect(JSON.parse(bff.searchParams.get("variables") ?? "null")).toEqual({
        regionID: "moscowregion", code: "hloretta"
      });
      return new Response(JSON.stringify({
        errors: [{
          message: "queryResolver.Group: catalog.Manager.Group: rpc error: code = NotFound desc = group.group: catalog.group by code hloretta: group not found",
          path: ["group"], extensions: { code: 404 }
        }],
        data: null
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: staticEndpoint, token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-ratings-source")).toBe("zdravcity-first-party-bff-missing");
    expect(directFetch).toHaveBeenCalledTimes(3);
  });

  it("recovers a Zdravcity missing proof through the exact translated BFF GET when direct BFF egress is blocked", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const staticEndpoint = "https://ratings.example/api/internal/static-review-fetch";
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      const requested = new URL(new Request(input).url);
      if (requested.toString() === target) return new Response("forbidden", { status: 403 });
      if (requested.toString() === staticEndpoint) return new Response("fixed route unavailable", { status: 502 });
      if (requested.hostname === "zdravcity.ru" && requested.pathname === "/bff/query") {
        return new Response("direct BFF forbidden", { status: 403 });
      }
      expect(requested.hostname).toBe("zdravcity-ru.translate.goog");
      expect(requested.pathname).toBe("/bff/query");
      return new Response(JSON.stringify({
        errors: [{
          message: "queryResolver.Group: catalog.Manager.Group: rpc error: code = NotFound desc = group.group: catalog.group by code hloretta: group not found",
          path: ["group"], extensions: { code: 404 }
        }],
        data: null
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: staticEndpoint, token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-ratings-source")).toBe("zdravcity-first-party-bff-missing");
    expect(directFetch).toHaveBeenCalledTimes(4);
  });

  it("never accepts a Zdravcity BFF missing envelope bound to another slug", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const staticEndpoint = "https://ratings.example/api/internal/static-review-fetch";
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      const requested = new Request(input).url;
      if (requested === target) return new Response("forbidden", { status: 403 });
      if (requested === staticEndpoint) return new Response("fixed route unavailable", { status: 502 });
      return new Response(JSON.stringify({
        errors: [{
          message: "queryResolver.Group: catalog.Manager.Group: rpc error: code = NotFound desc = group.group: catalog.group by code kagocel: group not found",
          path: ["group"], extensions: { code: 404 }
        }],
        data: null
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: staticEndpoint, token: "internal-token"
    });

    const response = await routedFetch(target);

    expect(response.status).toBe(403);
    expect(response.headers.get("x-ratings-source")).toBeNull();
  });

  it("falls back from a transient Yandex index gateway failure to exact direct XML", async () => {
    const target = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
    const directFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "https://ratings.example/api/internal/static-review-fetch"
        ? new Response("temporary", { status: 502 })
        : new Response("<sitemapindex></sitemapindex>", { headers: { "content-type": "application/xml" } })
    );
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(vi.fn()), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch", token: "internal-token"
    });

    expect(await (await routedFetch(target)).text()).toBe("<sitemapindex></sitemapindex>");
    expect(new Request(directFetch.mock.calls.at(-1)?.[0]!).url).toBe(target);
  });

  it("uses an exact translated Yandex Market card proof without acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const source = "https://market.yandex.ru/card/tikalizis-tabletki-po-plen-60mg-60sht/5052501058/reviews";
    const html = `<html><body><script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "Тикализис таблетки п/о плен. 60мг 60шт",
      url: source,
      aggregateRating: { ratingValue: 0, ratingCount: 0, reviewCount: 0, bestRating: 5 }
    })}</script></body></html>`;
    const directFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-ratings-source": "google-translate-yandex-market-compact",
        "x-ratings-final-url": source
      }
    }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });

    const response = await routedFetch(source, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "yandex-market-proof" }
    });

    expect(await response.text()).toContain('"ratingCount":0');
    const translatedRequest = new URL(JSON.parse(String((directFetch.mock.calls[0]![1] as RequestInit).body)).url);
    expect(translatedRequest.toString()).toBe(
      "https://market-yandex-ru.translate.goog/card/tikalizis-tabletki-po-plen-60mg-60sht/5052501058/reviews?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("retries one strict translated Yandex search proof miss before acquiring Sandbox", async () => {
    const run = vi.fn(async () => undefined);
    const exactHtml = `<script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      name: "Бактоблис — купить на Яндекс Маркете",
      itemListElement: [{
        item: {
          "@type": "Product",
          name: "Бактоблис Плюс таблетки для рассасывания 950 мг 30 шт",
          url: "https://market.yandex.ru/card/baktoblis-plyus-tabletki/103259424620",
          sku: "103259424620",
          aggregateRating: { ratingValue: 4.9, ratingCount: 41 }
        }
      }]
    })}</script>`;
    const directFetch = vi.fn()
      .mockResolvedValueOnce(new Response("<html><body>unhydrated search shell</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      }))
      .mockResolvedValueOnce(new Response(exactHtml, {
        headers: { "content-type": "text/html; charset=utf-8" }
      }));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const url = `https://market.yandex.ru/search?text=${encodeURIComponent("Бактоблис")}`;

    const response = await routedFetch(url, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "yandex-market-proof" }
    });

    await expect(response.json()).resolves.toMatchObject({
      query: "Бактоблис",
      page: 1,
      hasNext: false,
      products: [{ id: "103259424620", ratingCount: 41, rating: 4.9 }]
    });
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(directFetch.mock.calls.every(([input]) =>
      input === "https://ratings.example/api/internal/static-review-fetch")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps two unproven translated Yandex search responses fail-closed and falls back to Sandbox", async () => {
    const run = vi.fn(async () => {
      throw new Error("test Sandbox unavailable");
    });
    const directFetch = vi.fn(async () => new Response(
      "<html><body>search markup without exact ItemList proof</body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
    vi.stubGlobal("fetch", directFetch);
    const routedFetch = browserFetch(sandbox(run), {
      endpoint: "https://ratings.example/api/internal/static-review-fetch",
      token: "internal-token"
    });
    const url = `https://market.yandex.ru/search?text=${encodeURIComponent("Бактоблис")}`;

    await expect(routedFetch(url, {
      headers: { "x-ratings-browser": "1", "x-ratings-browser-mode": "yandex-market-proof" }
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof AdapterBlockedError &&
      error.message.includes("EdgeOne Sandbox is unavailable")
    );

    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
  });

  it("classifies an exhausted EdgeOne monthly GB-s allowance as quota", async () => {
    const run = vi.fn(async () => {
      throw new Error("EdgeOne Sandbox monthly GB-s quota exceeded; requestId=test-request");
    });
    const acquire = createLazySandboxAcquire(sandbox(run));

    await expect(acquire()).rejects.toMatchObject({
      code: "quota_exceeded",
      message: expect.stringMatching(/monthly GB-s quota exceeded/)
    });
    await expect(acquire()).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("ratings Agent browser lane scheduler", () => {
  it("runs marketplace lanes independently while serializing each lane and bounding total work", async () => {
    const schedule = createBrowserLaneScheduler(3);
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const releases = new Map<string, () => void>();
    const task = (lane: "ozon" | "yandex" | "wildberries" | "generic", id: string) =>
      schedule(lane, async () => {
        started.push(id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.set(id, resolve));
        active -= 1;
        return id;
      });

    const ozonFirst = task("ozon", "ozon-1");
    const ozonSecond = task("ozon", "ozon-2");
    const yandex = task("yandex", "yandex-1");
    const wildberries = task("wildberries", "wildberries-1");
    const generic = task("generic", "generic-1");

    await vi.waitFor(() => expect(started).toEqual(["ozon-1", "yandex-1", "wildberries-1"]));
    expect(maxActive).toBe(3);
    expect(started).not.toContain("ozon-2");
    expect(started).not.toContain("generic-1");

    releases.get("yandex-1")!();
    await vi.waitFor(() => expect(started).toContain("generic-1"));
    expect(started).not.toContain("ozon-2");

    releases.get("ozon-1")!();
    await vi.waitFor(() => expect(started).toContain("ozon-2"));
    releases.get("wildberries-1")!();
    releases.get("generic-1")!();
    releases.get("ozon-2")!();

    await expect(Promise.all([ozonFirst, ozonSecond, yandex, wildberries, generic])).resolves.toEqual([
      "ozon-1", "ozon-2", "yandex-1", "wildberries-1", "generic-1"
    ]);
  });

  it("rejects an invalid shared concurrency limit", () => {
    expect(() => createBrowserLaneScheduler(0)).toThrow(RangeError);
  });
});

describe("ratings Agent static proxy scheduler", () => {
  it("bounds the shared gateway while allowing two requests per host", async () => {
    const schedule = createStaticProxyScheduler(4, 2);
    let active = 0;
    let maxActive = 0;
    const activeByHost = new Map<string, number>();
    const maxByHost = new Map<string, number>();
    const releases: Array<() => void> = [];
    const task = (host: string) => schedule(host, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const hostActive = (activeByHost.get(host) ?? 0) + 1;
      activeByHost.set(host, hostActive);
      maxByHost.set(host, Math.max(maxByHost.get(host) ?? 0, hostActive));
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      activeByHost.set(host, (activeByHost.get(host) ?? 1) - 1);
    });

    const pending = [
      task("a.example"), task("a.example"), task("a.example"),
      task("b.example"), task("b.example"), task("b.example")
    ];
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);

    expect(maxActive).toBe(4);
    expect(maxByHost).toEqual(new Map([["a.example", 2], ["b.example", 2]]));
  });

  it("rejects invalid limits", () => {
    expect(() => createStaticProxyScheduler(0, 1)).toThrow(RangeError);
    expect(() => createStaticProxyScheduler(2, 3)).toThrow(RangeError);
  });
});
