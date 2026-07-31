import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserFetch,
  createLazySandboxAcquire,
  hasExplicitWildberriesNoResults,
  hasExplicitYandexMarketNoResults,
  shouldAutoRetryInitialCollection,
  transientRecoveryDelayMs,
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
      "https://okapteka-ru.translate.goog/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://www-asna-ru.translate.goog/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://polza-ru.translate.goog/product/otsillokoktsinum/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://apteka-ru.translate.goog/preparation/otsillokoktsinum/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://nfapteka-ru.translate.goog/catalog/?q=Оциллококцинум&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://www-budzdorov-ru.translate.goog/forms/ocillokokcinum?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en",
      "https://market-yandex-ru.translate.goog/card/mikroginon-tab-po/103544271955/reviews?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en"
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

  it.each([502, 504])("splits a Yandex batch after HTTP %i and recombines complete proofs", async (failureStatus) => {
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

  it("acquires Sandbox once for concurrent browser consumers", async () => {
    const run = vi.fn(async () => undefined);
    const acquire = createLazySandboxAcquire(sandbox(run));

    expect(run).not.toHaveBeenCalled();
    await Promise.all([acquire(), acquire()]);
    expect(run).toHaveBeenCalledOnce();
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

  it("classifies an exhausted EdgeOne monthly GB-s allowance as quota", async () => {
    const run = vi.fn(async () => {
      throw new Error("EdgeOne Sandbox monthly GB-s quota exceeded; requestId=test-request");
    });
    const acquire = createLazySandboxAcquire(sandbox(run));

    await expect(acquire()).rejects.toMatchObject({
      code: "quota_exceeded",
      message: expect.stringMatching(/monthly GB-s quota exceeded/)
    });
  });
});

describe("ratings Agent initial recovery pass", () => {
  it("cools down transient retries for every shared collection route", () => {
    expect(transientRecoveryDelayMs([
      { domain: "ozon.ru", status: "blocked", message: "blocked: HTTP 502" }
    ], 0)).toBe(750);
    expect(transientRecoveryDelayMs([
      { domain: "ozon.ru", status: "blocked", message: "blocked: HTTP 429" }
    ], 3)).toBe(3000);
    expect(transientRecoveryDelayMs([
      { domain: "example.com", status: "blocked", message: "blocked: HTTP 503" }
    ], 1)).toBe(1500);
    expect(transientRecoveryDelayMs([
      { domain: "example.com", status: "blocked", message: "parser_changed: missing selector" }
    ], 0)).toBe(0);
  });

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
    expect(shouldAutoRetryInitialCollection("queued", [
      { status: "blocked", message: "Ozon exact product proof is unavailable: translated detail HTTP 502" }
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
