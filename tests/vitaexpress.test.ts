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
  }
] as const;

type TestProduct = typeof PRODUCTS[number];

function escapeAttribute(value: unknown): string {
  return JSON.stringify(value).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function page(product: TestProduct, options: {
  title?: string;
  canonicalPath?: string;
  pageId?: string;
  reviews?: unknown;
  rating?: unknown;
  emptyText?: string;
} = {}): string {
  const title = options.title ?? product.title;
  const pageId = options.pageId ?? product.id;
  const canonicalPath = options.canonicalPath ?? product.path;
  const reviews = options.reviews ?? { productId: Number(product.id), reviewList: null };
  const rating = options.rating ?? [{ productId: product.id, status: true, rating: 0, reviewsCount: 0 }];
  const emptyText = options.emptyText ?? "\u0412\u0430\u0448 \u043e\u0442\u0437\u044b\u0432 \u043e \u0442\u043e\u0432\u0430\u0440\u0435 \u0441\u0442\u0430\u043d\u0435\u0442 \u043f\u0435\u0440\u0432\u044b\u043c! \u041f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430, \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0443\u0439\u0442\u0435\u0441\u044c.";
  return `<!doctype html><html><head><link rel="canonical" href="${ORIGIN}${canonicalPath}"></head><body>
    <h1>${title}</h1>
    <div id="page-content" data-id="${pageId}" data-xml="${pageId}" data-xml_id="${pageId}"
      data-url="${canonicalPath}" data-name="${title}">
      <product-reviews :id="${pageId}" :product-id="${pageId}" name="${title}"
        :reviews="${escapeAttribute(reviews)}" :rating="${escapeAttribute(rating)}">
        <h2>\u041e\u0442\u0437\u044b\u0432\u044b \u043e \u0442\u043e\u0432\u0430\u0440\u0435 ${title}</h2>
        <div>${emptyText}</div>
      </product-reviews>
    </div>
  </body></html>`;
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

