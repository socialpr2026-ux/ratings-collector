import { afterEach, describe, expect, it, vi } from "vitest";
import onRequest, { staticReviewFetch } from "../cloud-functions/api/[[default]].js";

afterEach(() => vi.unstubAllGlobals());

function exactOkaptekaMissingPage(source: string, challenge = false): string {
  return `<!doctype html><html><head><link rel="canonical" href="${source}"></head><body>` +
    `<!-- ${"verified-first-party-template ".repeat(45)} -->` +
    `${challenge ? '<form data-sitekey="captcha"></form>' : ""}` +
    `<div class="error-page"><img class="error-page__image" src="/error.png" alt="404">` +
    `<h1 class="error-page__header">Похоже Вы потерялись</h1>` +
    `<h3 class="error-page__message">Попробуйте вернуться назад или поищите что-нибудь другое.</h3>` +
    `<a href="/" class="btn">Вернуться на главную</a></div></body></html>`;
}

function exactOkaptekaGroupPage(source: string, options: { challenge?: boolean; canonical?: string } = {}): string {
  return `<!doctype html><html><head><link rel="canonical" href="${options.canonical ?? source}"></head><body>` +
    `<!-- ${"verified-first-party-group ".repeat(45)} -->` +
    `${options.challenge ? '<form data-sitekey="captcha"></form>' : ""}` +
    `<article class="product"><a href="/kagotsyel-tab-12mg-30-529011/">Кагоцел таблетки 12мг №30</a></article>` +
    `</body></html>`;
}

describe("public configuration", () => {
  it("does not expose an editable spreadsheet URL", async () => {
    const response = await onRequest({
      request: new Request("https://ratings.example/api/config"),
      env: {}
    });
    const config = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(config).not.toHaveProperty("defaultSheetUrl");
    expect(JSON.stringify(config)).not.toContain("docs.google.com/spreadsheets");
    expect(config.companyBrands).toHaveLength(68);
    expect(config.companyBrands).toEqual(expect.arrayContaining(["Canpol Babies", "Кагоцел", "Хондрофен", "Даксабрис"]));
    expect(new Set(config.companyBrands as string[]).size).toBe(68);
  });

  it("buffers an employee review decision before any repository request", async () => {
    const upstream = vi.fn(async () => { throw new Error("repository must not run before the request body is parsed"); });
    vi.stubGlobal("fetch", upstream);

    const response = await onRequest({
      request: new Request("https://ratings.example/api/runs/run-1/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      }),
      env: { RATINGS_ALLOW_UNAUTHENTICATED: "true" }
    });

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/JSON|Unexpected/i) });
  });

});

describe("new static collector gateways", () => {
  const token = "n".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );

  it("allows only the exact Otzyv.pro root used by the adapter health check", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://otzyv.pro/");
      return new Response("<html><title>Отзывы</title><body>Каталог отзывов</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    expect((await callGateway("https://otzyv.pro/")).status).toBe(200);
    for (const unsafe of [
      "https://otzyv.pro/?tracking=1",
      "https://otzyv.pro/#fragment",
      "https://www.otzyv.pro/",
      "https://user@otzyv.pro/"
    ]) {
      expect((await callGateway(unsafe)).status).toBe(400);
    }
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("recovers an exact Otzyv.pro product through a source-bound reader proof", async () => {
    const target = "https://otzyv.pro/category/badyi/800945-baktoblis-otzyvy.html";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const requested = String(input);
      if (requested === target) return new Response("fixed egress unavailable", { status: 502 });
      expect(requested).toBe(`https://r.jina.ai/${target}`);
      return new Response(`Title: БАКТОБЛИС ОТЗЫВЫ отрицательные и реальные отзывы\n` +
        `URL Source: ${target}\n\nMarkdown Content:\n# Бактоблис отзывы\n\nСредняя оценка: 5 из 5\n\nОтзывы: 3\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("otzyv-pro-reader-compact");
    expect(html).toContain('<link rel="canonical" href="https://otzyv.pro/category/badyi/800945-baktoblis-otzyvy.html">');
    expect(html).toContain('<meta itemprop="reviewCount" content="3">');
    expect(html).toContain('<meta itemprop="ratingValue" content="5">');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("rejects an Otzyv.pro reader response bound to another product", async () => {
    const target = "https://otzyv.pro/category/badyi/800945-baktoblis-otzyvy.html";
    const upstream = vi.fn(async (input: RequestInfo | URL) => String(input) === target
      ? new Response("fixed egress unavailable", { status: 502 })
      : new Response(`Title: Бактоблис отзывы\nURL Source: https://otzyv.pro/category/badyi/999999-other.html\n` +
        `Markdown Content:\n# Бактоблис отзывы\nСредняя оценка: 5 из 5\nОтзывы: 3\n`));
    vi.stubGlobal("fetch", upstream);

    expect((await callGateway(target)).status).toBe(502);
  });

  it("routes only exact VitaExpress registry page shapes through fixed egress", async () => {
    const target = "https://vitaexpress.ru/product/baktoblis_tabletki_bad_30/";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(target);
      return new Response("<html><h1>Бактоблис Плюс таблетки для рассасывания №30</h1></html>", {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    expect((await callGateway(target)).status).toBe(200);
    expect((await callGateway("https://vitaexpress.ru/product/baktoblis_tabletki_bad_30/?next=evil")).status).toBe(400);
    expect((await callGateway("https://www.vitaexpress.ru/product/baktoblis_tabletki_bad_30/")).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("recovers an exact complete Wildberries card batch through the source-bound reader", async () => {
    const target = "https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&lang=ru&locale=ru&nm=11%3B22";
    const products = [
      { id: 11, name: "Бактоблис таблетки №30", brand: "Бактоблис", nmFeedbacks: 4, nmReviewRating: 5 },
      { id: 22, name: "Бактоблис Дуо №10", brand: "Бактоблис", nmFeedbacks: 0, nmReviewRating: 0 }
    ];
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const requested = String(input);
      if (requested === target) return new Response("fixed WB egress unavailable", { status: 502 });
      expect(requested).toBe(`https://r.jina.ai/${target}`);
      return new Response(`Title: \nURL Source: ${target}\n\nMarkdown Content:\n${JSON.stringify({ products })}`, {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("wildberries-reader-exact-batch");
    await expect(response.json()).resolves.toEqual({ products });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps an incomplete or source-mismatched Wildberries reader batch blocked", async () => {
    const target = "https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&lang=ru&locale=ru&nm=11%3B22";
    const upstream = vi.fn(async (input: RequestInfo | URL) => String(input) === target
      ? new Response("fixed WB egress unavailable", { status: 502 })
      : new Response(`Title: \nURL Source: ${target}\n\nMarkdown Content:\n${JSON.stringify({ products: [
        { id: 11, name: "Бактоблис таблетки №30", brand: "Бактоблис", nmFeedbacks: 4, nmReviewRating: 5 }
      ] })}`));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('"nmFeedbacks":0');
  });

  it("proxies only one exact Wildberries root-feedback route", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://feedbacks1.wb.ru/feedbacks/v2/214718282?appType=1");
      return new Response('{"feedbackCount":5,"valuation":0}', {
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const exact = await callGateway("https://feedbacks1.wb.ru/feedbacks/v2/214718282?appType=1");
    expect(exact.status).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({ feedbackCount: 5, valuation: 0 });

    for (const unsafe of [
      "https://feedbacks1.wb.ru/feedbacks/v2/not-a-root?appType=1",
      "https://feedbacks1.wb.ru/feedbacks/v2/214718282",
      "https://feedbacks1.wb.ru/feedbacks/v2/214718282?appType=2",
      "https://feedbacks1.wb.ru/feedbacks/v2/214718282?appType=1&next=https://evil.example"
    ]) {
      expect((await callGateway(unsafe)).status).toBe(400);
    }
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("proxies only exact 009.рф sitemap and family-review routes", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(url.pathname.endsWith(".xml")
        ? "<urlset><url><loc>https://009.xn--p1ai/kupit-lirika/otzyvy</loc></url></urlset>"
        : "<html><h1 class='reviewsPage__h1'>ЛИРИКА ОТЗЫВЫ</h1></html>", {
        headers: {
          "content-type": url.pathname.endsWith(".xml") ? "application/xml" : "text/html; charset=utf-8",
          "last-modified": "2026-08-23 08:00:07"
        }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const index = await callGateway("https://009.xn--p1ai/sitemap.xml");
    const shard = await callGateway("https://009.xn--p1ai/sitemap_7.xml");
    const family = await callGateway("https://009.xn--p1ai/kupit-lirika/otzyvy");
    expect(index.status).toBe(200);
    expect(shard.headers.get("x-ratings-source")).toBe("009-first-party-sitemap");
    expect(shard.headers.get("last-modified")).toBe("2026-08-23 08:00:07");
    expect(family.headers.get("x-ratings-source")).toBe("009-first-party-family-reviews");
    expect(await family.text()).toContain("ЛИРИКА ОТЗЫВЫ");

    for (const unsafe of [
      "https://009.xn--p1ai/sitemap_24.xml",
      "https://009.xn--p1ai/sitemap_00.xml",
      "https://009.xn--p1ai/kupit-lirika/analogs",
      "https://009.xn--p1ai/kupit-lirika/otzyvy?next=https://evil.example"
    ]) {
      expect((await callGateway(unsafe)).status).toBe(400);
    }
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("proxies only bounded exact Vapteke autocomplete and product routes", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("vapteke.ru");
      if (url.pathname === "/ajax/autocomplete") {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toBe(`query=${encodeURIComponent("Бивиарт")}`);
        return new Response('{"success":true,"data":{"total":{"value":0,"relation":"eq"},"hits":[]},"error":"200"}', {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("<html>product</html>", { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", upstream);
    const autocomplete = await staticReviewFetch(new Request(
      "https://ratings.example/api/internal/static-review-fetch",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://vapteke.ru/ajax/autocomplete",
          vaptekeAutocomplete: { query: "Бивиарт" }
        })
      }
    ), { INTERNAL_AGENT_TOKEN: token });
    expect(autocomplete.status).toBe(200);
    expect(autocomplete.headers.get("x-ratings-source")).toBe("vapteke-exact-autocomplete");

    await expect(callGateway("https://vapteke.ru/product/biviart-komfort-018-10-ml-682542"))
      .resolves.toMatchObject({ status: 200 });
    await expect(callGateway("https://vapteke.ru/search?q=Бивиарт"))
      .resolves.toMatchObject({ status: 400 });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("compacts an exact translated Yandex Market card without Sandbox", async () => {
    const source = "https://market.yandex.ru/card/mikroginon-tab-po/103544271955/reviews";
    const target = new URL("https://market-yandex-ru.translate.goog/card/mikroginon-tab-po/103544271955/reviews");
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    const noise = "x".repeat(500_000);
    const upstream = vi.fn(async () => new Response(`<html><head><base href="${source}"><style>${noise}</style></head><body>` +
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "?????????? ???????? ?/? 150???+30??? 21??",
        url: source,
        aggregateRating: {
          "@type": "AggregateRating",
          bestRating: 5,
          ratingValue: 5,
          ratingCount: 15,
          reviewCount: 1
        }
      })}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target.toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-yandex-market-compact");
    expect(response.headers.get("x-ratings-final-url")).toBe(source);
    expect(proof).toContain('"ratingCount":15');
    expect(proof).toContain('"reviewCount":1');
    expect(proof).not.toContain(noise.slice(0, 100));
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(2_000);

    target.searchParams.set("redirect", "https://evil.example");
    expect((await callGateway(target.toString())).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("compacts a source-bound translated Yandex Market search without Sandbox", async () => {
    const query = "Даксабрис";
    const source = `https://market.yandex.ru/search?text=${encodeURIComponent(query)}`;
    const target = new URL("https://market-yandex-ru.translate.goog/search");
    target.searchParams.set("text", query);
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    const itemList = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Даксабрис — купить по низкой цене на Яндекс Маркете",
      itemListElement: [{
        "@type": "ListItem",
        item: {
          "@type": "Product",
          name: "Даксабрис таблетки покрыт. плен. об. 20 мг 100 шт",
          url: "https://market.yandex.ru/card/daksabris-tabletki-20-mg-100-sht/103680334310",
          sku: "103680334310",
          aggregateRating: { ratingValue: 5, ratingCount: 2, bestRating: 5 }
        }
      }]
    };
    const upstream = vi.fn(async () => new Response(
      `<html><head><base href="${source}"></head><body>` +
      `<script type="application/ld+json">${JSON.stringify(itemList)}</script>` +
      `<a href="https://market-yandex-ru.translate.goog/search?text=${encodeURIComponent(query)}&page=2&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en">next</a>` +
      `</body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target.toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-yandex-market-compact");
    expect(response.headers.get("x-ratings-final-url")).toBe(source);
    expect(proof).toContain("103680334310");
    expect(proof).toContain('ratingCount":2');
    expect(proof).toContain("page=2");
    expect(proof).not.toContain("_x_tr_sl");

    target.searchParams.set("redirect", "https://evil.example");
    expect((await callGateway(target.toString())).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("proves an exact zero-rating Yandex Market card from its explicit empty state", async () => {
    const source = "https://market.yandex.ru/card/tikalizis-tabletki-po-plen-60mg-60sht/5052501058/reviews";
    const target = new URL("https://market-yandex-ru.translate.goog/card/tikalizis-tabletki-po-plen-60mg-60sht/5052501058/reviews");
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    const upstream = vi.fn(async () => new Response(
      `<html><head><base href="${source}"></head><body>` +
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Тикализис таблетки п/о плен. 60мг 60шт",
        url: source
      })}</script>` +
      `<script>window.__STATE__={"pageTitle":"Нет отзывов и оценок","skuId":"5052501058"}</script>` +
      `</body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    ));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target.toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(proof).toContain('"ratingCount":0');
    expect(proof).toContain('"reviewCount":0');
    expect(proof).toContain('"ratingValue":0');
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("proxies only exact Ozon composer search or product paths", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("www.ozon.ru");
      expect(url.searchParams.get("url")).toBe("/product/baktoblis-sashe-123456789/");
      return new Response('{"widgetStates":{}}', { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);
    const product = new URL("https://www.ozon.ru/api/composer-api.bx/page/json/v2");
    product.searchParams.set("url", "/product/baktoblis-sashe-123456789/");

    await expect(callGateway(product.toString())).resolves.toMatchObject({ status: 200 });

    const unsafe = new URL("https://www.ozon.ru/api/composer-api.bx/page/json/v2");
    unsafe.searchParams.set("url", "https://metadata.google.internal/latest/meta-data/");
    await expect(callGateway(unsafe.toString())).resolves.toMatchObject({ status: 400 });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("follows only Ozon's exact brand-category redirect for Google composer search JSON", async () => {
    const sourcePath = "/search/?text=Baktoblis&from_global=true&page=2";
    const target = new URL("https://www-ozon-ru.translate.goog/api/composer-api.bx/page/json/v2");
    target.searchParams.set("url", sourcePath);
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    const categorySource = "/category/bady-6183/baktoblis-100260712/?brand_was_predicted=true&category_was_predicted=true&deny_category_prediction=true&from_global=true&page=2&text=Baktoblis";
    const redirect = new URL(target.origin + target.pathname);
    redirect.searchParams.set("page_changed", "true");
    redirect.searchParams.set("url", categorySource);
    redirect.searchParams.set("_x_tr_sl", "ru");
    redirect.searchParams.set("_x_tr_tl", "en");
    redirect.searchParams.set("_x_tr_hl", "en");
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.toString() === target.toString()) {
        return new Response(null, { status: 302, headers: { location: redirect.toString() } });
      }
      expect(url.toString()).toBe(redirect.toString());
      return new Response('{"widgetStates":{}}', { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ozon-composer");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("follows only the exact Yandex Translate redirect for Ozon composer JSON", async () => {
    const sourcePath = "/search/?text=Baktoblis&from_global=true";
    const composer = new URL("https://www.ozon.ru/api/composer-api.bx/page/json/v2");
    composer.searchParams.set("url", sourcePath);
    const target = new URL("https://translate.yandex.ru/translate");
    target.searchParams.set("url", composer.toString());
    target.searchParams.set("lang", "ru-en");
    const redirect = new URL("https://translated.turbopages.org/proxy_u/signed-1/https/www.ozon.ru/api/composer-api.bx/page/json/v2");
    redirect.searchParams.set("url", sourcePath);
    const categorySource = "/category/bady-6183/baktoblis-100260712/?category_was_predicted=true&deny_category_prediction=true&from_global=true&text=Baktoblis";
    const categoryRedirect = new URL(redirect.origin + redirect.pathname);
    categoryRedirect.searchParams.set("page_changed", "true");
    categoryRedirect.searchParams.set("url", categorySource);
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "translate.yandex.ru") {
        return new Response(null, { status: 302, headers: { location: redirect.toString() } });
      }
      if (url.toString() === redirect.toString()) {
        return new Response(null, { status: 307, headers: { location: categoryRedirect.toString() } });
      }
      expect(url.toString()).toBe(categoryRedirect.toString());
      return new Response('{"widgetStates":{}}', { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(target.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("yandex-translate-ozon-composer");
    expect(upstream).toHaveBeenCalledTimes(3);

    const unsafeComposer = new URL(composer);
    unsafeComposer.searchParams.set("url", "https://metadata.google.internal/latest/meta-data/");
    const unsafe = new URL(target);
    unsafe.searchParams.set("url", unsafeComposer.toString());
    expect((await callGateway(unsafe.toString())).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("uses a bounded exact-site index query for med-otzyv discovery", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("html.duckduckgo.com");
      expect(url.searchParams.get("q")).toBe('site:med-otzyv.ru/lekarstva/ "Оциллококцинум"');
      return new Response('<a class="result__a" href="https://med-otzyv.ru/lekarstva/157-o/34740-otsillokoktsinum">Оциллококцинум - 42 отзыва врачей и пациентов</a>');
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(`https://med-otzyv.ru/__external_search__?brand=${encodeURIComponent("Оциллококцинум")}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("duckduckgo-exact-med-otzyv-index");
    expect(await response.text()).toContain("34740-otsillokoktsinum");
  });

  it("recovers an exact med-otzyv result through fixed translated DuckDuckGo egress", async () => {
    const brand = "Хондрофен";
    const product = "https://med-otzyv.ru/lekarstva/143-kh/751-khondrofen";
    const query = `site:med-otzyv.ru/lekarstva/ "${brand}"`;
    const source = new URL("https://html.duckduckgo.com/html/");
    source.searchParams.set("q", query);
    const redirect = new URL("https://duckduckgo.com/l/");
    redirect.searchParams.set("uddg", product);
    const translatedLink = new URL("https://translate.google.com/website");
    translatedLink.searchParams.set("sl", "auto");
    translatedLink.searchParams.set("tl", "ru");
    translatedLink.searchParams.set("hl", "ru");
    translatedLink.searchParams.set("u", redirect.toString());
    const requested: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname === "html.duckduckgo.com") {
        return new Response('<div class="anomaly-modal">challenge</div>', { status: 202 });
      }
      expect(url.hostname).toBe("html-duckduckgo-com.translate.goog");
      expect(url.searchParams.get("q")).toBe(query);
      return new Response(`<!doctype html><html><head><base href="${source.toString()}"></head><body>
        <a class="result__a" href="${translatedLink.toString().replace(/&/g, "&amp;")}">
          Хондрофен - 4 отзыва врачей и пациентов
        </a></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }));

    const response = await callGateway(`https://med-otzyv.ru/__external_search__?brand=${encodeURIComponent(brand)}`);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-duckduckgo-med-otzyv");
    expect(proof).toContain(`href="${product}"`);
    expect(proof).toContain("Хондрофен - 4 отзыва врачей и пациентов");
    expect(proof).not.toContain("translate.google.com");
    expect(requested).toHaveLength(2);
  });

  it("fails closed when translated med-otzyv discovery is not bound to the requested brand", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "html.duckduckgo.com") return new Response("challenge", { status: 202 });
      return new Response(`<!doctype html><html><head><base href="https://html.duckduckgo.com/html/?q=wrong"></head>
        <body><a class="result__a" href="https://med-otzyv.ru/lekarstva/143-a/47087-anvifen">
          Анвифен - 12 отзывов врачей и пациентов
        </a></body></html>`);
    }));

    const response = await callGateway(`https://med-otzyv.ru/__external_search__?brand=${encodeURIComponent("Хондрофен")}`);

    expect(response.status).toBe(502);
  });

  it("allows only fixed Megamarket translated search/product routes", async () => {
    const source = "https://megamarket.ru/catalog/?q=Оциллококцинум";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>proof</body></html>`, {
      headers: { "content-type": "text/html" }
    })));
    const allowed = await callGateway("https://megamarket-ru.translate.goog/catalog/?q=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en");
    expect(allowed.status).toBe(200);

    const escaped = await callGateway("https://megamarket-ru.translate.goog/personal/orders/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en");
    expect(escaped.status).toBe(400);
  });

  it("compacts large Megamarket pages into exact source-bound search and aggregate proofs", async () => {
    const searchSource = "https://megamarket.ru/catalog/?q=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC";
    const productSource = "https://megamarket.ru/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619/";
    const padding = "irrelevant-storefront-state".repeat(30_000);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const target = new URL(String(input));
      if (target.pathname === "/catalog/") return new Response(`<!doctype html><html><head><base href="${searchSource}"></head><body>
        <div data-test="product-item" data-product-id="100024501619_68334"><a data-test="product-name-link"
          title="ะัะธะปะปะพะบะพะบัะธะฝัะผ ะณั€ะฐะฝัะปั 1 ะณ 12 ัั."
          href="/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619_68334/">product</a></div>
        <div data-test="product-item" data-product-id="100024501619_999"><a data-test="product-name-link"
          title="ะัะธะปะปะพะบะพะบัะธะฝัะผ ะณั€ะฐะฝัะปั 1 ะณ 12 ัั."
          href="/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619_999/">seller duplicate</a></div>
        <button class="pui-pagination-control">1</button>${padding}</body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
      return new Response(`<!doctype html><html><head><base href="${productSource}"></head><body>
        <main itemscope itemtype="http://schema.org/Product"><meta itemprop="sku" content="100024501619">
          <h1 itemprop="name">ะัะธะปะปะพะบะพะบัะธะฝัะผ ะณั€ะฐะฝัะปั 1 ะณ 12 ัั.</h1></main>
        <script>window.__APP__={state:{ProductStore:{"reviewInfo":{"reviewsCount":25,"mainReviews":[{"comment":"remove-me"}],"rating":4.8}}}}</script>
        ${padding}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }));

    const search = await callGateway(`https://megamarket-ru.translate.goog/catalog/?q=${encodeURIComponent("Оциллококцинум")}&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`);
    const searchProof = await search.text();
    expect(search.status).toBe(200);
    expect(search.headers.get("x-ratings-source")).toBe("google-translate-megamarket-compact");
    expect(searchProof.match(/data-product-id=/g)).toHaveLength(1);
    expect(searchProof).toContain("100024501619");
    expect(searchProof).not.toContain("irrelevant-storefront-state");
    expect(searchProof.length).toBeLessThan(10_000);

    const product = await callGateway("https://megamarket-ru.translate.goog/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619/?_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en");
    const productProof = await product.text();
    expect(product.status).toBe(200);
    expect(productProof).toContain('<meta itemprop="sku" content="100024501619">');
    expect(productProof).toContain('"reviewsCount":25');
    expect(productProof).toContain('"rating":4.8');
    expect(productProof).not.toContain("remove-me");
    expect(productProof).not.toContain("irrelevant-storefront-state");
    expect(productProof.length).toBeLessThan(10_000);
  });

  it("rejects a Megamarket gateway page whose base source does not match the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<!doctype html><html><head><base href="https://megamarket.ru/catalog/?q=other"></head><body></body></html>',
      { headers: { "content-type": "text/html" } }
    )));
    const response = await callGateway("https://megamarket-ru.translate.goog/catalog/?q=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en");
    expect(response.status).toBe(502);
  });
});

describe("static iRecommend gateway", () => {
  const token = "i".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );
  const captcha = `<html><head><title>Irecommend</title><script src="/captcha-checker/assets/script.js"></script></head>` +
    `<body class="in-maintenance db-offline"><div id="captcha-container"></div></body></html>`;
  const provedSearch = `<html><body><h1>Кагоцел</h1><ul class="srch-result-nodes"><li>` +
    `<div class="ProductTizer" data-type="2" data-nid="135637">` +
    `<div class="title"><a href="/content/protivovirusnye-sredstva-kagotsel">Противовирусные средства Кагоцел</a></div>` +
    `<a class="read-all-reviews-link"><span class="counter">430</span></a>` +
    `<div class="fivestar-summary"><span class="average-rating">Среднее: <span>3.9</span></span></div>` +
    `<a class="reviewsLink">430 отзывов</a></div></li></ul></body></html>`;

  it("tries the exact first-party page before a cached reader and preserves written-review proof", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.hostname === "irecommend.ru") return new Response(captcha, {
        status: 521, headers: { "content-type": "text/html; charset=utf-8" }
      });
      expect(url.hostname).toBe("r.jina.ai");
      const headers = new Headers(init?.headers);
      expect(headers.has("x-no-cache")).toBe(false);
      expect(headers.get("x-return-format")).toBe("markdown");
      return new Response(provedSearch, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://irecommend.ru/srch?query=Кагоцел");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("reader-fallback");
    expect(await response.text()).toContain("430 отзывов");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("compacts a verified Otsillokoktsinum reader search when first-party access is blocked", async () => {
    const product = "https://irecommend.ru/content/protivoprostudnyi-gomeopaticheskii-preparat-laboratoriya-buaron-otsillokoktsinum";
    const search = "https://irecommend.ru/srch?query=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC";
    const reader = `Title: Оциллококцинум | отзывы\n\nURL Source: ${search}\n\nMarkdown Content:\n` +
      `* [Гомеопатия Лаборатория БУАРОН Оциллококцинум](${product}) ` +
      `[Читать все отзывы 258](${product})\n\nСреднее:\n\n Среднее: 3.7(258 голосов)\n` +
      `[258 отзывов](${product})\n\n` +
      `[![Image 1](https://cdn-irec.r-99.com/sites/default/files/imagecache/150o/product-images/2473/oscillococcinum.jpg)](${product})`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      return url.hostname === "irecommend.ru"
        ? new Response(captcha, { status: 521, headers: { "content-type": "text/html" } })
        : new Response(reader, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }));

    const response = await callGateway(search);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("irecommend-reader-compact");
    expect(proof).toContain('data-nid="2473"');
    expect(proof).toContain("258 отзывов");
    expect(proof).toContain("3.7");
  });

  it("recovers a source-bound Otsillokoktsinum search and product from the inert new view", async () => {
    const product = "https://irecommend.ru/content/protivoprostudnyi-gomeopaticheskii-preparat-laboratoriya-buaron-otsillokoktsinum";
    const search = "https://irecommend.ru/srch?query=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC";
    const blockedReader = `Title: Irecommend\n\nURL Source: ${search}\n\nMarkdown Content:\nCAPTCHA`;
    const searchProof = (source: string) => `Title: Оциллококцинум | отзывы\n\nURL Source: ${source}\n\nMarkdown Content:\n` +
      `[Гомеопатия Лаборатория БУАРОН Оциллококцинум](${product}) [Читать все отзывы 258](${product})\n` +
      `Среднее: 3.7(258 голосов)\n[258 отзывов](${product})\n` +
      `![Фото](https://cdn-irec.r-99.com/sites/default/files/product-images/2473/item.jpg)`;
    const productProof = (source: string) => `Title: Гомеопатия Лаборатория БУАРОН Оциллококцинум | отзывы\n\nURL Source: ${source}\n\nMarkdown Content:\n` +
      `## Гомеопатия Лаборатория БУАРОН Оциллококцинум — отзывы\n` +
      `[Среднее: Среднее: 3.7(258 голосов)](${product})`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname === "irecommend.ru") return new Response(captcha, { status: 521, headers: { "content-type": "text/html" } });
      const source = new URL(url.pathname.slice(1) + url.search);
      if (source.searchParams.get("new") !== "1") return new Response(blockedReader, { headers: { "content-type": "text/plain" } });
      return new Response(source.pathname === "/srch" ? searchProof(source.toString()) : productProof(source.toString()), {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }));

    const searchResponse = await callGateway(search);
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.headers.get("x-ratings-source")).toBe("irecommend-reader-refreshed");
    expect(await searchResponse.text()).toContain('data-nid="2473"');

    const productResponse = await callGateway(product);
    expect(productResponse.status).toBe(200);
    expect(productResponse.headers.get("x-ratings-source")).toBe("irecommend-reader-refreshed");
    expect(await productResponse.text()).toContain("258 голосов");
  });

  it("rejects reader search metrics when the written counters disagree", async () => {
    const product = "https://irecommend.ru/content/protivoprostudnyi-gomeopaticheskii-preparat-laboratoriya-buaron-otsillokoktsinum";
    const search = "https://irecommend.ru/srch?query=Оциллококцинум";
    const reader = `URL Source: ${search}\n` +
      `[Гомеопатия БУАРОН Оциллококцинум](${product}) [Читать все отзывы 258](${product})\n` +
      `Среднее: 3.7(258 голосов)\n[257 отзывов](${product})\n` +
      `![Фото](https://cdn-irec.r-99.com/sites/default/files/product-images/2473/item.jpg)`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      return url.hostname === "irecommend.ru"
        ? new Response(captcha, { status: 521, headers: { "content-type": "text/html" } })
        : new Response(reader, { headers: { "content-type": "text/plain" } });
    }));

    const response = await callGateway(search);
    expect(response.status).toBe(502);
  });

  it("rejects a successful CAPTCHA response instead of exposing it as product evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(captcha, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })));

    const response = await callGateway("https://irecommend.ru/content/protivovirusnye-sredstva-kagotsel");

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("did not prove");
  });

  it("accepts reader rating proof for the exact product without treating votes as written reviews", async () => {
    const source = "https://irecommend.ru/content/protivovirusnye-sredstva-kagotsel";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname === "irecommend.ru") return new Response(captcha, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
      return new Response(`Title: Противовирусные средства Кагоцел | отзывы\n` +
        `[Среднее: Среднее: 3.9 (430 голосов)](${source})`, {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(source);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(proof).toContain("430 голосов");
    expect(proof).not.toContain("430 отзывов");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe("static Vseotzyvy reader gateway", () => {
  const token = "x".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );

  it("compacts a complete exact search and product aggregate from the source-bound reader", async () => {
    const search = "https://vseotzyvy.ru/search?q=%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB";
    const product = "https://vseotzyvy.ru/otzyvy/kagotsel-49555";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/search?")) return new Response(`Title: Поиск: Кагоцел

URL Source: ${search}

Markdown Content:
# Поиск
Найдено 2 результата
[Image 1: Кагоцел](https://vseotzyvy.ru/otzyvy/kagotsel-49555)
[Кагоцел](https://vseotzyvy.ru/otzyvy/kagotsel-49555)
[Другой товар](https://vseotzyvy.ru/otzyvy/drugoy-tovar-70001)`);
      return new Response(`Title: Отзывы на Кагоцел

URL Source: ${product}

Markdown Content:
## Кагоцел отзывы
5.0 · 72 оценки 72 отзыва 99% рекомендуют
## Отзывы покупателей о Кагоцел (72 отзыва)`);
    });
    vi.stubGlobal("fetch", upstream);

    const searchResponse = await callGateway(search);
    const searchProof = await searchResponse.text();
    const productResponse = await callGateway(product);
    const productProof = await productResponse.text();

    expect(searchResponse.status).toBe(200);
    expect(searchResponse.headers.get("x-ratings-source")).toBe("vseotzyvy-reader-compact");
    expect(searchProof).toContain('name="q" value="Кагоцел"');
    expect(searchProof.match(/<article>/g)).toHaveLength(2);
    expect(productResponse.status).toBe(200);
    expect(productProof).toContain('<link rel="canonical" href="https://vseotzyvy.ru/otzyvy/kagotsel-49555">');
    expect(productProof).toContain("Отзывы покупателей о Кагоцел (72 отзывов)");
    expect(productProof).toContain("Оценка 5 из 5");
  });

  it("accepts Ozon's exact category-only prediction redirect without a brand flag", async () => {
    const sourcePath = "/search/?text=%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0&from_global=true";
    const target = new URL("https://www-ozon-ru.translate.goog/api/composer-api.bx/page/json/v2");
    target.searchParams.set("url", sourcePath);
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    const categorySource = "/category/kontraceptivy-6168/?category_was_predicted=true&deny_category_prediction=true&from_global=true&text=" +
      encodeURIComponent("Хлорэтта");
    const redirect = new URL(target.origin + target.pathname);
    redirect.searchParams.set("page_changed", "true");
    redirect.searchParams.set("url", categorySource);
    redirect.searchParams.set("_x_tr_sl", "ru");
    redirect.searchParams.set("_x_tr_tl", "en");
    redirect.searchParams.set("_x_tr_hl", "en");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).toString() === target.toString()
        ? new Response(null, { status: 302, headers: { location: redirect.toString() } })
        : new Response('{"widgetStates":{}}', { headers: { "content-type": "application/json" } })
    ));

    const response = await callGateway(target.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ozon-composer");
  });

  it("preserves a source-bound Megamarket visible no-results proof while compacting", async () => {
    const source = "https://megamarket.ru/catalog/?q=%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<!doctype html><html><head><base href="${source}"><title>Results for the query Chloretta</title></head>` +
      `<body><main><article class="listing-not-found-block"><p>Мы это не нашли</p><p>Попробуйте написать по-другому или поищите в каталоге</p></article></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )));

    const response = await callGateway(`https://megamarket-ru.translate.goog/catalog/?q=${encodeURIComponent("Хлорэтта")}&_x_tr_sl=ru&_x_tr_tl=en&_x_tr_hl=en`);
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-megamarket-compact");
    expect(proof).toContain('<p data-ratings-empty="search">No products found</p>');
    expect(proof).toContain(`<base href="${source}">`);
  });

  it("fails closed when the reader source or declared result set is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`Title: Поиск: Кагоцел

URL Source: https://vseotzyvy.ru/search?q=Другой

Markdown Content:
Найдено 2 результата
[Кагоцел](https://vseotzyvy.ru/otzyvy/kagotsel-49555)`)));

    const response = await callGateway("https://vseotzyvy.ru/search?q=%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB");

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("did not prove the exact source");
  });
});

describe("static Otzovik product gateway", () => {
  const token = "x".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );

  it("accepts only a translated Product/AggregateRating bound to the exact Otzovik source", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString())).toMatchObject({
        hostname: "otzovik-com.translate.goog",
        pathname: "/reviews/protivovirusniy_preparat_kagocel/"
      });
      return new Response(`
        <base href="https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/">
        <link href="https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/" rel="canonical">
        <div itemscope itemtype="http://schema.org/Product">
          <span itemprop="aggregateRating" itemscope itemtype="http://schema.org/AggregateRating">
            <meta itemprop="ratingValue" content="3.91"><meta itemprop="reviewCount" content="578">
          </span>
        </div>
      `);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ssr");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("retries an incomplete translated product through the exact no-cache SSR variant", async () => {
    const source = "https://otzovik.com/reviews/tabletki_arbidol_otc_pharm/";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (!url.searchParams.has("_x_tr_pto")) {
        return new Response(`<html><head><base href="${source}"></head><body>temporary incomplete shell</body></html>`);
      }
      expect(url.searchParams.get("_x_tr_pto")).toBe("wapp");
      return new Response(`<html><head><base href="${source}"></head><body>
        <main itemscope itemtype="http://schema.org/Product"><link itemprop="url" href="${source}">
        <div itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.97">
        <meta itemprop="reviewCount" content="34"></div></main></body></html>`);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(source);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ssr-fallback");
    expect(await response.text()).toContain('itemprop="reviewCount" content="34"');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("recovers the exact translated aggregate from reader HTML after both regional SSR variants are incomplete", async () => {
    const source = "https://otzovik.com/reviews/tabletki_arbidol_otc_pharm/";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "r.jina.ai") {
        return new Response(`<html><head><base href="${source}"></head><body>regional shell</body></html>`);
      }
      expect(url.pathname).toContain("otzovik-com.translate.goog/reviews/tabletki_arbidol_otc_pharm/");
      return new Response(`<html><head><base href="${source}"></head><body>
        <main itemscope itemtype="http://schema.org/Product"><link itemprop="url" href="${source}">
        <div itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.97">
        <meta itemprop="reviewCount" content="34"></div></main></body></html>`);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(source);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("otzovik-translated-reader-html");
    expect(await response.text()).toContain('itemprop="reviewCount" content="34"');
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("accepts an exact Otzovik Product URL when the translated page omits canonical", async () => {
    const source = "https://otzovik.com/reviews/tabletki_arbidol_otc_pharm/";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <html><head><base href="${source}"></head><body>
      <main itemscope itemtype="https://schema.org/Product">
        <link itemprop="url" href="${source}"><h1 itemprop="name">Таблетки Арбидол</h1>
        <div itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.8">
        <meta itemprop="reviewCount" content="34"></div>
      </main></body></html>
    `)));

    const response = await callGateway(source);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('itemprop="reviewCount" content="34"');
  });

  it("rejects a translated page whose canonical source or aggregate is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <base href="https://otzovik.com/reviews/another_product/">
      <link rel="canonical" href="https://otzovik.com/reviews/another_product/">
      <article itemprop="review"><meta itemprop="ratingValue" content="5"></article>
    `)));

    const response = await callGateway("https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/");

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("did not prove the requested product aggregate");
  });

  it("canonicalizes a www Otzovik product URL before source-bound collection", async () => {
    const path = "/reviews/kapsuli_soteks_cereton/";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <html><head><base href="https://otzovik.com${path}">
      <link rel="canonical" href="https://otzovik.com${path}"></head><body>
      <main itemscope itemtype="https://schema.org/Product"><h1>Капсулы Сотекс Церетон</h1>
      <div itemprop="aggregateRating"><meta itemprop="ratingValue" content="4.5">
      <meta itemprop="reviewCount" content="72"></div></main></body></html>`)));

    const response = await callGateway(`https://www.otzovik.com${path}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('itemprop="reviewCount" content="72"');
  });

  it("discovers exact Otzovik products from the source-bound first-party search", async () => {
    const brand = "Оциллококцинум";
    const source = `https://otzovik.com/?search_text=${encodeURIComponent(brand)}`;
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url).toMatchObject({ hostname: "otzovik-com.translate.goog", pathname: "/" });
      expect(url.searchParams.get("search_text")).toBe(brand);
      return new Response(`<!doctype html><html><head><base href="${source}"><link rel="canonical" href="${source}"></head><body>
        <div class="product-counter">3</div><div class="product-list">
          <div class="item sortable" data-pid="4948" data-reviews="394" data-rating="401394">
            <span class="rating-score-2">4.01</span>
            <h3><a class="product-name" href="https://otzovik-com.translate.goog/reviews/gomeopaticheskoe_sredstvo_ot_grippa_i_prostudnih_zabolevaniy_buaron_ocillokokcinum/?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Гомеопатический препарат Буарон "Оциллококцинум"</a></h3>
          </div>
          <div class="item sortable" data-pid="2620333" data-reviews="1" data-rating="50001">
            <span class="rating-score-2">5</span>
            <h3><a class="product-name" href="https://otzovik.com/reviews/gomeopaticheskiy_preparat_boiron_ocillokokcinum_zaschita_ot_virusov/">Гомеопатический препарат Boiron "Оциллококцинум защита от вирусов"</a></h3>
          </div>
          <div class="item sortable" data-pid="999" data-reviews="7" data-rating="40007">
            <h3><a class="product-name" href="https://otzovik.com/reviews/drug_analogue/">Другой препарат</a></h3>
          </div>
        </div></body></html>`);
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(`https://otzovik.com/__external_search__?brand=${encodeURIComponent(brand)}`);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-otzovik-search");
    expect(proof.match(/class="result__a"/g)).toHaveLength(2);
    expect(proof).toContain("https://otzovik.com/reviews/gomeopaticheskoe_sredstvo_ot_grippa_i_prostudnih_zabolevaniy_buaron_ocillokokcinum/");
    expect(proof).toContain("https://otzovik.com/reviews/gomeopaticheskiy_preparat_boiron_ocillokokcinum_zaschita_ot_virusov/");
    expect(proof).not.toContain("drug_analogue");
    expect(proof).toContain('data-review-count="394" data-rating="4.01"');
    expect(proof).toContain('data-review-count="1" data-rating="5"');
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("recovers a split first-party product link without executing page scripts", async () => {
    const brand = "Тикализис";
    const source = `https://otzovik.com/?search_text=${encodeURIComponent(brand)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<!doctype html><html><head>
      <base href="${source}"><link rel="canonical" href="${source}"></head><body>
      <div class="product-counter">1</div><div class="product-list">
        <div class="item sortable" data-pid="2733023" data-reviews="1" data-rating="50001"><h3 class="text"><script>
          document.write("<a hr"+"ef='/rev");
          document.write("iews/tabletki_r-farm_tikalizis/' rel='nofollow' class='product-name'>Таблетки Р-Фарм \\"Тикализис\\"</a>");
        </script></h3></div>
      </div></body></html>`)));

    const response = await callGateway(`https://otzovik.com/__external_search__?brand=${encodeURIComponent(brand)}`);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(proof).toContain("https://otzovik.com/reviews/tabletki_r-farm_tikalizis/");
    expect(proof).toContain("Тикализис");
    expect(proof).not.toContain("document.write");
  });

  it("fails closed when first-party Otzovik results do not match the requested brand", async () => {
    const brand = "Оциллококцинум";
    const source = `https://otzovik.com/?search_text=${encodeURIComponent(brand)}`;
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(`<!doctype html><html><head><base href="${source}"><link rel="canonical" href="${source}"></head><body>
        <div class="product-counter">1</div><div class="product-list"><div class="item sortable" data-pid="999" data-reviews="7" data-rating="40007">
        <h3><a class="product-name" href="https://otzovik.com/reviews/drug_analogue/">Другой препарат</a></h3></div></div></body></html>`))
      .mockResolvedValueOnce(new Response("reader unavailable", { status: 507 }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(`https://otzovik.com/__external_search__?brand=${encodeURIComponent(brand)}`);

    expect(response.status).toBe(507);
    expect(await response.text()).toBe("reader unavailable");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe("static ru.otzyv.com product gateway", () => {
  const token = "r".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );
  const translated = (source = "https://ru.otzyv.com/kagotsel", title = "Кагоцел отзывы") => `
    <html><head><base href="${source}"><script src="https://www.google.com/recaptcha/api.js"></script>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "http://schema.org",
      "@type": "Product",
      name: "Кагоцел",
      aggregateRating: {
        "@type": "AggregateRating", ratingValue: "5", reviewCount: "390", ratingCount: "390", bestRating: "5"
      },
      review: [{ "@type": "Review", reviewBody: "must not cross the internal boundary" }]
    })}</script></head><body><h1>${title}</h1></body></html>`;

  it("returns only a source-bound Product aggregate from the fixed translated route", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(input.toString())).toMatchObject({
        hostname: "ru-otzyv-com.translate.goog",
        pathname: "/kagotsel"
      });
      return new Response(translated(), { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://ru.otzyv.com/kagotsel");
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ru-otzyv-ssr");
    expect(proof).toContain('"reviewCount":"390"');
    expect(proof).not.toContain("must not cross the internal boundary");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("returns a compact explicit zero from the bounded ru.otzyv.com search route", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe("https://ru.otzyv.com/search/?q=%D0%A2%D0%B8%D1%80%D0%B7%D0%B5%D1%82%D1%82%D0%B0");
      return new Response(`<html><body><input name="q" value="Тирзетта">` +
        `<h1>Поиск отзывов для Тирзетта</h1><p>По вашему запросу найдено: 0 результатов.</p></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://ru.otzyv.com/search/?q=%D0%A2%D0%B8%D1%80%D0%B7%D0%B5%D1%82%D1%82%D0%B0");
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("direct-ru-otzyv-search");
    expect(proof).toContain("найдено: 0 результатов");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("falls back to the source-bound translated ru.otzyv.com search after a direct access block", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response(
        `<html><head><base href="https://ru.otzyv.com/search/?q=%D0%A2%D0%B8%D1%80%D0%B7%D0%B5%D1%82%D1%82%D0%B0"></head>` +
        `<body><input name="q" value="Тирзетта"><h1>Поиск отзывов для Тирзетта</h1>` +
        `<p>По вашему запросу найдено: 0 результатов.</p></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      ));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://ru.otzyv.com/search/?q=%D0%A2%D0%B8%D1%80%D0%B7%D0%B5%D1%82%D1%82%D0%B0");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ru-otzyv-search");
    expect(new URL(String(upstream.mock.calls[1]?.[0]))).toMatchObject({
      hostname: "ru-otzyv-com.translate.goog", pathname: "/search/"
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("rejects query parameters, source mismatches and protection pages fail-closed", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(translated("https://ru.otzyv.com/another-product"), {
        headers: { "content-type": "text/html; charset=utf-8" }
      }))
      .mockResolvedValueOnce(new Response(`<html><head><base href="https://ru.otzyv.com/kagotsel"></head>` +
        `<body><form class="captcha"><h1>Кагоцел отзывы</h1></form></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" }
      }));
    vi.stubGlobal("fetch", upstream);

    expect((await callGateway("https://ru.otzyv.com/kagotsel?next=https://evil.example")).status).toBe(400);
    expect((await callGateway("https://ru.otzyv.com/kagotsel")).status).toBe(502);
    expect((await callGateway("https://ru.otzyv.com/kagotsel")).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded ru.otzyv.com search parameters before egress", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    expect((await callGateway("https://ru.otzyv.com/search/?q=%D0%A2%D0%B8%D1%80%D0%B7%D0%B5%D1%82%D1%82%D0%B0&next=x")).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("static Ozon Translate gateway", () => {
  const token = "z".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );
  const sourceFromTarget = (target: URL) => {
    const source = new URL(target.toString());
    source.hostname = "www.ozon.ru";
    source.searchParams.delete("_x_tr_sl");
    source.searchParams.delete("_x_tr_tl");
    source.searchParams.delete("_x_tr_hl");
    return source;
  };
  const translatedTarget = (pathname: string, parameters: Record<string, string> = {}) => {
    const target = new URL(pathname, "https://www-ozon-ru.translate.goog");
    for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, value);
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    return target;
  };

  it("proxies only one exact Ozon product through the translated composer API", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const target = new URL(String(input));
      expect(target.hostname).toBe("www-ozon-ru.translate.goog");
      expect(target.pathname).toBe("/api/composer-api.bx/page/json/v2");
      expect(target.searchParams.get("url")).toBe("/product/baktoblis-sashe-123456789/");
      return new Response('{"widgetStates":{}}', { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);
    const exact = translatedTarget("/api/composer-api.bx/page/json/v2", {
      url: "/product/baktoblis-sashe-123456789/"
    });

    const response = await callGateway(exact.toString());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-ozon-composer");

    const unsafe = translatedTarget("/api/composer-api.bx/page/json/v2", {
      url: "https://metadata.google.internal/latest/meta-data/"
    });
    expect((await callGateway(unsafe.toString())).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("accepts only source-bound Ozon search, category and product HTML", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const target = new URL(input.toString());
      const source = sourceFromTarget(target);
      const base = source.toString().replaceAll("&", "&amp;");
      if (target.pathname.startsWith("/product/")) {
        return new Response(`<html><head><base href="${base}">
          <script type="application/ld+json">${JSON.stringify({
            "@type": "Product",
            sku: "1234567890",
            name: "Кагоцел таблетки 12 мг №20",
            aggregateRating: { ratingValue: "4.8", reviewCount: "711" }
          })}</script></head><body>
          <a href="https://www-ozon-ru.translate.goog/product/kagotsel-1234567891/?from_sku=1234567890&amp;oos_search=false&amp;_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">№30</a>
          <div id="state-webSingleProductScore-1" data-state='{"text":"4.8 • 711 отзывов"}'></div>
          <script>window.__NUXT__.state={}</script></body></html>`, {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      return new Response(`<html><head><base href="${base}"></head><body>
        <div data-widget="tileGridDesktop"><div class="tile-root">proved product tile</div></div>
        <script>window.__NUXT__.state={"catalog":{"totalPages":2}}</script></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    vi.stubGlobal("fetch", upstream);
    const search = translatedTarget("/search/", { text: "Кагоцел", from_global: "true" });
    const category = translatedTarget("/category/apteka-6000/", {
      text: "Кагоцел",
      from_global: "true",
      category_was_predicted: "true",
      deny_category_prediction: "true"
    });
    const product = translatedTarget("/product/kagotsel-1234567890/");

    for (const target of [search, category, product]) {
      const response = await callGateway(target.toString());
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratings-source")).toBe("google-translate-ozon-ssr");
      const proof = await response.text();
      expect(proof).toContain("window.__NUXT__.state=");
      if (target.pathname.startsWith("/product/")) {
        expect(proof).toContain('name="ratings-ozon-variant-skus" content="1234567890,1234567891"');
      }
      expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(10_000);
    }
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("compacts a storefront-sized Ozon response below the Agent transfer limit", async () => {
    const target = translatedTarget("/search/", { text: "Кагоцел", from_global: "true" });
    const source = sourceFromTarget(target).toString().replaceAll("&", "&amp;");
    const noise = "x".repeat(700_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <style>${noise}</style>
      <div data-widget="tileGridDesktop"><div class="tile-root">
        <a href="https://www-ozon-ru.translate.goog/product/kagotsel-1234567890/?_x_tr_sl=ru"><span>Кагоцел 12 мг №20</span></a>
        <div><svg style="color:var(--graphicRating)"></svg><span>4.8</span><span>711 отзывов</span></div>
      </div></div>
      <script>window.__NUXT__.state={"catalog":{"totalPages":1}}</script></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })));

    const response = await callGateway(target.toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(Number(response.headers.get("x-ratings-original-bytes"))).toBeGreaterThan(700_000);
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(5_000);
    expect(proof).toContain("Кагоцел 12 мг No20");
    expect(proof).not.toContain(noise.slice(0, 100));
  });

  it("accepts Ozon's bounded two-segment brand-prediction redirect", async () => {
    const target = translatedTarget("/search/", { text: "Арбидол", from_global: "true" });
    const redirect = "https://www.ozon.ru/category/lekarstvennye-sredstva-30000/arbidol-87397189/" +
      "?brand_was_predicted=true&category_was_predicted=true&deny_category_prediction=true&from_global=true&text=" +
      encodeURIComponent("Арбидол");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<html><script>location.replace(${JSON.stringify(redirect)})</script></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )));

    const response = await callGateway(target.toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(proof).toContain("brand_was_predicted=true");
    expect(proof.length).toBeLessThan(1_000);
  });

  it("rejects unbounded Ozon Translate queries before fetch and fails closed on wrong source HTML", async () => {
    const upstream = vi.fn(async () => new Response(`<html><head>
      <base href="https://www.ozon.ru/search/?text=Другой&amp;from_global=true"></head><body>
      <div data-widget="tileGridDesktop"><div class="tile-root"></div></div>
      <script>window.__NUXT__.state={"catalog":{"totalPages":1}}</script></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));
    vi.stubGlobal("fetch", upstream);
    const invalid = translatedTarget("/search/", { text: "Кагоцел", from_global: "true", redirect: "https://evil.example" });

    const rejected = await callGateway(invalid.toString());
    expect(rejected.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();

    const valid = translatedTarget("/search/", { text: "Кагоцел", from_global: "true" });
    const mismatched = await callGateway(valid.toString());
    expect(mismatched.status).toBe(502);
    expect(await mismatched.text()).toContain("did not prove the requested source");
  });
});

describe("static pharmacy Translate gateway", () => {
  const token = "p".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );
  const translated = (host: string, pathname: string, parameters: Record<string, string> = {}) => {
    const target = new URL(pathname, `https://${host}`);
    for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, value);
    target.searchParams.set("_x_tr_sl", "ru");
    target.searchParams.set("_x_tr_tl", "en");
    target.searchParams.set("_x_tr_hl", "en");
    return target;
  };

  it("accepts only Okapteka's exact brand-scoped empty-product proof", async () => {
    const source = "https://okapteka.ru/pg/%D0%A2%D0%B8%D0%BA%D0%B0%D0%BB%D0%B8%D0%B7%D0%B8%D1%81/";
    const target = translated("okapteka-ru.translate.goog", "/pg/%D0%A2%D0%B8%D0%BA%D0%B0%D0%BB%D0%B8%D0%B7%D0%B8%D1%81/");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<html><head><base href="${source}"></head><body><main>Не найдено ни одного товара.</main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )));

    const exact = await callGateway(target.toString());
    expect(exact.status).toBe(200);
    expect(await exact.text()).toContain("Не найдено ни одного товара");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<html><head><base href="${source}"></head><body><main>Товары временно не показаны.</main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    )));
    const ambiguous = await callGateway(target.toString());
    expect(ambiguous.status).toBe(502);
    expect(await ambiguous.text()).toContain("did not prove the requested source and metrics");
  });

  it("accepts a translated Okapteka 404 only after the exact first-party group also returns 404", async () => {
    const target = translated("okapteka-ru.translate.goog", "/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/");
    const source = "https://okapteka.ru/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(url.hostname === "okapteka.ru" ? exactOkaptekaMissingPage(source) : "translated missing", {
        status: 404
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const proven = await callGateway(target.toString());
    expect(proven.status).toBe(200);
    expect(proven.headers.get("x-ratings-source")).toBe("okapteka-first-party-missing");
    expect(await proven.text()).toContain('data-ratings-empty="first-party-404"');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(url.hostname === "okapteka.ru" ? "access blocked" : "translated missing", {
        status: url.hostname === "okapteka.ru" ? 503 : 404
      });
    }));
    const unproven = await callGateway(target.toString());
    expect(unproven.status).toBe(404);
  });

  it("recovers an exact Okapteka group 404 after translated transport fails", async () => {
    const target = translated("okapteka-ru.translate.goog", "/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/");
    const source = "https://okapteka.ru/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "okapteka-ru.translate.goog") throw new TypeError("translated egress failed");
      return new Response(exactOkaptekaMissingPage(source), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recovered = await callGateway(target.toString());

    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-ratings-source")).toBe("okapteka-first-party-missing");
    expect(await recovered.text()).toContain('data-ratings-empty="first-party-404"');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "okapteka-ru.translate.goog") throw new TypeError("translated egress failed");
      return new Response("source unavailable", { status: 503 });
    }));
    expect((await callGateway(target.toString())).status).toBe(502);
  });

  it("source-binds a healthy exact Okapteka group after translated transport or transient status fails", async () => {
    const target = translated("okapteka-ru.translate.goog", "/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/");
    const source = "https://okapteka.ru/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/";
    for (const translatedOutcome of ["throw", "502"] as const) {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === "okapteka-ru.translate.goog") {
          if (translatedOutcome === "throw") throw new TypeError("translated egress failed");
          return new Response("translated unavailable", { status: 502 });
        }
        return new Response(exactOkaptekaGroupPage(source), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }));

      const recovered = await callGateway(target.toString());

      expect(recovered.status).toBe(200);
      expect(recovered.headers.get("x-ratings-source")).toBe("okapteka-first-party-ssr");
      expect(await recovered.text()).toContain(`<base href="${source}">`);
    }
  });

  it.each([
    ["challenge", exactOkaptekaGroupPage(
      "https://okapteka.ru/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/",
      { challenge: true }
    )],
    ["wrong canonical", exactOkaptekaGroupPage(
      "https://okapteka.ru/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/",
      { canonical: "https://okapteka.ru/pg/drugoy-brand/" }
    )]
  ])("keeps a first-party Okapteka %s response blocked", async (_case, firstPartyHtml) => {
    const target = translated("okapteka-ru.translate.goog", "/pg/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "okapteka-ru.translate.goog") throw new TypeError("translated egress failed");
      return new Response(firstPartyHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }));

    const blocked = await callGateway(target.toString());

    expect(blocked.status).toBe(502);
    expect(blocked.headers.get("x-ratings-source")).toBeNull();
  });

  it("keeps an Okapteka CAPTCHA 404 blocked instead of synthesizing an empty brand", async () => {
    const target = translated("okapteka-ru.translate.goog", "/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/");
    const source = "https://okapteka.ru/pg/%D0%A5%D0%BB%D0%BE%D1%80%D1%8D%D1%82%D1%82%D0%B0/";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(url.hostname === "okapteka.ru"
        ? exactOkaptekaMissingPage(source, true)
        : "translated missing", { status: 404 });
    }));

    const blocked = await callGateway(target.toString());

    expect(blocked.status).toBe(404);
    expect(blocked.headers.get("x-ratings-source")).toBeNull();
    expect(await blocked.text()).not.toContain("data-ratings-empty");
  });

  it("accepts and compacts source-bound Farmlend product metrics", async () => {
    const noise = "x".repeat(500_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head>
      <base href="https://farmlend.ru/product/370202">
      <link rel="canonical" href="https://farmlend.ru/product/370202">
      <style>${noise}</style></head><body><h1>Кагоцел таблетки 12 мг №30</h1>
      <p>Общий рейтинг 5 на основе 17 отзывов покупателей</p></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })));

    const response = await callGateway(translated("farmlend-ru.translate.goog", "/product/370202").toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-pharmacy-ssr");
    expect(proof).toContain("17 отзывов покупателей");
    expect(proof).not.toContain(noise.slice(0, 100));
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(2_000);
  });

  it("preserves Okapteka written reviews with per-review ratings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head>
      <base href="https://okapteka.ru/reviews/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/"></head><body>
      <article itemprop="review" data-id="2678"><a href="https://okapteka-ru.translate.goog/kagotsyel-tab-12mg-20-529012/?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Кагоцел</a>
      <meta itemprop="ratingValue" content="5"></article></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })));
    const target = translated("okapteka-ru.translate.goog", "/reviews/%D0%9A%D0%B0%D0%B3%D0%BE%D1%86%D0%B5%D0%BB/");

    const response = await callGateway(target.toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(proof).toContain('data-id="2678"');
    expect(proof).toContain('itemprop="ratingValue" content="5"');
    expect(proof).toContain("529012");
  });

  it("accepts only an exact ASNA card and returns compact source-bound aggregate proof", async () => {
    const source = "https://www.asna.ru/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html";
    const noise = "x".repeat(500_000);
    const upstream = vi.fn(async () => new Response(`<html><head><base href="${source}">
      <link rel="canonical" href="${source}"><style>${noise}</style></head><body>
      <div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">
        <meta itemprop="sku" content="14666"><div itemprop="aggregateRating" itemscope>
          <meta itemprop="ratingValue" content="5"><meta itemprop="reviewCount" content="29">
        </div><div class="product__ratingText">Отзывы (29)</div>
        <div id="feedbackListContainer" class="product__feedbackList">
          <article class="product__feedbackItem" itemscope itemtype="https://schema.org/Review"></article>
        </div></div></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(translated("www-asna-ru.translate.goog", new URL(source).pathname).toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-pharmacy-ssr");
    expect(proof).toContain(`data-source-url="${source}"`);
    expect(proof).toContain('itemprop="sku" content="14666"');
    expect(proof).toContain('itemprop="reviewCount" content="29"');
    expect(proof).toContain('id="feedbackListContainer"');
    expect(proof).toContain('itemtype="https://schema.org/Review"');
    expect(proof).not.toContain(noise.slice(0, 100));
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(2_000);

    const invalid = translated("www-asna-ru.translate.goog", "/cards/not-a-card");
    expect((await callGateway(invalid.toString())).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("accepts ASNA's apex canonical only for the exact requested www card path", async () => {
    const requested = "https://www.asna.ru/cards/tsereton_400mg_n28_kaps_soteks.html";
    const canonical = "https://asna.ru/cards/tsereton_400mg_n28_kaps_soteks.html";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${canonical}">
      <link rel="canonical" href="${canonical}"></head><body>
      <div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">
        <meta itemprop="sku" content="36138"><div itemprop="aggregateRating" itemscope>
          <meta itemprop="ratingValue" content="4.9"><meta itemprop="reviewCount" content="17">
        </div><div class="product__ratingText">Отзывы (17)</div>
        <div id="feedbackListContainer" class="product__feedbackList">
          <article class="product__feedbackItem" itemscope itemtype="https://schema.org/Review"></article>
        </div></div></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })));

    const response = await callGateway(translated("www-asna-ru.translate.goog", new URL(requested).pathname).toString());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('itemprop="sku" content="36138"');

    const other = canonical.replace("tsereton_400mg_n28_kaps_soteks", "tserakson_500mg_n28_tab_soteks");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${other}">
      <link rel="canonical" href="${other}"></head><body></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })));
    expect((await callGateway(translated("www-asna-ru.translate.goog", new URL(requested).pathname).toString())).status).toBe(502);
  });

  it("rejects a positive ASNA aggregate without matching visible feedback proof", async () => {
    const source = "https://www.asna.ru/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head>
      <link rel="canonical" href="${source}"></head><body>
      <div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">
        <meta itemprop="sku" content="14666"><div itemprop="aggregateRating" itemscope>
          <meta itemprop="ratingValue" content="5"><meta itemprop="reviewCount" content="29">
        </div></div></body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("www-asna-ru.translate.goog", new URL(source).pathname).toString());

    expect(response.status).toBe(502);
  });

  it("falls back to the exact first-party ASNA card when Google Translate returns 502", async () => {
    const source = "https://www.asna.ru/cards/tsereton_400mg_n28_kaps_soteks.html";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("translate.goog")) return new Response("temporary", { status: 502 });
      return new Response(`<html><head><link rel="canonical" href="${source}"></head><body>
        <div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">
          <meta itemprop="sku" content="36138"><div itemprop="aggregateRating" itemscope>
          <meta itemprop="ratingValue" content="4.9"><meta itemprop="reviewCount" content="17"></div>
          <div class="product__ratingText">Отзывы (17)</div>
          <div id="feedbackListContainer" class="product__feedbackList">
            <article class="product__feedbackItem" itemscope itemtype="https://schema.org/Review"></article>
          </div>
        </div></body></html>`, { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(translated("www-asna-ru.translate.goog", new URL(source).pathname).toString());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("asna-first-party-ssr");
    expect(await response.text()).toContain('itemprop="reviewCount" content="17"');
  });

  it("compacts the exact first-party Med-otzyv aggregate", async () => {
    const source = "https://med-otzyv.ru/lekarstva/165-c/36138-tsereton";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head>
      <link rel="canonical" href="${source}"></head><body><h1>Церетон</h1>
      <div>Все отзывы 49</div></body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(source);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("med-otzyv-first-party-compact");
    expect(await response.text()).toContain('itemprop="reviewCount" content="49"');
  });

  it("accepts and compacts source-bound Polza family and product metrics", async () => {
    const familySource = "https://polza.ru/product/otsillokoktsinum/";
    const productSource = "https://polza.ru/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const source = url.pathname.startsWith("/product/") ? familySource : productSource;
      const card = `<div class="catalog-card" itemscope itemtype="https://schema.org/Product">
        <link itemprop="url" href="/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/">
        <meta itemprop="sku" content="20630"><meta itemprop="name" content="Оциллококцинум, гранулы 1 г, 6 доз">
        <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="1"><meta itemprop="ratingValue" content="5"></span>
      </div>`;
      return new Response(`<html><head><base href="${source}"></head><body>` +
        (url.pathname.startsWith("/product/")
          ? `<div class="catalog__block--cards"><div class="catalog-block__items">${card}</div></div>`
          : `<main itemscope>${card}</main><aside><div itemscope itemtype="https://schema.org/Product">
              <link itemprop="url" href="/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/">
              <meta itemprop="sku" content="20630"><meta itemprop="name" content="duplicate recommendation without metrics">
            </div></aside><div id="review_block"><input class="js-product_id" name="product_id" value="20630">
              <div class="reviews__amount">1</div><div class="reviews__item review-item">Проверенный отзыв</div>
            </div>`) + `</body></html>`, { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", upstream);

    const family = await callGateway(translated("polza-ru.translate.goog", "/product/otsillokoktsinum/").toString());
    const familyProof = await family.text();
    expect(family.status).toBe(200);
    expect(familyProof).toContain('itemprop="sku" content="20630"');
    expect(familyProof).toContain('itemprop="name" content="Оциллококцинум, гранулы 1 г, 6 доз"');

    const product = await callGateway(translated("polza-ru.translate.goog", "/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/").toString());
    expect(product.status).toBe(200);
    const productProof = await product.text();
    expect(productProof).toContain('itemprop="reviewCount" content="1"');
    expect(productProof).toContain('class="js-product_id" name="product_id" value="20630"');
    expect(productProof).toContain('class="reviews__amount">1</div>');
    expect(productProof).toContain('class="reviews__item review-item"');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps exact Polza family cards without AggregateRating and compacts their public empty-review state", async () => {
    const familySource = "https://polza.ru/product/akvaoptik/";
    const productSource = "https://polza.ru/catalog/akvaoptik-rastvor-dlya-obrabotki-i-khraneniya-linz-120-ml_30712/";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const source = url.pathname.startsWith("/product/") ? familySource : productSource;
      const body = url.pathname.startsWith("/product/")
        ? `<div class="catalog__block--cards"><div class="catalog-block__items"><div class="catalog-card" itemscope>
            <link itemprop="url" href="/catalog/akvaoptik-rastvor-dlya-obrabotki-i-khraneniya-linz-120-ml_30712/">
            <meta itemprop="sku" content="30712"><meta itemprop="name" content="АкваОптик, раствор для обработки и хранения линз, 120 мл">
          </div></div></div>`
        : `<section class="product-detail__block" itemscope itemtype="https://schema.org/Product">
            <link itemprop="url" href="/catalog/akvaoptik-rastvor-dlya-obrabotki-i-khraneniya-linz-120-ml_30712/">
            <meta itemprop="sku" content="30712"></section>
          <div id="review_block"><input class="js-product_id" name="product_id" value="30712">
            <p>Отзывов пока нет</p>
          </div>`;
      return new Response(`<html><head><base href="${source}"></head><body>${body}</body></html>`, {
        headers: { "content-type": "text/html" }
      });
    }));

    const family = await callGateway(translated("polza-ru.translate.goog", "/product/akvaoptik/").toString());
    expect(family.status).toBe(200);
    const familyProof = await family.text();
    expect(familyProof).toContain('itemprop="sku" content="30712"');
    expect(familyProof).not.toContain('itemprop="aggregateRating"');

    const product = await callGateway(translated(
      "polza-ru.translate.goog",
      "/catalog/akvaoptik-rastvor-dlya-obrabotki-i-khraneniya-linz-120-ml_30712/"
    ).toString());
    expect(product.status).toBe(200);
    const productProof = await product.text();
    expect(productProof).toContain('class="reviews__empty" data-empty-reviews');
    expect(productProof).toContain('name="product_id" value="30712"');
    expect(productProof).not.toContain('itemprop="aggregateRating"');
  });

  it("compacts exact NFapteka search and product microdata", async () => {
    const searchTarget = translated("nfapteka-ru.translate.goog", "/catalog/", { q: "Оциллококцинум" });
    const searchSource = new URL("https://nfapteka.ru/catalog/");
    searchSource.searchParams.set("q", "Оциллококцинум");
    const productPath = "/tambov/catalog/prostuda/otsillokoktsinum-gran-gomeopat-1-doza-1-g-12.html";
    let completeReviews = true;
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/catalog/") return new Response(`<html><head><base href="${searchSource}"></head><body>
        <div class="productOuter"><a href="https://nfapteka-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en"><img src="empty-title.jpg"></a><div class="productName"><a href="https://nfapteka-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Оциллококцинум гранулы №12</a></div><a data-id="97307"></a></div>
      </body></html>`, { headers: { "content-type": "text/html" } });
      const source = `https://nfapteka.ru${productPath}`;
      return new Response(`<html><head><base href="${source}"><link rel="canonical" href="${source}"></head><body>
        <h1>Оциллококцинум гранулы №12</h1><input name="productId" value="97307"><div itemprop="aggregateRating">
        <meta itemprop="ratingValue" content="4.3"><span itemprop="reviewCount">3</span></div><div id="review">
        ${(completeReviews ? [1, 2, 3] : [1, 2]).map(() => `<article class="testimonial" itemscope itemtype="https://schema.org/Review"><meta itemprop="itemReviewed" content="NF product"><span itemprop="reviewRating"><meta itemprop="ratingValue" content="4.3"></span></article>`).join("")}
        </div></body></html>`, {
        headers: { "content-type": "text/html" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const search = await callGateway(searchTarget.toString());
    expect(search.status).toBe(200);
    expect(await search.text()).toContain('data-id="97307"');
    const product = await callGateway(translated("nfapteka-ru.translate.goog", productPath).toString());
    const proof = await product.text();
    expect(product.status).toBe(200);
    expect(proof).toContain('itemprop="reviewCount" content="3"');
    expect(proof).toContain('itemprop="ratingValue" content="4.3"');
    expect(proof.match(/itemprop="itemReviewed"/g)).toHaveLength(3);
    completeReviews = false;
    const incomplete = await callGateway(translated("nfapteka-ru.translate.goog", productPath).toString());
    expect(incomplete.status).toBe(502);
  });

  it("compacts the complete Bud Zdorov review state when written reviews omit star scores", async () => {
    const source = "https://www.budzdorov.ru/product/kagotsel-tab-12mg-no10-15027";
    const reviews = [
      { id: 1, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 2, ratings: [] }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <h1>Кагоцел таблетки 0,012г №10</h1><div allreviewsqty="2"></div>
      <script>  window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews } })};(function(){var s;s=document.currentScript;}())</script>
    </body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("www-budzdorov-ru.translate.goog", "/product/kagotsel-tab-12mg-no10-15027").toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(proof).toContain('allreviewsqty="2"');
    expect(proof).toContain('{"id":"2","ratings":[]}');
  });

  it("preserves the exact slugged Bud Zdorov product path from family discovery", async () => {
    const source = "https://www.budzdorov.ru/forms/ocillokokcinum";
    const productPath = "/product/otsillokoktsinum-granuly-6doz-2511";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" title="Оциллококцинум гранулы 6 доз">Оциллококцинум гранулы 6 доз</a>
      <a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en#cheapest">Специальное предложение!</a>
    </body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("www-budzdorov-ru.translate.goog", "/forms/ocillokokcinum").toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(proof).toContain(`href="https://www.budzdorov.ru${productPath}"`);
    expect(proof).toContain('title="Оциллококцинум гранулы 6 доз"');
    expect(proof).not.toContain("Специальное предложение!");
    expect(proof).not.toContain('href="https://www.budzdorov.ru/product/2511"');
  });

  it("allows the exact one-letter Bud Zdorov fallback index and rejects broader letter paths", async () => {
    const source = "https://www.budzdorov.ru/letter/%D0%A2";
    const productPath = "/product/tikalizis-tab-90mg-no60-7654321";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <div class="alphabet-forms"><a class="alphabet-forms__item-link"
        href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en"
        title="Тикализис таблетки 90 мг №60">Тикализис таблетки 90 мг №60</a></div>
    </body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("www-budzdorov-ru.translate.goog", "/letter/%D0%A2").toString());
    expect(response.status).toBe(200);
    const proof = await response.text();
    expect(proof).toContain('class="alphabet-forms"');
    expect(proof).toContain('class="alphabet-forms__item-link"');
    expect(proof).toContain(`href="https://www.budzdorov.ru${productPath}"`);
    expect((await callGateway(translated("www-budzdorov-ru.translate.goog", "/letter/%D0%A2%D0%B8%D0%BA").toString())).status).toBe(400);
  });

  it("allows only exact Apteka.ru product paths and compacts their Product aggregate", async () => {
    const source = "https://apteka.ru/product/oczillokokczinum-30-sht-granuly-5e3268eaca7bdc000192d316/";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"><link rel="canonical" href="${source}">
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product", sku: "5e3268eaca7bdc000192d316", name: "Оциллококцинум 30 шт. гранулы",
        aggregateRating: { ratingValue: 4.9, reviewCount: 44, ratingCount: 57 }
      })}</script></head><body><h1>Оциллококцинум 30 шт. гранулы</h1>
      <div class="variantButton" aria-selected="true"><a class="variantButton__link" href="${source}" aria-label="Оциллококцинум 30 шт. гранулы"></a>
        <div class="variantButton__rating"><div class="ItemRating"><span class="ItemRating__label">4.9</span><span class="caption3">(<span>57</span> reviews)</span></div></div>
      </div></body></html>`, {
      headers: { "content-type": "text/html" }
    })));

    const response = await callGateway(translated("apteka-ru.translate.goog", new URL(source).pathname).toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-pharmacy-ssr");
    expect(proof).toContain('"reviewCount":44');
    expect(proof).toContain('"ratingCount":57');
    expect(proof).toContain('class="variantButton" aria-selected="true"');
    expect((await callGateway("https://apteka.ru/search?q=Оциллококцинум")).status).toBe(400);
  });

  it("derives an Apteka.ru zero only from the exact selected product state", async () => {
    const source = "https://apteka.ru/product/xloretta-2-mg--003-mg-63-sht-tabletki-pokrytye-plenochnoj-obolochkoj-69cfc7f2fe56bf3a18668d99/";
    const id = "69cfc7f2fe56bf3a18668d99";
    const siblingId = "69cfc72d6814b63ce393e596";
    const productSlug = new URL(source).pathname.split("/").filter(Boolean)[1];
    const product = {
      "@type": "Product", sku: id,
      name: "Хлорэтта 2 мг + 0,03 мг 63 шт. таблетки, покрытые пленочной оболочкой"
    };
    const sibling = {
      id: siblingId,
      name: "Хлорэтта 2 мг + 0,03 мг 21 шт. таблетки, покрытые пленочной оболочкой",
      humanableUrl: `xloretta-2-mg--003-mg-21-sht-tabletki-pokrytye-plenochnoj-obolochkoj-${siblingId}`,
      reviewsCount: 2,
      rating: 5,
      default: false
    };
    const state = (
      selectedOverrides: Record<string, unknown> = {},
      itemReviews: unknown[] = [],
      productOverrides: Record<string, unknown> = {}
    ) => {
      const selected = {
        id,
        name: product.name,
        humanableUrl: productSlug,
        reviewsCount: 0,
        rating: null,
        default: true,
        ...selectedOverrides
      };
      const groupItems = [{ itemInfos: [sibling, selected] }];
      return {
        product: {
          selected: id,
          groupId: id,
          error: false,
          transition: null,
          itemReviews,
          iteminfo: { [id]: selected },
          products: { [siblingId]: sibling, [id]: selected },
          groupItems,
          groupinfo: { groupItems },
          ...productOverrides
        }
      };
    };
    const page = (initialState?: object, body = "") => `<html><head><base href="${source}"><link rel="canonical" href="${source}">
      <script type="application/ld+json">${JSON.stringify(product)}</script></head><body><h1>${product.name}</h1>${body}
      ${initialState ? `<script>window.__INITIAL_STATE__ = ${JSON.stringify(initialState)};</script>` : ""}</body></html>`;
    const emptyText = "<h2>Отзывы</h2><span>0</span><span>отзывов</span><p>К этому товару ещё нет отзывов.</p>";
    const target = source;
    const usePages = (...pages: string[]) => {
      const pending = [...pages];
      const fetchMock = vi.fn(async () => new Response(pending.shift() ?? pages.at(-1) ?? "", {
        headers: { "content-type": "text/html" }
      }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    };

    const transientFetch = usePages(page(undefined, emptyText), page(state()));
    const response = await callGateway(target);

    expect(response.status).toBe(200);
    const proof = await response.text();
    expect(proof).toContain('"reviewCount":0');
    expect(proof).toContain('"ratingCount":0');
    expect(proof).not.toContain(siblingId);
    expect(transientFetch).toHaveBeenCalledTimes(2);

    const selectedPositiveFetch = usePages(
      page(state({ reviewsCount: 1, rating: 5 }), emptyText),
      page(state())
    );
    expect((await callGateway(target)).status).toBe(502);
    expect(selectedPositiveFetch).toHaveBeenCalledTimes(1);

    const writtenReviewFetch = usePages(
      page(state({}, [{ id: "contradicting-review" }]), emptyText),
      page(state())
    );
    expect((await callGateway(target)).status).toBe(502);
    expect(writtenReviewFetch).toHaveBeenCalledTimes(1);

    for (const invalidHtml of [
      page(state({}, [], { error: true }), emptyText),
      page(state({}, [], { transition: { pending: true } }), emptyText),
      page(undefined, emptyText)
    ]) {
      const retryFetch = usePages(invalidHtml, invalidHtml);
      expect((await callGateway(target)).status).toBe(502);
      expect(retryFetch).toHaveBeenCalledTimes(2);
    }

    const positiveAggregatePage = page(undefined, emptyText).replace(
      "</head>",
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        sku: id,
        name: product.name,
        aggregateRating: { "@type": "AggregateRating", reviewCount: 1, ratingValue: 5 }
      })}</script></head>`
    );
    const aggregateFetch = usePages(positiveAggregatePage, page(state()));
    expect((await callGateway(target)).status).toBe(502);
    expect(aggregateFetch).toHaveBeenCalledTimes(1);

    const exactPositive = {
      id,
      name: product.name,
      humanableUrl: productSlug,
      reviewsCount: 5,
      rating: 5,
      default: true
    };
    const malformedGroupFetch = usePages(
      page(state({}, [], {
        groupItems: [{ itemInfos: "malformed" }, { itemInfos: [exactPositive] }]
      }), emptyText),
      page(state())
    );
    expect((await callGateway(target)).status).toBe(502);
    expect(malformedGroupFetch).toHaveBeenCalledTimes(1);

    const malformedReviewsFetch = usePages(
      page(state({}, [], { itemReviews: { review: { id: "positive-review" } } }), emptyText),
      page(state())
    );
    expect((await callGateway(target)).status).toBe(502);
    expect(malformedReviewsFetch).toHaveBeenCalledTimes(1);

    for (const malformedState of [
      state({}, [], { iteminfo: "malformed" }),
      state({}, [], { products: "malformed" }),
      state({}, [], { groupinfo: "malformed" })
    ]) {
      const malformedFetch = usePages(page(malformedState, emptyText), page(state()));
      expect((await callGateway(target)).status).toBe(502);
      expect(malformedFetch).toHaveBeenCalledTimes(1);
    }

    const duplicateStatePage = page(state()).replace(
      "</body>",
      `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state({ reviewsCount: 3, rating: 5 }))};</script></body>`
    );
    const duplicateStateFetch = usePages(duplicateStatePage, page(state()));
    expect((await callGateway(target)).status).toBe(502);
    expect(duplicateStateFetch).toHaveBeenCalledTimes(1);

    const malformedScriptPage = page(undefined, emptyText).replace(
      "</body>",
      "<script>window.__INITIAL_STATE__ = { product: notValidJson };</script></body>"
    );
    const malformedScriptFetch = usePages(malformedScriptPage, page(state()));
    expect((await callGateway(target)).status).toBe(502);
    expect(malformedScriptFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an exact empty NFapteka product review section as zero", async () => {
    const path = "/tambov/catalog/lekarstva/khondrofen-maz-30-g.html";
    const source = `https://nfapteka.ru${path}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"><link rel="canonical" href="${source}"></head><body>
      <h1>Хондрофен мазь 30 г</h1><input name="productId" value="127010"><div id="review"><h2>Отзывы хондрофен</h2>
      <div class="uk-text-left"><a href="${source}#testimonialModal">Оставить отзыв</a></div></div></body></html>`, {
      headers: { "content-type": "text/html" }
    })));

    const response = await callGateway(translated("nfapteka-ru.translate.goog", path).toString());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('itemprop="reviewCount" content="0"');
  });

  it("filters the first-party Apteka.ru product sitemap by bounded transliteration candidates", async () => {
    const match = "https://apteka.ru/product/xondrofen-maz-30-gr-630e04ccbb7256f6b07f621f/";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://apteka.ru/sitemap-product.xml");
      return new Response(`<urlset><url><loc>${match}</loc></url>` +
        `<url><loc>https://apteka.ru/product/drug-x-aaaaaaaaaaaaaaaaaaaaaaaa/</loc></url></urlset>`, {
        headers: { "content-type": "application/xml" }
      });
    }));

    const response = await callGateway("https://apteka.ru/sitemap-product.xml?slugs=hondrofen%2Ckhondrofen%2Cxondrofen");
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("apteka-first-party-product-sitemap");
    expect(proof).toContain(match);
    expect(proof).not.toContain("drug-x");
  });

  it("filters an exact ASNA card sitemap before it leaves the fixed gateway", async () => {
    const match = "https://asna.ru/cards/tsereton_400mg_n56_kaps_soteks.html";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://www.asna.ru/sitemap/sitemap_cards1.xml");
      return new Response(`<urlset><url><loc>${match}</loc></url>` +
        `<url><loc>https://www.asna.ru/cards/unrelated_400mg_n10.html</loc></url></urlset>`, {
        headers: { "content-type": "application/xml" }
      });
    });
    vi.stubGlobal("fetch", upstream);

    const target = "https://www.asna.ru/sitemap/sitemap_cards1.xml?slugs=cereton%2Ctsereton";
    const response = await callGateway(target);
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("asna-first-party-card-sitemap");
    expect(proof).toContain("https://www.asna.ru/cards/tsereton_400mg_n56_kaps_soteks.html");
    expect(proof).not.toContain("unrelated_400mg_n10");

    expect((await callGateway(`${target}&extra=1`)).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("canonicalizes translated Apteka.ru preparation links to the source host", async () => {
    const source = "https://apteka.ru/preparation/otsillokoktsinum/";
    const id = "5e3268eaca7bdc000192d316";
    const path = `/product/oczillokokczinum-30-sht-granuly-${id}/`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"><link rel="canonical" href="${source}"></head><body>
      <h1>Оциллококцинум</h1><a href="https://apteka-ru.translate.goog${path}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" aria-label="Оциллококцинум гранулы 30 шт">Оциллококцинум гранулы 30 шт</a>
    </body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("apteka-ru.translate.goog", new URL(source).pathname).toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(proof).toContain(`href="https://apteka.ru${path}"`);
    expect(proof).not.toContain("_x_tr_");
  });

  it("rejects unbounded queries and a mismatched source before metrics can become zero", async () => {
    const upstream = vi.fn(async () => new Response(`<html><head>
      <base href="https://farmlend.ru/search?keyword=Другой"></head><body>ничего не найдено</body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));
    vi.stubGlobal("fetch", upstream);
    const invalid = translated("farmlend-ru.translate.goog", "/search", {
      keyword: "Кагоцел",
      redirect: "https://evil.example"
    });

    expect((await callGateway(invalid.toString())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();

    const valid = translated("farmlend-ru.translate.goog", "/search", { keyword: "Кагоцел" });
    const mismatch = await callGateway(valid.toString());
    expect(mismatch.status).toBe(502);
    expect(await mismatch.text()).toContain("did not prove the requested source and metrics");
  });

  it("does not trust an upstream data-source-url when the translated base points elsewhere", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head>
      <base href="https://farmlend.ru/search?keyword=another-brand"></head><body>
      <div data-source-url="https://farmlend.ru/search?keyword=kagocel">No products</div>
    </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })));

    const target = translated("farmlend-ru.translate.goog", "/search", { keyword: "kagocel" });
    const response = await callGateway(target.toString());

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("did not prove the requested source and metrics");
  });
});

describe("fixed first-party collection egress", () => {
  const token = "x".repeat(32);
  const callGateway = (url: string) => staticReviewFetch(
    new Request("https://ratings.example/api/internal/static-review-fetch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url })
    }),
    { INTERNAL_AGENT_TOKEN: token }
  );

  it("recovers a category-moved Uteka reviews card after HTTP 499 and excludes analog counters", async () => {
    const source = "https://uteka.ru/lekarstvennye-sredstva/obezbolivayushhie-sredstva/dimeksid/reviews/";
    const canonical = "https://uteka.ru/lekarstvennye-sredstva/protivovospalitelnye-preparaty/dimeksid/reviews/";
    const fullPage = `<!doctype html><html><head><title>Димексид — отзывы покупателей | Ютека</title>
      <link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}"></head><body>
      <main class="catalog-reviews-page" itemscope itemtype="https://schema.org/Product">
        <meta itemprop="name" content="Димексид"><h1>Димексид отзывы</h1>
        <div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
          <meta itemprop="reviewCount" content="103"><meta itemprop="ratingValue" content="3.9">
          <meta itemprop="bestRating" content="5"><meta itemprop="worstRating" content="1">
        </div>
      </main>
      <aside data-test="analogs"><meta itemprop="reviewCount" content="999"><meta itemprop="ratingValue" content="1.1"></aside>
      <script>window.__NUXT__={recommendations:[{reviewCount:777,ratingValue:2.2}]}</script></body></html>`;
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "uteka.ru") return new Response("upstream closed request", { status: 499 });
      expect(url.hostname).toBe("r.jina.ai");
      expect(url.pathname).toContain("/https://uteka.ru/lekarstvennye-sredstva/obezbolivayushhie-sredstva/dimeksid/reviews/");
      return new Response(fullPage, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(source);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("uteka-reader-compact");
    expect(proof).toContain(`rel="canonical" href="${canonical}"`);
    expect(proof).toContain('itemprop="reviewCount" content="103"');
    expect(proof).toContain('itemprop="ratingValue" content="3.9"');
    expect(proof).not.toContain("999");
    expect(proof).not.toContain("777");
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(
      Number(response.headers.get("x-ratings-original-bytes"))
    );
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps a mismatched Uteka reader card fail-closed instead of synthesizing zero", async () => {
    const source = "https://uteka.ru/lekarstvennye-sredstva/obezbolivayushhie-sredstva/dimeksid/reviews/";
    const other = "https://uteka.ru/lekarstvennye-sredstva/nervnaya-sistema/cereton/reviews/";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "uteka.ru") return new Response("temporary edge block", { status: 499 });
      return new Response(`<!doctype html><html><head><title>Церетон отзывы</title>
        <link rel="canonical" href="${other}"><meta property="og:url" content="${other}"></head><body>
        <main itemscope itemtype="https://schema.org/Product"><meta itemprop="name" content="Церетон"><h1>Церетон отзывы</h1>
        <div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
        <meta itemprop="reviewCount" content="0"><meta itemprop="bestRating" content="5"></div></main></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }));

    const response = await callGateway(source);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("did not prove the exact requested product aggregate");
    expect(body).not.toContain("reviewCount");
    expect((await callGateway(`${source}?redirect=https://evil.example`)).status).toBe(400);
  });

  it("compacts a complete exact Yandex model shard without dropping product URLs", async () => {
    const source = "https://reviews.yandex.ru/ugcpub/sitemap_model_690000000-699999999-0.xml";
    const locations = [
      "https://reviews.yandex.ru/product/otsillokoktsinum--695940046",
      "https://reviews.yandex.ru/product/otsillokoktsinum-granuly--695943742",
      // Live Yandex shards contain source-bound model URLs with an empty
      // title slug. Dropping them would make the compact shard incomplete.
      "https://reviews.yandex.ru/product/--695940047"
    ];
    const upstreamXml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((url) =>
      `<url><loc>${url}</loc><lastmod>2026-07-15</lastmod><priority>0.001</priority></url>`
    ).join("")}</urlset>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(upstreamXml, {
      headers: { "content-type": "application/xml" }
    })));

    const response = await callGateway(source);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("yandex-model-sitemap-compact");
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(
      Number(response.headers.get("x-ratings-original-bytes"))
    );
    expect(proof.match(/<loc>/g)).toHaveLength(locations.length);
    for (const location of locations) expect(proof).toContain(`<loc>${location}</loc>`);
    expect(proof).not.toContain("lastmod");
    expect(proof).not.toContain("priority");
    expect(proof).toMatch(/<\/urlset>$/);
  });

  it("rejects incomplete or cross-shard Yandex sitemap proofs", async () => {
    const source = "https://reviews.yandex.ru/ugcpub/sitemap_model_690000000-699999999-0.xml";
    const bodies = [
      `<urlset><url><loc>https://reviews.yandex.ru/product/otsillokoktsinum--695940046</loc></url>`,
      `<urlset><url><loc>https://reviews.yandex.ru/product/otsillokoktsinum--186502056</loc></url></urlset>`,
      `<urlset><url><loc>https://evil.example/product/otsillokoktsinum--695940046</loc></url></urlset>`
    ];
    for (const body of bodies) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
        headers: { "content-type": "application/xml" }
      })));
      const response = await callGateway(source);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("did not prove a complete exact shard");
    }
  });

  it("returns only matched URLs after proving every exact Yandex batch shard", async () => {
    const endpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const sitemaps = [
      "https://reviews.yandex.ru/ugcpub/sitemap_model_690000000-699999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_700000000-709999999-0.xml"
    ];
    const callBatch = () => staticReviewFetch(new Request(
      "https://ratings.example/api/internal/static-review-fetch",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: endpoint,
          yandexBatch: {
            sitemaps,
            brands: [{ brand: "oscillococcinum", tokens: ["oscillococcinum", "otsillokoktsinum"] }]
          }
        })
      }
    ), { INTERNAL_AGENT_TOKEN: token });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const locations = url === sitemaps[0]
        ? ["https://reviews.yandex.ru/product/otsillokoktsinum--695940046", "https://reviews.yandex.ru/product/ingavirin--695940047"]
        : ["https://reviews.yandex.ru/product/oscillococcinum-granuly--705940046"];
      return new Response(`<urlset>${locations.map((location) => `<url><loc>${location}</loc></url>`).join("")}</urlset>`, {
        headers: { "content-type": "application/xml" }
      });
    }));

    const response = await callBatch();
    const proof = await response.json() as { processed: number; matches: Array<{ url: string }> };
    expect(response.status).toBe(200);
    expect(proof.processed).toBe(2);
    expect(proof.matches.map(({ url }) => url)).toEqual([
      "https://reviews.yandex.ru/product/otsillokoktsinum--695940046",
      "https://reviews.yandex.ru/product/oscillococcinum-granuly--705940046"
    ]);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(
      String(input) === sitemaps[1] ? "<urlset>" : "<urlset></urlset>",
      { headers: { "content-type": "application/xml" } }
    )));
    const incomplete = await callBatch();
    expect(incomplete.status).toBe(502);
    expect(await incomplete.text()).not.toContain('"processed":2');
  });

  it("preserves an exact first-party 404 after the translated product route fails", async () => {
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response("translated failure", { status: 502 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://ru.otzyv.com/hloretta");
    expect(response.status).toBe(404);
    expect(response.headers.get("x-ratings-source")).toBe("direct-ru-otzyv-missing");
    expect(new URL(String(upstream.mock.calls[1]?.[0])).toString()).toBe("https://ru.otzyv.com/hloretta");
  });

  it("still probes the exact first-party card when translated transport throws", async () => {
    const upstream = vi.fn()
      .mockRejectedValueOnce(new TypeError("translated transport failed"))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://ru.otzyv.com/hloretta");
    expect(response.status).toBe(404);
    expect(response.headers.get("x-ratings-source")).toBe("direct-ru-otzyv-missing");
    expect(new URL(String(upstream.mock.calls[1]?.[0])).toString()).toBe("https://ru.otzyv.com/hloretta");
  });

  it("proves a Yandex batch shard when exact XML tags and locations cross stream chunks", async () => {
    const sitemap = "https://reviews.yandex.ru/ugcpub/sitemap_model_1030000000-1039999999-0.xml";
    const chunks = [
      "<?xml version=\"1.0\"?><urlset><url><lo",
      "c>https://reviews.yandex.ru/product/ingavirin--1031000000</loc></url><url><loc>https://reviews.yandex.ru/product/entero",
      "laktis-duo--1032000000</loc></url></url",
      "set>"
    ];
    vi.stubGlobal("fetch", vi.fn(async () => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      }), { headers: { "content-type": "application/xml" } });
    }));

    const response = await staticReviewFetch(new Request(
      "https://ratings.example/api/internal/static-review-fetch",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://reviews.yandex.ru/ugcpub/__ratings_batch__",
          yandexBatch: {
            sitemaps: [sitemap],
            brands: [{ brand: "Энтеролактис", tokens: ["enterolaktis"] }]
          }
        })
      }
    ), { INTERNAL_AGENT_TOKEN: token });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processed: 1,
      verifiedSitemaps: [sitemap],
      matches: [{
        brand: "Энтеролактис",
        url: "https://reviews.yandex.ru/product/enterolaktis-duo--1032000000",
        sitemap
      }]
    });
  });

  it("assigns an overlapping Yandex URL to the longest requested brand token", async () => {
    const sitemap = "https://reviews.yandex.ru/ugcpub/sitemap_model_0-9999999-0.xml";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<urlset>" +
      "<url><loc>https://reviews.yandex.ru/product/vidora-mikro-tabletki--301</loc></url>" +
      "<url><loc>https://reviews.yandex.ru/product/vidora-tabletki--302</loc></url>" +
      "</urlset>",
      { headers: { "content-type": "application/xml" } }
    )));

    const response = await staticReviewFetch(new Request(
      "https://ratings.example/api/internal/static-review-fetch",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://reviews.yandex.ru/ugcpub/__ratings_batch__",
          yandexBatch: {
            sitemaps: [sitemap],
            brands: [
              { brand: "Видора", tokens: ["vidora"] },
              { brand: "Видора Микро", tokens: ["vidora mikro"] }
            ]
          }
        })
      }
    ), { INTERNAL_AGENT_TOKEN: token });
    const proof = await response.json() as { matches: Array<{ brand: string; url: string }> };

    expect(response.status).toBe(200);
    expect(proof.matches).toHaveLength(2);
    expect(proof.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ brand: "Видора Микро", url: expect.stringContaining("vidora-mikro") }),
      expect.objectContaining({ brand: "Видора", url: expect.stringContaining("vidora-tabletki") })
    ]));
  });

  it("settles an in-flight Yandex shard before returning the first batch failure", async () => {
    const endpoint = "https://reviews.yandex.ru/ugcpub/__ratings_batch__";
    const sitemaps = [
      "https://reviews.yandex.ru/ugcpub/sitemap_model_690000000-699999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_700000000-709999999-0.xml"
    ];
    let releaseSibling: (() => void) | undefined;
    let siblingSettled = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === sitemaps[0]) throw new Error("first shard failed");
      await new Promise<void>((resolve) => { releaseSibling = resolve; });
      siblingSettled = true;
      return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
    }));

    const responsePromise = staticReviewFetch(new Request(
      "https://ratings.example/api/internal/static-review-fetch",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: endpoint,
          yandexBatch: {
            sitemaps,
            brands: [{ brand: "Бактоблис", tokens: ["baktoblis"] }]
          }
        })
      }
    ), { INTERNAL_AGENT_TOKEN: token });

    await vi.waitFor(() => expect(releaseSibling).toBeTypeOf("function"));
    expect(siblingSettled).toBe(false);
    releaseSibling!();
    const response = await responsePromise;

    expect(siblingSettled).toBe(true);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("first shard failed");
  });

  it("recovers one exact Yandex shard after two fast incomplete XML copies", async () => {
    vi.useFakeTimers();
    try {
      const sitemap = "https://reviews.yandex.ru/ugcpub/sitemap_model_1220000000-1229999999-0.xml";
      const upstream = vi.fn(async () => upstream.mock.calls.length <= 2
        ? new Response("<urlset>", { headers: { "content-type": "application/xml" } })
        : new Response(
          "<urlset><url><loc>https://reviews.yandex.ru/product/oscillococcinum--1225000000</loc></url></urlset>",
          { headers: { "content-type": "application/xml" } }
        ));
      vi.stubGlobal("fetch", upstream);
      const responsePromise = staticReviewFetch(new Request(
        "https://ratings.example/api/internal/static-review-fetch",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://reviews.yandex.ru/ugcpub/__ratings_batch__",
            yandexBatch: {
              sitemaps: [sitemap],
              brands: [{ brand: "oscillococcinum", tokens: ["oscillococcinum"] }]
            }
          })
        }
      ), { INTERNAL_AGENT_TOKEN: token });

      await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(3));
      const response = await responsePromise;
      const proof = await response.json() as { processed: number; matches: Array<{ url: string }> };

      expect(response.status).toBe(200);
      expect(proof.processed).toBe(1);
      expect(proof.matches).toEqual([{
        brand: "oscillococcinum",
        url: "https://reviews.yandex.ru/product/oscillococcinum--1225000000",
        sitemap
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons one stalled Yandex egress and retries the same exact shard inside the public Function ceiling", async () => {
    vi.useFakeTimers();
    try {
      const sitemap = "https://reviews.yandex.ru/ugcpub/sitemap_model_1110000000-1119999999-0.xml";
      const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (upstream.mock.calls.length === 1) {
          await new Promise<never>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("missing exact shard abort signal");
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        }
        return new Response(
          "<urlset><url><loc>https://reviews.yandex.ru/product/kagotsel--1115000000</loc></url></urlset>",
          { headers: { "content-type": "application/xml" } }
        );
      });
      vi.stubGlobal("fetch", upstream);
      const responsePromise = staticReviewFetch(new Request(
        "https://ratings.example/api/internal/static-review-fetch",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://reviews.yandex.ru/ugcpub/__ratings_batch__",
            yandexBatch: {
              sitemaps: [sitemap],
              brands: [{ brand: "Кагоцел", tokens: ["kagotsel"] }]
            }
          })
        }
      ), { INTERNAL_AGENT_TOKEN: token });

      await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2));
      const response = await responsePromise;
      const proof = await response.json() as { processed: number; matches: Array<{ url: string }> };

      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(proof).toMatchObject({
        processed: 1,
        matches: [{ url: "https://reviews.yandex.ru/product/kagotsel--1115000000" }]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes only proven Yandex index tombstones and keeps adjacent shard failures closed", async () => {
    const tombstones = [
      "https://reviews.yandex.ru/ugcpub/sitemap_model_5880000000-5889999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_5890000000-5899999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_5980000000-5989999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_6010000000-6019999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_6020000000-6029999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_6030000000-6039999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_6040000000-6049999999-0.xml",
      "https://reviews.yandex.ru/ugcpub/sitemap_model_6110000000-6119999999-0.xml"
    ];
    const unknown = "https://reviews.yandex.ru/ugcpub/sitemap_model_6120000000-6129999999-0.xml";
    const callBatch = (sitemap: string) => staticReviewFetch(new Request(
      "https://ratings.example/api/internal/static-review-fetch",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://reviews.yandex.ru/ugcpub/__ratings_batch__",
          yandexBatch: {
            sitemaps: [sitemap],
            brands: [{ brand: "oscillococcinum", tokens: ["oscillococcinum"] }]
          }
        })
      }
    ), { INTERNAL_AGENT_TOKEN: token });
    const missingFetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", missingFetch);

    for (const tombstone of tombstones) {
      const known = await callBatch(tombstone);
      const proof = await known.json() as { processed: number; tombstonedSitemaps?: string[] };
      expect(known.status).toBe(200);
      expect(proof).toMatchObject({ processed: 1, tombstonedSitemaps: [tombstone] });
    }
    expect(missingFetch).toHaveBeenCalledTimes(tombstones.length);

    const unknownFetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", unknownFetch);
    const missing = await callBatch(unknown);
    expect(missing.status).toBe(502);
    expect(await missing.text()).not.toContain('"processed":1');
    expect(unknownFetch).toHaveBeenCalledOnce();

    const blockedFetch = vi.fn(async () => new Response("blocked", { status: 403 }));
    vi.stubGlobal("fetch", blockedFetch);
    const blocked = await callBatch(tombstones[0]!);
    expect(blocked.status).toBe(502);
    expect(await blocked.text()).not.toContain('"processed":1');
    expect(blockedFetch).toHaveBeenCalledOnce();
  });

  it("routes bounded Zdravcity paths through source-bound translated SSR", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname === "reviews.yandex.ru") {
        return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
      }
      expect(url.hostname).toBe("zdravcity-ru.translate.goog");
      expect([...url.searchParams.entries()].sort()).toEqual([
        ["_x_tr_hl", "en"], ["_x_tr_sl", "ru"], ["_x_tr_tl", "en"]
      ]);
      const source = `https://zdravcity.ru${url.pathname}`;
      if (url.pathname.startsWith("/g_")) {
        const products = [{
          id: "D875DF4F-3A76-4BEB-89A1-DF358BD5538A",
          url: "/p_kagocel-tab-12mg-n10-12345.html",
          name: "Kagocel tablets 12 mg No. 10",
          brand: { name: "Kagocel" },
          sku: "33978"
        }];
        return new Response(`<html><head><base href="${source}"></head><body>
          <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products } } })}</script>
          </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const product = {
        id: "D875DF4F-3A76-4BEB-89A1-DF358BD5538A",
        attributes: { name: "Kagocel tablets 12 mg No. 10", url: url.pathname, rating: 5, sku: "33978" },
        reviews: [{ ID: "6548", rate: 5 }, { ID: "6549", rate: 0 }]
      };
      const structuredProducts = [{
        "@type": "Product",
        name: "Other product No. 30",
        sku: "other-sku",
        url: "/p_other-product-n30-99999.html",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 999 }
      }, {
        "@type": "Product",
        name: product.attributes.name,
        sku: product.attributes.sku,
        url: url.pathname,
        aggregateRating: { "@type": "AggregateRating", reviewCount: 21 }
      }];
      return new Response(`<html><head><base href="${source}"></head><body>
        <div>${"x".repeat(500_000)}</div>
        <script type="application/ld+json">${JSON.stringify(structuredProducts)}</script>
        <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { productV2: product } } })}</script>
        </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", upstream);

    expect((await callGateway("https://reviews.yandex.ru/ugcpub/sitemap_model_590000000-599999999-0.xml")).status).toBe(200);
    const group = await callGateway("https://zdravcity.ru/g_kagocel/");
    expect(group.status).toBe(200);
    expect(await group.text()).toContain('"products":[{"id":"D875DF4F-3A76-4BEB-89A1-DF358BD5538A"');
    const response = await callGateway("https://zdravcity.ru/p_kagocel-tab-12mg-n10-12345.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-zdravcity-ssr");
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(2_000);
    const compactProduct = await response.text();
    expect(compactProduct).toContain('"reviews":[{"ID":"6548","rate":5},{"ID":"6549","rate":0}]');
    expect(compactProduct).toContain('"reviewCount":21');
    expect(compactProduct).not.toContain('"reviewCount":999');
    expect((await callGateway("https://zdravcity.ru/g_kagocel/?redirect=https://evil.example")).status).toBe(400);
    expect((await callGateway("https://reviews.yandex.ru/ugcpub/private.xml")).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("preserves an exact first-party Zdravcity 404 after translated transport fails", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "zdravcity-ru.translate.goog") throw new TypeError("translated egress failed");
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recovered = await callGateway(target);

    expect(recovered.status).toBe(404);
    expect(recovered.headers.get("x-ratings-source")).toBe("zdravcity-first-party-missing");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const nonOkTranslated = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.hostname === "zdravcity-ru.translate.goog"
        ? new Response("translated forbidden", { status: 403 })
        : new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", nonOkTranslated);
    const terminal = await callGateway(target);
    expect(terminal.status).toBe(404);
    expect(terminal.headers.get("x-ratings-source")).toBe("zdravcity-first-party-missing");
    expect(nonOkTranslated).toHaveBeenCalledTimes(2);

    for (const directStatus of [200, 302, 503]) {
      const unconfirmedTranslated404 = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        return url.hostname === "zdravcity-ru.translate.goog"
          ? new Response("translated missing", { status: 404 })
          : new Response("not terminal", { status: directStatus });
      });
      vi.stubGlobal("fetch", unconfirmedTranslated404);
      const unconfirmed = await callGateway(target);
      expect(unconfirmed.status).toBe(502);
      expect(await unconfirmed.json()).toEqual({
        error: "Zdravcity translated terminal status was not confirmed by first-party"
      });
      expect(unconfirmedTranslated404).toHaveBeenCalledTimes(4);
    }

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "zdravcity-ru.translate.goog") throw new TypeError("translated egress failed");
      return new Response("source unavailable", { status: 503 });
    }));
    expect((await callGateway(target)).status).toBe(502);
  });

  it("confirms a missing Zdravcity group through the exact first-party BFF when page routes are blocked", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "zdravcity-ru.translate.goog") throw new TypeError("translated egress failed");
      if (url.pathname === "/bff/query") {
        return new Response(JSON.stringify({
          errors: [{
            message: "queryResolver.Group: catalog.Manager.Group: rpc error: code = NotFound desc = group.group: catalog.group by code hloretta: group not found",
            path: ["group"], extensions: { code: 404 }
          }],
          data: null
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("source blocked", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recovered = await callGateway(target);

    expect(recovered.status).toBe(404);
    expect(recovered.headers.get("x-ratings-source")).toBe("zdravcity-first-party-bff-missing");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("confirms a missing Zdravcity group through the translated exact BFF when direct BFF egress is blocked", async () => {
    const target = "https://zdravcity.ru/g_hloretta/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/g_") && url.hostname === "zdravcity-ru.translate.goog") {
        return new Response("translated page blocked", { status: 502 });
      }
      if (url.pathname.startsWith("/g_")) return new Response("source page blocked", { status: 503 });
      if (url.hostname === "zdravcity.ru" && url.pathname === "/bff/query") {
        return new Response("direct BFF forbidden", { status: 403 });
      }
      expect(url.hostname).toBe("zdravcity-ru.translate.goog");
      expect(url.pathname).toBe("/bff/query");
      return new Response(JSON.stringify({
        errors: [{
          message: "queryResolver.Group: catalog.Manager.Group: rpc error: code = NotFound desc = group.group: catalog.group by code hloretta: group not found",
          path: ["group"], extensions: { code: 404 }
        }],
        data: null
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recovered = await callGateway(target);

    expect(recovered.status).toBe(404);
    expect(recovered.headers.get("x-ratings-source")).toBe("zdravcity-first-party-bff-missing");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("compacts Zdravcity written reviews without inventing a missing star rating", async () => {
    const source = "https://zdravcity.ru/p_grippferon-kapli-10000me-ml-10ml-12345.html";
    const product = {
      id: "D875DF4F-3A76-4BEB-89A1-DF358BD5538A",
      attributes: { name: "Гриппферон капли 10000 МЕ/мл 10 мл", url: new URL(source).pathname, rating: null, sku: "33978" },
      reviews: [{ ID: "6548", rate: 0 }, { ID: "6549", rate: 0 }]
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { productV2: product } } })}</script>
      </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })));

    const response = await callGateway(source);
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(proof).toContain('"reviews":[{"ID":"6548","rate":0},{"ID":"6549","rate":0}]');
    expect(proof).not.toContain('"rating":0');
  });

  it("fails closed when translated Zdravcity HTML is not bound to the exact source", async () => {
    const upstream = vi.fn(async () => new Response(`<html><head>
      <base href="https://zdravcity.ru/p_another-product-999.html"></head><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { productV2: {
        id: "D875DF4F-3A76-4BEB-89A1-DF358BD5538A",
        attributes: { name: "Another product", url: "/p_another-product-999.html", rating: 5 },
        reviews: [{ ID: "1", rate: 5 }]
      } } } })}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway("https://zdravcity.ru/p_kagocel-tab-12mg-n10-12345.html");

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("did not prove the exact requested product data");
    expect(upstream).toHaveBeenCalledOnce();
  });
});
