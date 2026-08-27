import { describe, expect, it, vi } from "vitest";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { VitaExpressAdapter } from "../src/server/adapters/vitaexpress.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const ORIGIN = "https://vitaexpress.ru";
const CONTEXT = { region: "\u041c\u043e\u0441\u043a\u0432\u0430", runId: "vita-test" };

const PRODUCTS = [
  {
    id: "193139", brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442", title: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442 \u041a\u043e\u043c\u0444\u043e\u0440\u0442 \u0420\u0430\u0441\u0442\u0432\u043e\u0440 0,18%, 10\u043c\u043b",
    path: "/product/biviart_komfort_r_r_uvlazhn__oftalmolog__0_18_10ml__1_fl_/"
  },
  {
    id: "193140", brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442", title: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442 \u0421\u043e\u0444\u0442 \u0420\u0430\u0441\u0442\u0432\u043e\u0440 0,1%, 10\u043c\u043b",
    path: "/product/biviart_soft_r_r_uvlazhn__oftalmolog__0_1_10ml__1_fl_/"
  },
  {
    id: "193141", brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442", title: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442 \u0423\u043b\u044c\u0442\u0440\u0430 \u0420\u0430\u0441\u0442\u0432\u043e\u0440 0,3%, 10\u043c\u043b",
    path: "/product/biviart_ultra_r_r_uvlazhn__oftalmolog__0_3_10ml__1_fl_/"
  },
  {
    id: "178185", brand: "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d", title: "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d \u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0434\u043b\u044f \u043f\u0440\u043e\u043c\u044b\u0432\u0430\u043d\u0438\u044f \u0433\u043b\u0430\u0437 3%, 2\u043c\u043b \u211610",
    path: "/product/okusalin_rastvor_dlya_promyvaniya_glaz_3_2ml_10/"
  },
  {
    id: "202806", brand: "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442", title: "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442 \u041a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435, 10\u043c\u043b",
    path: "/product/oftarint_kapli_glaznye_2mg_20mg_0_675mgml_10ml_fl_kap_/"
  },
  {
    id: "203245", brand: "\u0422\u0430\u0443\u0441\u0442\u0438\u043d", title: "\u0422\u0430\u0443\u0441\u0442\u0438\u043d \u0421\u043e\u043b\u043e\u0444\u0430\u0440\u043c \u041a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435 4%, 10\u043c\u043b",
    path: "/product/taurin__taustin__kapli_glaznye_4_10ml_solofarm/"
  },
  {
    id: "211589", brand: "Хлорэтта", title: "Хлорэтта Таблетки, покрытые пленочной оболочкой 2мг+0,03мг, №21",
    path: "/product/khloretta_tab__ppo_2mg_0_03mg__21/"
  },
  {
    id: "211590", brand: "Хлорэтта", title: "Хлорэтта Таблетки, покрытые пленочной оболочкой 2мг+0,03мг, №63",
    path: "/product/khloretta_tab__ppo_2mg_0_03mg__21_3/"
  },
  {
    id: "203657", brand: "Бактоблис", title: "Бактоблис таблетки для рассасывания, №30 без сахара",
    path: "/product/baktoblis_plyus_tab__drassas___30_bsakhara_bad/"
  },
  {
    id: "197583", brand: "Бактоблис", title: "Бактоблис плюс таблетки для рассасывания, №90",
    path: "/product/baktoblis_plyus_tab__drassas__950mg__90_bad/"
  },
  {
    id: "190233", brand: "Бактоблис", title: "Бактоблис порошок в саше-пакетах, №15",
    path: "/product/baktoblis_por__dpr__vnutr_1500mg__15_sashe_pak__bad/"
  },
  {
    id: "193661", brand: "Бактоблис", title: "Бактоблис порошок в саше-пакетах, №30",
    path: "/product/baktoblis_por__dpr__vnutr_1500mg__30_sashe_pak__bad/"
  },
  {
    id: "175303", brand: "Бактоблис", title: "Бактоблис плюс таблетки для рассасывания, №30",
    path: "/product/baktoblis_tabletki_bad_30/"
  },
  {
    id: "196245", brand: "Энтеролактис", title: "Энтеролактис Плюс капсулы, №15",
    path: "/product/enterolaktis_plyus_kaps___15_bad/"
  },
  {
    id: "196246", brand: "Энтеролактис", title: "Энтеролактис Дуо порошок д/пригот. р-ра д/приема внутрь, 5г №20",
    path: "/product/enterolaktis_duo_por__5g__20_sashe_bad/"
  },
  {
    id: "196244", brand: "Энтеролактис", title: "Энтеролактис Фибра сироп, 10мл №12",
    path: "/product/enterolaktis_fibra_10ml__12fl__sirop_kaps_s_por_v_kr_fl__bad/"
  }
] as const;

const KAGOCEL_FAMILY = {
  id: "tag-7419",
  tagId: "7419",
  brand: "Кагоцел",
  url: `${ORIGIN}/tag/kagotsel/`,
  variants: [
    { name: "Кагоцел таблетки 12мг, №30", url: `${ORIGIN}/product/kagotsel_tab__12mg__30/` },
    { name: "Кагоцел таблетки 12мг, №10", url: `${ORIGIN}/product/kagotsel_tab_12mg_10/` },
    { name: "Кагоцел таблетки 12мг, №20", url: `${ORIGIN}/product/kagotsel_tab__12mg__20/` },
    { name: "Кагоцел таблетки 12мг, №20,Ниармедик Фарма", url: `${ORIGIN}/product/kagotsel_tab_12mg_20/` }
  ]
} as const;

const INGAVIRIN_FAMILY = {
  id: "tag-3282",
  tagId: "3282",
  brand: "Ингавирин",
  url: `${ORIGIN}/tag/ingavirin/`,
  variants: [
    { name: "Ингавирин капсулы 60мг, №10", url: `${ORIGIN}/product/ingavirin_kapsuly_60mg_10_175448/` },
    { name: "Ингавирин сироп 30мг/5мл, 90мл", url: `${ORIGIN}/product/ingavirin_sirop_30mg_5ml_90ml/` },
    { name: "Ингавирин капсулы 90мг, №10", url: `${ORIGIN}/product/ingavirin_kaps_90_mg_10/` },
    { name: "Ингавирин сироп 30мг/5мл, 50мл", url: `${ORIGIN}/product/ingavirin_sirop_30mg5ml_50ml/` }
  ]
} as const;

type TestProduct = typeof PRODUCTS[number];

function escapeAttribute(value: unknown): string {
  return JSON.stringify(value).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function page(product: TestProduct, options: {
  title?: string;
  boundName?: string;
  canonicalPath?: string;
  pageId?: string;
  reviews?: unknown;
  rating?: unknown;
  emptyText?: string;
} = {}): string {
  const title = options.title ?? product.title;
  const boundName = options.boundName ?? title;
  const pageId = options.pageId ?? product.id;
  const canonicalPath = options.canonicalPath ?? product.path;
  const reviews = options.reviews ?? { productId: Number(product.id), reviewList: null };
  const rating = options.rating ?? [{ productId: product.id, status: true, rating: 0, reviewsCount: 0 }];
  const emptyText = options.emptyText ?? "\u0412\u0430\u0448 \u043e\u0442\u0437\u044b\u0432 \u043e \u0442\u043e\u0432\u0430\u0440\u0435 \u0441\u0442\u0430\u043d\u0435\u0442 \u043f\u0435\u0440\u0432\u044b\u043c! \u041f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430, \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0443\u0439\u0442\u0435\u0441\u044c.";
  return `<!doctype html><html><head><link rel="canonical" href="${ORIGIN}${canonicalPath}"></head><body>
    <h1>${title}</h1>
    <div id="page-content" data-id="${pageId}" data-xml="${pageId}" data-xml_id="${pageId}"
      data-url="${canonicalPath}" data-name="${boundName}">
      <product-reviews :id="${pageId}" :product-id="${pageId}" name="${boundName}"
        :reviews="${escapeAttribute(reviews)}" :rating="${escapeAttribute(rating)}">
        <h2>\u041e\u0442\u0437\u044b\u0432\u044b \u043e \u0442\u043e\u0432\u0430\u0440\u0435 ${boundName}</h2>
        <div>${emptyText}</div>
      </product-reviews>
    </div>
  </body></html>`;
}

function unavailableReviewPage(
  product: TestProduct,
  payloadOverrides: Record<string, unknown> = {}
): string {
  const payload = {
    ID: Number(product.id),
    XML_ID: Number(product.id),
    NAME: product.title,
    DETAIL_PAGE_URL: product.path,
    APLAUT: 0,
    SHOW_REVIEW: 1,
    ...payloadOverrides
  };
  return page(product).replace(
    /<product-reviews[^]*?<\/product-reviews>/u,
    `<product-detail-header :product="${escapeAttribute(payload)}" :reviews="null" :rating="${product.id}"></product-detail-header>`
  );
}

function productById(id: string): TestProduct {
  return PRODUCTS.find((product) => product.id === id)!;
}

function ref(product: TestProduct) {
  return {
    domain: "vitaexpress.ru",
    platform: "vitaexpress.ru",
    listingId: product.id,
    brand: product.brand,
    url: `${ORIGIN}${product.path}`,
    title: product.title,
    metadata: {}
  };
}

function fetchProducts(overrides: Partial<Record<string, Response>> = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const product = PRODUCTS.find((item) => item.path === url.pathname);
    if (!product) return new Response("missing", { status: 404 });
    return overrides[product.id] ?? new Response(page(product), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }) as unknown as typeof fetch;
}

type FamilyScore = number | "unknown";

function familyPage(options: {
  aboutBrand?: string;
  headingCount?: number;
  scores?: readonly FamilyScore[];
} = {}): string {
  const scores = options.scores ?? [5, 5, 4, 5, 4, 5];
  const headingCount = options.headingCount ?? scores.length;
  const graph = [
    {
      "@type": "CollectionPage",
      "@id": `${KAGOCEL_FAMILY.url}#collectionpage`,
      url: KAGOCEL_FAMILY.url,
      name: KAGOCEL_FAMILY.brand,
      mainEntity: { "@id": `${KAGOCEL_FAMILY.url}#itemlist` },
      about: { "@type": "Brand", name: options.aboutBrand ?? KAGOCEL_FAMILY.brand }
    },
    {
      "@type": "ItemList",
      "@id": `${KAGOCEL_FAMILY.url}#itemlist`,
      url: KAGOCEL_FAMILY.url,
      name: `Список товаров ${KAGOCEL_FAMILY.brand}`,
      numberOfItems: KAGOCEL_FAMILY.variants.length,
      itemListElement: KAGOCEL_FAMILY.variants.map((variant, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: {
          "@type": "Product",
          "@id": `${variant.url}#product`,
          name: variant.name,
          url: variant.url,
          brand: { "@type": "Brand", name: KAGOCEL_FAMILY.brand }
        }
      }))
    }
  ];
  const reviews = scores.map((score, index) => {
    const stars = score === "unknown"
      ? '<span class="product__star half-star-old"></span>' + Array.from({ length: 4 }, () => '<span class="product__star"></span>').join("")
      : Array.from({ length: 5 }, (_, star) => `<span class="product__star${star < score ? " star-old" : ""}"></span>`).join("");
    return `<div class="tag-review">
      <div class="review-name">Покупатель ${index + 1}</div>
      <div class="product__stars">${stars}</div>
      <div class="review-date">0${index + 1} февраля 2024</div>
      <div class="review-text">Проверенный отзыв ${index + 1}</div>
    </div>`;
  }).join("");
  return `<!doctype html><html><head>
    <link rel="canonical" href="${KAGOCEL_FAMILY.url}">
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org/", "@graph": graph })}</script>
  </head><body><h1>${KAGOCEL_FAMILY.brand}</h1>
    <div id="tag-reviews">
      <h2>Отзывы (${headingCount})</h2>
      <div class="product__raiting-big product__stars">
        ${Array.from({ length: 4 }, () => '<span class="product__star star-old"></span>').join("")}
        <span class="product__star half-star-old"></span><span>Общий рейтинг</span>
      </div>
      <input type="hidden" name="tagId" value="${KAGOCEL_FAMILY.tagId}">
      <div class="tag-reviews">${reviews}</div>
    </div>
  </body></html>`;
}

function fetchFamilyPage(html: string): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    expect(new URL(String(input)).toString()).toBe(KAGOCEL_FAMILY.url);
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as unknown as typeof fetch;
}

function exactFamilyPage(family: typeof INGAVIRIN_FAMILY, scores: readonly number[]): string {
  const graph = [{
    "@type": "CollectionPage", "@id": `${family.url}#collectionpage`, url: family.url,
    name: family.brand, mainEntity: { "@id": `${family.url}#itemlist` },
    about: { "@type": "Brand", name: family.brand }
  }, {
    "@type": "ItemList", "@id": `${family.url}#itemlist`, url: family.url,
    name: `Список товаров ${family.brand}`, numberOfItems: family.variants.length,
    itemListElement: family.variants.map((variant, index) => ({
      "@type": "ListItem", position: index + 1,
      item: { "@type": "Product", "@id": `${variant.url}#product`, ...variant, brand: { "@type": "Brand", name: family.brand } }
    }))
  }];
  return `<!doctype html><html><head><link rel="canonical" href="${family.url}">
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org/", "@graph": graph })}</script>
    </head><body><h1>${family.brand}</h1><div id="tag-reviews"><h2>Отзывы (${scores.length})</h2>
    <input type="hidden" name="tagId" value="${family.tagId}"><div class="tag-reviews">${scores.map((score, index) =>
      `<div class="tag-review"><div class="review-name">Покупатель ${index}</div><div class="product__stars">${
        Array.from({ length: 5 }, (_, star) => `<span class="product__star${star < score ? " star-old" : ""}"></span>`).join("")
      }</div><div class="review-date">01 августа 2026</div><div class="review-text">Отзыв</div></div>`
    ).join("")}</div></div></body></html>`;
}

describe("VitaExpressAdapter", () => {
  it("discovers exactly the three proven Biviart variants and never invents Intensive", async () => {
    const fetchMock = fetchProducts();
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("\u0411\u0438\u0432\u0438\u0430\u0440\u0442", { ...CONTEXT, runId: "biviart" });

    expect(refs.map((item) => item.listingId)).toEqual(["193139", "193140", "193141"]);
    expect(refs.every((item) => item.title?.includes("\u0411\u0438\u0432\u0438\u0430\u0440\u0442"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d", "178185"],
    ["\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442", "202806"],
    ["\u0422\u0430\u0443\u0441\u0442\u0438\u043d", "203245"]
  ])("discovers the complete exact %s card set", async (brand, id) => {
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts());
    await expect(adapter.discover(brand, { ...CONTEXT, runId: `discover-${id}` })).resolves.toMatchObject([
      { listingId: id, brand, url: `${ORIGIN}${productById(id).path}` }
    ]);
  });

  it("discovers all five proven Baktoblis cards from the bounded registry", async () => {
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts());
    const refs = await adapter.discover("Бактоблис", { ...CONTEXT, runId: "discover-baktoblis" });

    expect(refs.map((item) => item.listingId)).toEqual(["203657", "197583", "190233", "193661", "175303"]);
  });

  it("registers the two exact current Хлорэтта variants with their proven IDs and URLs", async () => {
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts());

    await expect(adapter.discover("Хлорэтта", { ...CONTEXT, runId: "discover-khloretta" })).resolves.toMatchObject([
      {
        listingId: "211589",
        title: "Хлорэтта Таблетки, покрытые пленочной оболочкой 2мг+0,03мг, №21",
        url: `${ORIGIN}/product/khloretta_tab__ppo_2mg_0_03mg__21/`
      },
      {
        listingId: "211590",
        title: "Хлорэтта Таблетки, покрытые пленочной оболочкой 2мг+0,03мг, №63",
        url: `${ORIGIN}/product/khloretta_tab__ppo_2mg_0_03mg__21_3/`
      }
    ]);
  });

  it("discovers and collects all three exact Enterolactis cards with proven empty reviews", async () => {
    const evidence = new MemoryEvidenceStore();
    const adapter = new VitaExpressAdapter(evidence, fetchProducts());

    const refs = await adapter.discover("Энтеролактис", { ...CONTEXT, runId: "enterolactis" });
    expect(refs.map((item) => item.listingId)).toEqual(["196245", "196246", "196244"]);

    const observations = await Promise.all(refs.map((item) =>
      adapter.collect(item, { ...CONTEXT, runId: "enterolactis" })
    ));
    expect(observations).toHaveLength(3);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "196245", reviews: 0, rating: null, ratingCount: 0, status: "no_reviews" }),
      expect.objectContaining({ listingId: "196246", reviews: 0, rating: null, ratingCount: 0, status: "no_reviews" }),
      expect.objectContaining({ listingId: "196244", reviews: 0, rating: null, ratingCount: 0, status: "no_reviews" })
    ]));
    expect(evidence.items.size).toBe(3);
  });

  it("accepts Vita's longer source-bound component name for the same exact Baktoblis card", async () => {
    const product = productById("203657");
    const boundName = "Бактоблис таблетки для рассасывания без сахара, №30 без сахара";
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(page(product, { boundName }), {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" }
      })
    }));

    await expect(adapter.discover("Бактоблис", { ...CONTEXT, runId: "bound-name-baktoblis" }))
      .resolves.toHaveLength(5);
  });

  it("publishes one Kagocel family row from six exact stars instead of duplicating its variants", async () => {
    const evidence = new MemoryEvidenceStore();
    const fetchMock = fetchFamilyPage(familyPage());
    const adapter = new VitaExpressAdapter(evidence, fetchMock);
    const context = { ...CONTEXT, runId: "kagocel-family" };

    const refs = await adapter.discover(KAGOCEL_FAMILY.brand, context);
    expect(refs).toEqual([expect.objectContaining({
      listingId: KAGOCEL_FAMILY.id,
      brand: KAGOCEL_FAMILY.brand,
      url: KAGOCEL_FAMILY.url,
      title: KAGOCEL_FAMILY.brand
    })]);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      listingId: KAGOCEL_FAMILY.id,
      product: KAGOCEL_FAMILY.brand,
      reviews: 6,
      writtenReviewCount: 6,
      ratingCount: 6,
      rating: 4.7,
      status: "ok",
      aggregateGroupId: "vitaexpress:family:tag-7419",
      source: "vitaexpress-source-bound-family-review-stars",
      productEvidence: {
        scope: "product_family",
        variants: KAGOCEL_FAMILY.variants.map((variant) => variant.name)
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(evidence.items.size).toBe(1);
  });

  it("collects the live-proven Ingavirin family registry as one aggregate row", async () => {
    const html = exactFamilyPage(INGAVIRIN_FAMILY, [5, 5, 5]);
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    ) as unknown as typeof fetch);
    const context = { ...CONTEXT, runId: "ingavirin-family" };

    const refs = await adapter.discover(INGAVIRIN_FAMILY.brand, context);

    expect(refs).toMatchObject([{ listingId: "tag-3282", metadata: { variantCount: 4 } }]);
    await expect(adapter.collect(refs[0], context)).resolves.toMatchObject({
      reviews: 3, rating: 5, ratingCount: 3, aggregateGroupId: "vitaexpress:family:tag-3282",
      productEvidence: { scope: "product_family", variants: INGAVIRIN_FAMILY.variants.map((variant) => variant.name) }
    });
  });

  it("carries only Vita geo cookies across its exact same-domain family redirect", async () => {
    const html = familyPage();
    let calls = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        const headers = new Headers({ location: `${KAGOCEL_FAMILY.url}/?select_geo_city=251` });
        headers.append("set-cookie", "PHPSESSID=exact-session; Path=/; Domain=vitaexpress.ru");
        headers.append("set-cookie", "ChoosenCityForCart=251; Path=/");
        headers.append("set-cookie", "unrelated_secret=must-not-forward; Path=/");
        return new Response("redirect", { status: 301, headers });
      }
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      expect(cookie).toContain("PHPSESSID=exact-session");
      expect(cookie).toContain("ChoosenCityForCart=251");
      expect(cookie).not.toContain("unrelated_secret");
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover(KAGOCEL_FAMILY.brand, { ...CONTEXT, runId: "vita-cookie" }))
      .resolves.toMatchObject([{ listingId: KAGOCEL_FAMILY.id }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a different CollectionPage brand", familyPage({ aboutBrand: "Кагоцил" })],
    ["an incomplete review list", familyPage({ headingCount: 6, scores: [5, 5, 4, 5, 4] })],
    ["unknown per-review star markup", familyPage({ scores: [5, 5, 4, 5, 4, "unknown"] })]
  ])("fails the Kagocel family closed on %s", async (_case, html) => {
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchFamilyPage(html));
    await expect(adapter.discover(KAGOCEL_FAMILY.brand, { ...CONTEXT, runId: `bad-family-${_case}` }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("publishes only the proven empty-review contract and preserves absent rating as null", async () => {
    const evidence = new MemoryEvidenceStore();
    const product = productById("178185");
    const adapter = new VitaExpressAdapter(evidence, fetchProducts());

    const result = await adapter.collect(ref(product), { ...CONTEXT, runId: "collect-empty" });

    expect(result).toMatchObject({
      listingId: "178185",
      product: product.title,
      reviews: 0,
      writtenReviewCount: 0,
      rating: null,
      ratingCount: 0,
      status: "no_reviews"
    });
    expect(result).not.toHaveProperty("rawRating");
    expect(result.productEvidence).toMatchObject({
      scope: "listing",
      identifiers: [{ type: "product_id", value: "178185" }]
    });
    expect(evidence.items.size).toBe(1);
  });

  it("publishes a positive product-bound Baktoblis aggregate", async () => {
    const product = productById("175303");
    const reviews = Array.from({ length: 6 }, (_, index) => ({ name: `Покупатель ${index + 1}`, body: "Отзыв" }));
    const fetchMock = fetchProducts({
      [product.id]: new Response(page(product, {
        reviews: { productId: Number(product.id), reviewList: reviews },
        rating: [{ productId: product.id, status: true, rating: 4.9, reviewsCount: 6 }],
        emptyText: "Проверенные отзывы покупателей"
      }), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    });
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchMock);
    const refs = await adapter.discover("Бактоблис", { ...CONTEXT, runId: "positive-baktoblis" });
    const positiveRef = refs.find((item) => item.listingId === product.id)!;

    await expect(adapter.collect(positiveRef, { ...CONTEXT, runId: "positive-baktoblis" })).resolves.toMatchObject({
      listingId: "175303",
      reviews: 6,
      writtenReviewCount: 6,
      ratingCount: 6,
      rating: 4.9,
      status: "ok",
      source: "vitaexpress-source-bound-review-aggregate"
    });
  });

  it("reuses a proven exact page within one run without weakening identity checks", async () => {
    const product = productById("202806");
    const fetchMock = fetchProducts();
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchMock);
    const context = { ...CONTEXT, runId: "same-run" };

    const [discovered] = await adapter.discover(product.brand, context);
    await expect(adapter.collect(discovered, context)).resolves.toMatchObject({ listingId: product.id, reviews: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 498, 500, 502, 503])("keeps HTTP %s as an access block, never zero", async (status) => {
    const product = productById("178185");
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response("blocked", { status })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: `blocked-${status}` }))
      .rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("keeps a CAPTCHA-looking HTTP 200 page as blocked", async () => {
    const product = productById("178185");
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response("<html><input name='captcha'><h1>\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d</h1></html>", { status: 200 })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: "captcha" }))
      .rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it.each(["211589", "211590"])(
    "classifies Хлорэтта %s as review_channel_unavailable without producing zero",
    async (id) => {
      const product = productById(id);
      const evidence = new MemoryEvidenceStore();
      const adapter = new VitaExpressAdapter(evidence, fetchProducts({
        [product.id]: new Response(unavailableReviewPage(product), {
          status: 200, headers: { "content-type": "text/html; charset=utf-8" }
        })
      }));

      const error = await adapter.collect(ref(product), { ...CONTEXT, runId: `unavailable-${id}` })
        .then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(AdapterBlockedError);
      expect(error).toMatchObject({ code: "blocked" });
      expect((error as Error).message).toContain("review_channel_unavailable");
      expect(evidence.items.size).toBe(0);
    }
  );

  it.each([
    ["another product ID", { ID: 211590 }],
    ["another product name", { NAME: "Тирзетта таблетки 10 мг №4" }],
    ["APLAUT other than numeric zero", { APLAUT: "0" }],
    ["SHOW_REVIEW other than numeric one", { SHOW_REVIEW: 0 }]
  ])("does not classify a non-source-bound %s payload as review_channel_unavailable", async (_label, override) => {
    const product = productById("211589");
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(unavailableReviewPage(product, override), {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" }
      })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: `unavailable-invalid-${_label}` }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("checks canonical, h1 and page-content identity before the unavailable-channel payload", async () => {
    const product = productById("211589");
    const wrongPageIdentity = unavailableReviewPage(product).replace('data-id="211589"', 'data-id="211590"');
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(wrongPageIdentity, {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" }
      })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: "unavailable-wrong-page-identity" }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("rejects unknown markup instead of inferring zero from missing rating fields", async () => {
    const product = productById("178185");
    const html = page(product).replace(/<product-reviews[^]*?<\/product-reviews>/u, "<section>\u041e\u0442\u0437\u044b\u0432\u044b</section>");
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(html, { status: 200 })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: "unknown" }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("rejects a positive or contradictory aggregate even if stale empty text remains", async () => {
    const product = productById("178185");
    const contradictory = page(product, {
      rating: [{ productId: product.id, status: true, rating: 5, reviewsCount: 1 }]
    });
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(contradictory, { status: 200 })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: "contradictory" }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("rejects a missing visible first-review message", async () => {
    const product = productById("178185");
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(page(product, { emptyText: "\u041d\u0430\u043f\u0438\u0441\u0430\u0442\u044c \u043e\u0442\u0437\u044b\u0432" }), { status: 200 })
    }));

    await expect(adapter.collect(ref(product), { ...CONTEXT, runId: "no-empty-message" }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("rejects Taurin or Taufon analog identity for the Taustin registry card", async () => {
    const product = productById("203245");
    for (const analog of ["\u0422\u0430\u0443\u0440\u0438\u043d \u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435 4%, 10\u043c\u043b", "\u0422\u0430\u0443\u0444\u043e\u043d \u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435 4%, 10\u043c\u043b"]) {
      const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
        [product.id]: new Response(page(product, { title: analog }), { status: 200 })
      }));
      await expect(adapter.collect(ref(product), { ...CONTEXT, runId: `analog-${analog}` }))
        .rejects.toBeInstanceOf(ParserChangedError);
    }
  });

  it("fails the whole exact discovery when one expected Biviart identity changes", async () => {
    const changed = productById("193140");
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [changed.id]: new Response(page(changed, { pageId: "999999" }), { status: 200 })
    }));

    await expect(adapter.discover("\u0411\u0438\u0432\u0438\u0430\u0440\u0442", { ...CONTEXT, runId: "incomplete-biviart" }))
      .rejects.toBeInstanceOf(ParserChangedError);
  });

  it("does not claim completeness for brands outside the bounded registry", async () => {
    const adapter = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts());
    await expect(adapter.discover("\u0410\u043a\u0432\u0430\u041e\u043f\u0442\u0438\u043a", CONTEXT)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("reports parser and access failures distinctly from the health canary", async () => {
    const product = productById("178185");
    const parser = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response(page(product, { canonicalPath: "/product/another/" }), { status: 200 })
    }));
    await expect(parser.healthCheck({ ...CONTEXT, runId: "health-parser" })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("parser_changed")
    });

    const blocked = new VitaExpressAdapter(new MemoryEvidenceStore(), fetchProducts({
      [product.id]: new Response("Forbidden", { status: 503 })
    }));
    await expect(blocked.healthCheck({ ...CONTEXT, runId: "health-blocked" })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("blocked_free_mode")
    });
  });
});
