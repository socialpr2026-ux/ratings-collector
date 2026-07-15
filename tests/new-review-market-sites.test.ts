import { describe, expect, it, vi } from "vitest";
import { MedOtzyvAdapter } from "../src/server/adapters/med-otzyv.js";
import { MegamarketAdapter } from "../src/server/adapters/megamarket.js";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import { analyzeProductIdentity } from "../src/server/utils/product-name.js";
import { hasDeterministicAggregateProof } from "../src/shared/review-aggregates.js";

const context = { region: "Москва" };

function megaSearch(source: string): string {
  return `<!doctype html><html><head><base href="${source}"></head><body>
    <div data-test="product-item" data-product-id="100024501619_68334">
      <a data-test="product-name-link" title="Оциллококцинум гранулы 1 г 12 шт."
        href="https://megamarket-ru.translate.goog/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619_68334/">товар</a>
    </div>
    <div data-test="product-item" data-product-id="100024501619_5678">
      <a data-test="product-name-link" title="Оциллококцинум гранулы 1 г 12 шт."
        href="https://megamarket-ru.translate.goog/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619_5678/">другой продавец</a>
    </div>
    <div data-test="product-item" data-product-id="999999999999_1">
      <a data-test="product-name-link" title="Коробка для Оциллококцинума"
        href="https://megamarket-ru.translate.goog/catalog/details/korobka-999999999999_1/">нерелевантно</a>
    </div>
    <button class="pui-pagination-control pui-pagination-control_selected">1</button>
  </body></html>`;
}

function megaProduct(source: string, sku = "100024501619", title = "Оциллококцинум гранулы 1 г 12 шт."): string {
  return `<!doctype html><html><head><base href="${source}"></head><body>
    <main itemscope itemtype="http://schema.org/Product">
      <meta itemprop="sku" content="${sku}"><h1 itemprop="name">${title}</h1>
    </main>
    <script>window.__APP__={cfg:{experimentValue:e=>e},state:{ProductStore:{"reviewInfo":{
      "reviewsCount":24,"mainReviews":[{"rating":5},{"rating":1}],"reviewsStats":[{"rating":5,"count":23}],"rating":4.8
    },"productRelatedCategories":{}}}}</script>
  </body></html>`;
}

describe("Megamarket translated SSR adapter", () => {
  it("deduplicates seller offers by goods id and collects the product review aggregate", async () => {
    const sourceSearch = "https://megamarket.ru/catalog/?q=%D0%9E%D1%86%D0%B8%D0%BB%D0%BB%D0%BE%D0%BA%D0%BE%D0%BA%D1%86%D0%B8%D0%BD%D1%83%D0%BC";
    const productSource = "https://megamarket.ru/catalog/details/ocillokokcinum-granuly-1-g-1-doz-12-sht-100024501619/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/catalog/") return new Response(megaSearch(sourceSearch), { headers: { "content-type": "text/html" } });
      if (url.pathname.includes("100024501619")) return new Response(megaProduct(productSource), { headers: { "content-type": "text/html" } });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new MegamarketAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      listingId: "100024501619",
      url: productSource,
      title: "Оциллококцинум гранулы 1 г 12 шт."
    });

    const observation = await adapter.collect(refs[0], context);
    expect(observation).toMatchObject({
      domain: "megamarket.ru",
      listingId: "100024501619",
      reviews: 24,
      rating: 4.8,
      ratingCount: 24,
      status: "ok",
      source: "megamarket-product-reviewInfo-translated-ssr"
    });
  });

  it("fails closed when reviewInfo belongs to an incomplete or changed product page", async () => {
    const source = "https://megamarket.ru/catalog/details/ocillokokcinum-100024501619/";
    const incomplete = megaProduct(source).replace('"reviewsCount":24', '"reviewsTotal":24');
    const adapter = new MegamarketAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(incomplete, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "megamarket.ru", platform: "megamarket.ru", listingId: "100024501619",
      brand: "Оциллококцинум", url: source, metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });
});

describe("Med-otzyv exact indexed adapter", () => {
  const result = `<!doctype html><html><body>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmed-otzyv.ru%2Flekarstva%2F157-o%2F34740-otsillokoktsinum">
      Оциллококцинум - 42 отзыва врачей и пациентов
    </a>
    <a class="result__a" href="https://med-otzyv.ru/lekarstva/157-o/91800-oseltamivir">
      Осельтамивир - 13 отзывов врачей и пациентов
    </a>
  </body></html>`;

  it("binds the exact medicine id and publishes the count with an explicitly unavailable rating", async () => {
    const adapter = new MedOtzyvAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(result, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    const refs = await adapter.discover("Оциллококцинум", context);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "34740", metadata: { reviewCount: 42 } });

    const observation = await adapter.collect(refs[0]);
    expect(observation).toMatchObject({
      domain: "med-otzyv.ru",
      listingId: "34740",
      product: "Оциллококцинум",
      reviews: 42,
      rating: null,
      rawRating: null,
      ratingUnavailable: true,
      status: "ok"
    });
    observation.productIdentity = analyzeProductIdentity(observation);
    expect(hasDeterministicAggregateProof(observation)).toBe(true);
  });

  it("publishes Khondrofen feedback for stable id 751 without inventing a rating or manual gate", async () => {
    const khondrofenResult = `<!doctype html><html><body>
      <a class="result__a" href="https://med-otzyv.ru/lekarstva/143-kh/751-khondrofen">
        Хондрофен - 1 отзыв врачей и пациентов
      </a>
    </body></html>`;
    const adapter = new MedOtzyvAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(khondrofenResult, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);

    const [ref] = await adapter.discover("Хондрофен", context);
    const observation = await adapter.collect(ref);
    observation.productIdentity = analyzeProductIdentity(observation);

    expect(observation).toMatchObject({
      domain: "med-otzyv.ru",
      listingId: "751",
      product: "Хондрофен",
      reviews: 1,
      rating: null,
      rawRating: null,
      ratingUnavailable: true,
      status: "ok"
    });
    expect(hasDeterministicAggregateProof(observation)).toBe(true);
  });

  it("does not turn an empty or unrelated external index into no_results", async () => {
    const adapter = new MedOtzyvAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response("<html><body>No results found</body></html>")) as unknown as typeof fetch);
    await expect(adapter.discover("Оциллококцинум", context)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("refreshes the verified Cereton route from the exact source page when the index misses it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/__external_search__") return new Response("missing", { status: 502 });
      if (url.pathname === "/lekarstva/165-c/36138-tsereton") return new Response(`
        <html><head><link rel="canonical" href="${url.toString()}"></head><body>
          <h1>Церетон</h1><meta itemprop="reviewCount" content="49">
        </body></html>`, { headers: { "content-type": "text/html" } });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new MedOtzyvAdapter(new MemoryEvidenceStore(), fetchMock);

    const [ref] = await adapter.discover("Церетон", context);
    const observation = await adapter.collect(ref, context);

    expect(ref).toMatchObject({ listingId: "36138", metadata: { source: "med-otzyv-verified-route" } });
    expect(observation).toMatchObject({
      listingId: "36138", product: "Церетон", reviews: 49, rating: null,
      ratingUnavailable: true, status: "ok", source: "med-otzyv-source-page"
    });
  });
});
