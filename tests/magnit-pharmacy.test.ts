import { describe, expect, it, vi } from "vitest";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { MagnitPharmacyAdapter } from "../src/server/adapters/magnit-pharmacy.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const ORIGIN = "https://apteka.magnit.ru";
const PRODUCT_SITEMAP = `${ORIGIN}/sitemap-parts/products-0.xml`;
const STORE = "shop_group_location_1_distr";
const CONTEXT = { region: "\u041c\u043e\u0441\u043a\u0432\u0430", runId: "magnit-test" };

const products = [
  {
    id: "1000507431",
    slug: "biviart_komfort_rastvor_uvlazh_oftalm_s_prob_kapeln_10ml_1",
    name: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442 \u041a\u043e\u043c\u0444\u043e\u0440\u0442 \u0440\u0430\u0441\u0442\u0432\u043e\u0440 \u0443\u0432\u043b\u0430\u0436\u043d\u044f\u044e\u0449\u0438\u0439 \u043e\u0444\u0442\u0430\u043b\u044c\u043c\u043e\u043b\u043e\u0433\u0438\u0447\u0435\u0441\u043a\u0438\u0439 10\u043c\u043b",
    ratings: { commentsCount: 0, external: null, rating: 5, scoresCount: 1 }
  },
  {
    id: "1000509450",
    slug: "biviart_soft_rastovor_uvlazhnyayushchiy_oftalmolog_10ml_flak_s_probkoy_kapelnitsey_kryshkoy",
    name: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442 \u0421\u043e\u0444\u0442 \u0440\u0430\u0441\u0442\u0432\u043e\u0440 \u0443\u0432\u043b\u0430\u0436\u043d\u044f\u044e\u0449\u0438\u0439 \u043e\u0444\u0442\u0430\u043b\u044c\u043c\u043e\u043b\u043e\u0433\u0438\u0447\u0435\u0441\u043a\u0438\u0439 10\u043c\u043b",
    ratings: { commentsCount: 1, external: null, rating: 5, scoresCount: 1 }
  },
  {
    id: "1000510348",
    slug: "biviart_ultra_rastvor_uvlazhnyayushchiy_oftalmolog_10ml_flak_s_probkoy_kapelnitsey_kryshkoy",
    name: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442 \u0423\u043b\u044c\u0442\u0440\u0430 \u0440\u0430\u0441\u0442\u0432\u043e\u0440 \u043e\u0444\u0442\u0430\u043b\u044c\u043c\u043e\u043b\u043e\u0433\u0438\u0447\u0435\u0441\u043a\u0438\u0439 10\u043c\u043b",
    ratings: null
  },
  {
    id: "1000341873",
    slug: "rastvor_1_20ml_kartonnaya_upakovka_groteks_ooo",
    name: "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d \u0440\u0430\u0441\u0442\u0432\u043e\u0440 \u0434\u043b\u044f \u043f\u0440\u043e\u043c\u044b\u0432\u0430\u043d\u0438\u044f \u0433\u043b\u0430\u0437 3% 2\u043c\u043b 10\u0448\u0442",
    ratings: { commentsCount: 0, external: null, rating: 4.3, scoresCount: 2 }
  },
  {
    id: "1000441301",
    slug: "oftarint_kapli_glaznye_flakon_kapelnitsy_10ml_groteks",
    name: "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442 \u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435 10\u043c\u043b",
    ratings: { commentsCount: 2, external: null, rating: 5, scoresCount: 8 }
  },
  {
    id: "1000273881",
    slug: "taustin_taurin_kapli_glaznye_4_10ml",
    name: "\u0422\u0430\u0443\u0441\u0442\u0438\u043d \u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435 4% 10\u043c\u043b",
    ratings: { commentsCount: 1, external: null, rating: 5, scoresCount: 38 }
  }
] as const;

const productUrls = products.map((product) => `${ORIGIN}/product/${product.id}-${product.slug}`);
const fillerUrls = Array.from({ length: 15_000 - products.length }, (_value, index) =>
  `${ORIGIN}/product/${8000000000 + index}-fixture_product_${index}`
);
const COMPLETE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    ${[...fillerUrls, ...productUrls].map((url) => `<url><loc>${url}</loc></url>`).join("")}
  </urlset>`;
const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
  <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>${PRODUCT_SITEMAP}</loc></sitemap>
  </sitemapindex>`;

function productApi(id: string): string {
  return `${ORIGIN}/webgate/v2/goods/${id}/stores/${STORE}?storetype=apteka&catalogtype=3`;
}

function productPayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const product = products.find((item) => item.id === id);
  if (!product) throw new Error(`unknown fixture ${id}`);
  return {
    id,
    name: product.name,
    seoCode: product.slug,
    storeCode: STORE,
    isMissing: false,
    ratings: product.ratings,
    ...overrides
  };
}

function requestedUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function liveContractFetch(overrides: Record<string, Response> = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (overrides[url]) return overrides[url];
    if (url === `${ORIGIN}/sitemap_index.xml`) return new Response(SITEMAP_INDEX, { status: 200 });
    if (url === PRODUCT_SITEMAP) return new Response(COMPLETE_SITEMAP, { status: 200 });
    const id = new URL(url).pathname.match(/^\/webgate\/v2\/goods\/(\d+)\/stores\//u)?.[1];
    if (id && products.some((product) => product.id === id)) {
      return new Response(JSON.stringify(productPayload(id)), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
}

function ref(id: string, brand: string) {
  const product = products.find((item) => item.id === id)!;
  return {
    domain: "apteka.magnit.ru",
    platform: "apteka.magnit.ru",
    listingId: id,
    brand,
    url: `${ORIGIN}/product/${id}-${product.slug}`,
    title: product.name,
    metadata: { sitemapUrl: PRODUCT_SITEMAP }
  };
}

describe("MagnitPharmacyAdapter", () => {
  it("discovers the complete exact 3/1/1/1 brand set, including Okusalin's legacy unbranded slug", async () => {
    const fetchMock = liveContractFetch();
    const adapter = new MagnitPharmacyAdapter(new MemoryEvidenceStore(), fetchMock);

    const [biviart, okusalin, oftarint, taustin] = await Promise.all([
      adapter.discover("\u0411\u0438\u0432\u0438\u0430\u0440\u0442", CONTEXT),
      adapter.discover("\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d", CONTEXT),
      adapter.discover("\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442", CONTEXT),
      adapter.discover("\u0422\u0430\u0443\u0441\u0442\u0438\u043d", CONTEXT)
    ]);

    expect(biviart.map((item) => item.listingId).sort()).toEqual(["1000507431", "1000509450", "1000510348"]);
    expect(okusalin).toHaveLength(1);
    expect(okusalin[0]).toMatchObject({
      listingId: "1000341873",
      url: `${ORIGIN}/product/1000341873-rastvor_1_20ml_kartonnaya_upakovka_groteks_ooo`
    });
    expect(oftarint.map((item) => item.listingId)).toEqual(["1000441301"]);
    expect(taustin.map((item) => item.listingId)).toEqual(["1000273881"]);
  });

  it("maps scores to unified feedback while preserving written comments separately", async () => {
    const evidence = new MemoryEvidenceStore();
    const adapter = new MagnitPharmacyAdapter(evidence, liveContractFetch());

    const observation = await adapter.collect(ref("1000441301", "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442"), CONTEXT);

    expect(observation).toMatchObject({
      listingId: "1000441301",
      reviews: 8,
      writtenReviewCount: 2,
      ratingCount: 8,
      rating: 5,
      status: "ok",
      source: "magnit-pharmacy-first-party-api"
    });
    expect(observation.productEvidence?.identifiers).toContainEqual({ type: "product_id", value: "1000441301" });
    expect(evidence.items.size).toBe(1);
  });

  it("keeps a missing exact-card aggregate blocked instead of inventing zero", async () => {
    const observation = await new MagnitPharmacyAdapter(new MemoryEvidenceStore(), liveContractFetch()).collect(
      ref("1000510348", "\u0411\u0438\u0432\u0438\u0430\u0440\u0442"), CONTEXT
    );

    expect(observation).toMatchObject({
      listingId: "1000510348",
      reviews: null,
      writtenReviewCount: null,
      ratingCount: null,
      rating: null,
      status: "parser_changed",
      source: "magnit-pharmacy-first-party-api:no-product-aggregate"
    });
  });

  it("accepts zero only when scoresCount and commentsCount explicitly prove it", async () => {
    const id = "1000507431";
    const fetchMock = liveContractFetch({
      [productApi(id)]: new Response(JSON.stringify(productPayload(id, {
        ratings: { commentsCount: 0, external: null, rating: null, scoresCount: 0 }
      })), { status: 200 })
    });

    const observation = await new MagnitPharmacyAdapter(new MemoryEvidenceStore(), fetchMock).collect(
      ref(id, "\u0411\u0438\u0432\u0438\u0430\u0440\u0442"), CONTEXT
    );

    expect(observation).toMatchObject({ reviews: 0, writtenReviewCount: 0, ratingCount: 0, rating: null, status: "no_reviews" });
  });

  it("rejects external/store metrics and contradictory count aggregates", async () => {
    const id = "1000341873";
    for (const ratings of [
      { commentsCount: 0, external: true, rating: 4.3, scoresCount: 2 },
      { commentsCount: 3, external: null, rating: 4.3, scoresCount: 2 }
    ]) {
      const fetchMock = liveContractFetch({
        [productApi(id)]: new Response(JSON.stringify(productPayload(id, { ratings })), { status: 200 })
      });
      const result = await new MagnitPharmacyAdapter(new MemoryEvidenceStore(), fetchMock).collect(
        ref(id, "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d"), CONTEXT
      );
      expect(result).toMatchObject({ reviews: null, rating: null, status: "parser_changed" });
    }
  });

  it("fails closed when the product sitemap is structurally complete but too small", async () => {
    const shortSitemap = `<?xml version="1.0"?><urlset>${productUrls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
    const fetchMock = liveContractFetch({ [PRODUCT_SITEMAP]: new Response(shortSitemap, { status: 200 }) });
    const adapter = new MagnitPharmacyAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.discover("\u0422\u0430\u0443\u0441\u0442\u0438\u043d", CONTEXT)).rejects.toBeInstanceOf(ParserChangedError);
    await expect(adapter.healthCheck(CONTEXT)).resolves.toMatchObject({ ok: false });
  });

  it("rejects wrong product identity and never accepts recommendation data", async () => {
    const id = "1000273881";
    const fetchMock = liveContractFetch({
      [productApi(id)]: new Response(JSON.stringify(productPayload(id, {
        name: "\u0422\u0430\u0443\u0444\u043e\u043d \u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435",
        recommendations: [{ name: "\u0422\u0430\u0443\u0441\u0442\u0438\u043d", ratings: { rating: 5, scoresCount: 999 } }]
      })), { status: 200 })
    });

    await expect(new MagnitPharmacyAdapter(new MemoryEvidenceStore(), fetchMock).collect(
      ref(id, "\u0422\u0430\u0443\u0441\u0442\u0438\u043d"), CONTEXT
    )).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("classifies access blocks, throttling and server errors as blocked rather than zero", async () => {
    for (const status of [401, 403, 429, 498, 502]) {
      const id = "1000273881";
      const fetchMock = liveContractFetch({ [productApi(id)]: new Response("blocked", { status }) });
      await expect(new MagnitPharmacyAdapter(new MemoryEvidenceStore(), fetchMock).collect(
        ref(id, "\u0422\u0430\u0443\u0441\u0442\u0438\u043d"), CONTEXT
      )).rejects.toBeInstanceOf(AdapterBlockedError);
    }
  });

  it("reports a healthy canary only after both the complete sitemap and product API pass", async () => {
    const health = await new MagnitPharmacyAdapter(new MemoryEvidenceStore(), liveContractFetch()).healthCheck(CONTEXT);
    expect(health).toMatchObject({
      ok: true,
      message: "apteka.magnit.ru: complete sitemap and source-bound product API are healthy"
    });
  });
});

