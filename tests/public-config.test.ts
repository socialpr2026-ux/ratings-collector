import { afterEach, describe, expect, it, vi } from "vitest";
import onRequest, { staticReviewFetch } from "../cloud-functions/api/[[default]].js";

afterEach(() => vi.unstubAllGlobals());

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
        </div></div></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }));
    vi.stubGlobal("fetch", upstream);

    const response = await callGateway(translated("www-asna-ru.translate.goog", new URL(source).pathname).toString());
    const proof = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-pharmacy-ssr");
    expect(proof).toContain(`data-source-url="${source}"`);
    expect(proof).toContain('itemprop="sku" content="14666"');
    expect(proof).toContain('itemprop="reviewCount" content="29"');
    expect(proof).not.toContain(noise.slice(0, 100));
    expect(Number(response.headers.get("x-ratings-proof-bytes"))).toBeLessThan(2_000);

    const invalid = translated("www-asna-ru.translate.goog", "/cards/not-a-card");
    expect((await callGateway(invalid.toString())).status).toBe(400);
    expect(upstream).toHaveBeenCalledOnce();
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
      return new Response(`<html><head><base href="${source}"></head><body>
        <div>${"x".repeat(500_000)}</div>
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
    expect(await response.text()).toContain('"reviews":[{"ID":"6548","rate":5},{"ID":"6549","rate":0}]');
    expect((await callGateway("https://zdravcity.ru/g_kagocel/?redirect=https://evil.example")).status).toBe(400);
    expect((await callGateway("https://reviews.yandex.ru/ugcpub/private.xml")).status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(3);
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
