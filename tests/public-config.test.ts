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
      expect(new Headers(init?.headers).has("x-no-cache")).toBe(false);
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
            <h3><a class="product-name" href="https://otzovik-com.translate.goog/reviews/gomeopaticheskoe_sredstvo_ot_grippa_i_prostudnih_zabolevaniy_buaron_ocillokokcinum/?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Гомеопатический препарат Буарон "Оциллококцинум"</a></h3>
          </div>
          <div class="item sortable" data-pid="2620333" data-reviews="1" data-rating="50001">
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
            </div></aside>`) + `</body></html>`, { headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", upstream);

    const family = await callGateway(translated("polza-ru.translate.goog", "/product/otsillokoktsinum/").toString());
    const familyProof = await family.text();
    expect(family.status).toBe(200);
    expect(familyProof).toContain('itemprop="sku" content="20630"');
    expect(familyProof).toContain('itemprop="name" content="Оциллококцинум, гранулы 1 г, 6 доз"');

    const product = await callGateway(translated("polza-ru.translate.goog", "/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/").toString());
    expect(product.status).toBe(200);
    expect(await product.text()).toContain('itemprop="reviewCount" content="1"');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("compacts exact NFapteka search and product microdata", async () => {
    const searchTarget = translated("nfapteka-ru.translate.goog", "/catalog/", { q: "Оциллококцинум" });
    const searchSource = new URL("https://nfapteka.ru/catalog/");
    searchSource.searchParams.set("q", "Оциллококцинум");
    const productPath = "/tambov/catalog/prostuda/otsillokoktsinum-gran-gomeopat-1-doza-1-g-12.html";
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/catalog/") return new Response(`<html><head><base href="${searchSource}"></head><body>
        <div class="productOuter"><a href="https://nfapteka-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en"><img src="empty-title.jpg"></a><div class="productName"><a href="https://nfapteka-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en">Оциллококцинум гранулы №12</a></div><a data-id="97307"></a></div>
      </body></html>`, { headers: { "content-type": "text/html" } });
      const source = `https://nfapteka.ru${productPath}`;
      return new Response(`<html><head><base href="${source}"><link rel="canonical" href="${source}"></head><body>
        <h1>Оциллококцинум гранулы №12</h1><input name="productId" value="97307"><div itemprop="aggregateRating">
        <meta itemprop="ratingValue" content="4.3"><span itemprop="reviewCount">3</span></div></body></html>`, {
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
  });

  it("compacts the complete Bud Zdorov review state", async () => {
    const source = "https://www.budzdorov.ru/product/otsillokoktsinum-granuly-6doz-2511";
    const reviews = [
      { id: 1, ratings: [{ attribute_code: "Оценка", value: 5 }] },
      { id: 2, ratings: [{ attribute_code: "Оценка", value: 4 }] }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <h1>Оциллококцинум гранулы 6 доз</h1><div allreviewsqty="2"></div>
      <script>window.__INITIAL_STATE__=${JSON.stringify({ productView: { reviews } })};document.currentScript.remove()</script>
    </body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("www-budzdorov-ru.translate.goog", "/product/otsillokoktsinum-granuly-6doz-2511").toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(proof).toContain('allreviewsqty="2"');
    expect(proof).toContain('"attribute_code":"Оценка","value":4');
  });

  it("preserves the exact slugged Bud Zdorov product path from family discovery", async () => {
    const source = "https://www.budzdorov.ru/forms/ocillokokcinum";
    const productPath = "/product/otsillokoktsinum-granuly-6doz-2511";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"></head><body>
      <a href="https://www-budzdorov-ru.translate.goog${productPath}?_x_tr_sl=ru&amp;_x_tr_tl=en&amp;_x_tr_hl=en" title="Оциллококцинум гранулы 6 доз">Оциллококцинум гранулы 6 доз</a>
    </body></html>`, { headers: { "content-type": "text/html" } })));

    const response = await callGateway(translated("www-budzdorov-ru.translate.goog", "/forms/ocillokokcinum").toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(proof).toContain(`href="https://www.budzdorov.ru${productPath}"`);
    expect(proof).not.toContain('href="https://www.budzdorov.ru/product/2511"');
  });

  it("allows only exact Apteka.ru product paths and compacts their Product aggregate", async () => {
    const source = "https://apteka.ru/product/oczillokokczinum-30-sht-granuly-5e3268eaca7bdc000192d316/";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><base href="${source}"><link rel="canonical" href="${source}">
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product", sku: "5e3268eaca7bdc000192d316", name: "Оциллококцинум 30 шт. гранулы",
        aggregateRating: { ratingValue: 4.9, reviewCount: 44, ratingCount: 57 }
      })}</script></head><body><h1>Оциллококцинум 30 шт. гранулы</h1></body></html>`, {
      headers: { "content-type": "text/html" }
    })));

    const response = await callGateway(translated("apteka-ru.translate.goog", new URL(source).pathname).toString());
    const proof = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratings-source")).toBe("google-translate-pharmacy-ssr");
    expect(proof).toContain('"reviewCount":44');
    expect(proof).toContain('"ratingCount":57');
    expect((await callGateway("https://apteka.ru/search?q=Оциллококцинум")).status).toBe(400);
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
