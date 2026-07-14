import { describe, expect, it, vi } from "vitest";
import { AsnaAdapter, PolzaAdapter } from "../src/server/adapters/pharmacy-recovery.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";
import { analyzeProductIdentity } from "../src/server/utils/product-name.js";

function translated(source: string, body: string): string {
  return `<html><head><base href="${source}"></head><body><script data-source-url="${source}"></script>${body}</body></html>`;
}

function polzaFamily(source: string): string {
  return translated(source, `
    <div class="catalog__block catalog__block--cards"><div class="catalog-block__items">
      <div class="catalog-card" itemscope itemtype="https://schema.org/Product">
        <link itemprop="url" href="/catalog/kagotsel-tabletki-12-mg-10-sht_6853/">
        <meta itemprop="sku" content="6853">
        <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="5"><meta itemprop="ratingValue" content="5"></span>
      </div>
      <div class="catalog-card" itemscope itemtype="https://schema.org/Product">
        <link itemprop="url" href="/catalog/ingavirin-kapsuly-90-mg-10-sht_6841/">
        <meta itemprop="sku" content="6841">
        <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="50"><meta itemprop="ratingValue" content="4.8"></span>
      </div>
    </div></div>
  `);
}

function polzaCard(source: string): string {
  return translated(source, `
    <main itemscope itemtype="https://schema.org/Product">
      <meta itemprop="sku" content="6853">
      <div itemprop="aggregateRating" itemscope>
        <meta itemprop="reviewCount" content="5"><meta itemprop="ratingValue" content="5">
      </div>
    </main>
  `);
}

function asnaCard(source: string, sku: string, reviews: number): string {
  return translated(source, `
    <link rel="canonical" href="${source}">
    <div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">
      <meta itemprop="sku" content="${sku}">
      <div itemprop="aggregateRating" itemscope>
        <meta itemprop="ratingValue" content="5"><meta itemprop="reviewCount" content="${reviews}">
      </div>
    </div>
  `);
}

describe("recovered first-party pharmacy adapters", () => {
  it("discovers only exact Polza family cards and collects the product aggregate", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "polza.ru" && url.pathname === "/sitemap-iblock-33.xml") {
        return new Response(`<urlset><url><loc>https://polza.ru/product/kagocel/</loc></url><url><loc>https://polza.ru/product/ingavirin/</loc></url></urlset>`);
      }
      if (url.hostname === "polza-ru.translate.goog" && url.pathname === "/product/kagocel/") {
        return new Response(polzaFamily("https://polza.ru/product/kagocel/"), { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "polza-ru.translate.goog" && url.pathname.includes("kagotsel-tabletki")) {
        return new Response(polzaCard("https://polza.ru/catalog/kagotsel-tabletki-12-mg-10-sht_6853/"), { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const evidence = new MemoryEvidenceStore();
    const adapter = new PolzaAdapter(evidence, fetchMock);

    const refs = await adapter.discover("Кагоцел", { region: "Москва" });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ listingId: "6853", url: "https://polza.ru/catalog/kagotsel-tabletki-12-mg-10-sht_6853/" });

    const result = await adapter.collect(refs[0], { region: "Москва" });
    expect(result).toMatchObject({ listingId: "6853", reviews: 5, rating: 5, status: "ok", source: "polza-product-microdata:google-translate" });
    expect(result.productEvidence?.identifiers).toContainEqual({ type: "product_id", value: "6853" });
  });

  it("discovers current ASNA card URLs from both bounded card sitemaps and verifies every aggregate", async () => {
    const card10 = "https://www.asna.ru/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html";
    const card20 = "https://www.asna.ru/cards/kagotsel_12mg_n20_tab_niarmedik_plyus_ooo.html";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards.xml")) {
        return new Response(`<urlset><url><loc>${card10}</loc></url></urlset>`);
      }
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards1.xml")) {
        return new Response(`<urlset><url><loc>${card20}</loc></url></urlset>`);
      }
      if (url.hostname === "www-asna-ru.translate.goog" && url.pathname.includes("_n10_")) {
        return new Response(asnaCard(card10, "14666", 29), { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "www-asna-ru.translate.goog" && url.pathname.includes("_n20_")) {
        return new Response(asnaCard(card20, "637006057", 17), { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new AsnaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Кагоцел", { region: "Москва" });
    expect(refs.map((item) => item.listingId).sort()).toEqual(["14666", "637006057"]);
    expect(refs.find((item) => item.listingId === "14666")?.title).toBe("Кагоцел 12 мг №10 таблетки");
    const result = await adapter.collect(refs[0], { region: "Москва" });
    expect(result).toMatchObject({ product: "Кагоцел 12 мг №10 таблетки", reviews: 29, rating: 5, status: "ok", source: "asna-product-microdata:google-translate" });
  });

  it("derives exact human Oscillococcinum variants from ASNA card slugs", async () => {
    const cards = [6, 12, 30].map((count) =>
      `https://www.asna.ru/cards/otsillokoktsinum_1_doza_n${count}_granuly_gomeopaticheskie_laboratoires_boiron.html`
    );
    const ids = new Map(cards.map((card, index) => [new URL(card).pathname, String(9533 + index)]));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards.xml")) {
        return new Response(`<urlset>${cards.map((card) => `<url><loc>${card}</loc></url>`).join("")}</urlset>`);
      }
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards1.xml")) {
        return new Response("<urlset></urlset>");
      }
      if (url.hostname === "www-asna-ru.translate.goog") {
        const source = `https://www.asna.ru${url.pathname}`;
        return new Response(asnaCard(source, ids.get(url.pathname)!, 4), { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new AsnaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", { region: "Москва" });
    expect(refs.map((item) => item.title).sort()).toEqual([
      "Оциллококцинум гранулы гомеопатические 1 доза №12",
      "Оциллококцинум гранулы гомеопатические 1 доза №30",
      "Оциллококцинум гранулы гомеопатические 1 доза №6"
    ]);
    for (const ref of refs) {
      const result = await adapter.collect(ref, { region: "Москва" });
      expect(analyzeProductIdentity({
        brand: result.brand,
        product: result.product,
        url: result.canonicalUrl,
        evidence: result.productEvidence
      })).toMatchObject({
        label: `гранулы гомеопатические №${ref.url.match(/_n(\d+)_/)?.[1]}`,
        granularity: "variant",
        confidence: "exact"
      });
    }
  });

  it("fails closed when translated aggregate proof is incomplete", async () => {
    const card = "https://www.asna.ru/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html";
    const fetchMock = vi.fn(async () => new Response(translated(card, `
      <link rel="canonical" href="${card}">
      <div class="productPage__content product__item" itemscope><meta itemprop="sku" content="14666">
        <div itemprop="aggregateRating"><meta itemprop="reviewCount" content="29"></div>
      </div>`), { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const adapter = new AsnaAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.collect({
      domain: "asna.ru", platform: "asna.ru", listingId: "14666", brand: "Кагоцел", url: card, metadata: {}
    }, { region: "Москва" })).rejects.toThrow(/identity or aggregate changed/);
  });
});
