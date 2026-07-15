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

  it("derives the exact human Polza variant from a source-bound product URL", async () => {
    const family = "https://polza.ru/product/otsillokoktsinum/";
    const card = "https://polza.ru/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "polza.ru") return new Response(`<urlset><url><loc>${family}</loc></url></urlset>`);
      if (url.pathname.startsWith("/product/")) return new Response(translated(family, `
        <div class="catalog__block--cards"><div class="catalog-block__items"><div class="catalog-card" itemscope>
          <link itemprop="url" href="${card}"><meta itemprop="sku" content="20630">
          <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="1"><meta itemprop="ratingValue" content="5"></span>
        </div></div></div>`), { headers: { "content-type": "text/html" } });
      if (url.pathname.includes("_20630")) return new Response(translated(card, `
        <main itemscope><meta itemprop="sku" content="20630"><div itemprop="aggregateRating">
          <meta itemprop="reviewCount" content="1"><meta itemprop="ratingValue" content="5">
        </div></main>`), { headers: { "content-type": "text/html" } });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new PolzaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", { region: "Москва" });
    expect(refs).toMatchObject([{ listingId: "20630", title: "Оциллококцинум гранулы 1 г 6 доз" }]);
    const result = await adapter.collect(refs[0], { region: "Москва" });
    expect(result).toMatchObject({ product: "Оциллококцинум гранулы 1 г 6 доз", reviews: 1, rating: 5 });
    expect(analyzeProductIdentity({
      brand: result.brand,
      product: result.product,
      url: result.canonicalUrl,
      evidence: result.productEvidence
    })).toMatchObject({ label: "гранулы 1 г №6", granularity: "variant", confidence: "exact" });
  });

  it("does not let a transient unrelated Polza renderer canary block an exact requested family", async () => {
    const kagocel = "https://polza.ru/product/kagocel/";
    const family = "https://polza.ru/product/otsillokoktsinum/";
    const card = "https://polza.ru/catalog/otsillokoktsinum-granuly-1-g-6-doz_20630/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "polza.ru" && url.pathname === "/sitemap-iblock-33.xml") {
        return new Response(`<urlset><url><loc>${kagocel}</loc></url><url><loc>${family}</loc></url></urlset>`);
      }
      if (url.hostname === "polza-ru.translate.goog" && url.pathname === "/product/kagocel/") {
        return new Response("temporary renderer failure", { status: 502, headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "polza-ru.translate.goog" && url.pathname === "/product/otsillokoktsinum/") {
        return new Response(translated(family, `
          <div class="catalog__block--cards"><div class="catalog-block__items"><div class="catalog-card" itemscope>
            <link itemprop="url" href="${card}"><meta itemprop="sku" content="20630">
            <meta itemprop="name" content="Оциллококцинум, гранулы 1 г, 6 доз">
            <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="1"><meta itemprop="ratingValue" content="5"></span>
          </div></div></div>`), { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "polza-ru.translate.goog" && url.pathname.includes("_20630")) {
        return new Response(translated(card, `
          <main itemscope><meta itemprop="sku" content="20630"><div itemprop="aggregateRating">
            <meta itemprop="reviewCount" content="1"><meta itemprop="ratingValue" content="5">
          </div></main>`), { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new PolzaAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.healthCheck({ region: "Москва" })).resolves.toMatchObject({ ok: true });
    const refs = await adapter.discover("Оциллококцинум", { region: "Москва" });
    expect(refs).toMatchObject([{ listingId: "20630", url: card }]);
    await expect(adapter.collect(refs[0], { region: "Москва" })).resolves.toMatchObject({
      listingId: "20630", reviews: 1, rating: 5, status: "ok"
    });
  });

  it("keeps Polza health fail-closed when a parser change is not a transient access block", async () => {
    const fetchMock = vi.fn(async () => new Response(translated("https://polza.ru/product/kagocel/", "<main></main>"), {
      headers: { "content-type": "text/html" }
    })) as unknown as typeof fetch;
    const adapter = new PolzaAdapter(new MemoryEvidenceStore(), fetchMock);

    const health = await adapter.healthCheck({ region: "Москва" });

    expect(health).toMatchObject({ ok: false, message: "polza.ru canary has no exact aggregate card" });
    expect(fetchMock).toHaveBeenCalledOnce();
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

    const refs = await adapter.discover("Оциллококцинум", {
      region: "Москва",
      previousRefs: [
        { listingId: "9533", url: cards[0] },
        { listingId: "9534", url: cards[1] },
        { listingId: "bed61415fd1fce6b6369", url: cards[1] }
      ]
    });
    expect(refs.map((item) => item.listingId).sort()).toEqual(["9533", "9534", "9535"]);
    expect(refs.some((item) => item.listingId === "bed61415fd1fce6b6369")).toBe(false);
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
        label: `гранулы 1 г №${ref.url.match(/_n(\d+)_/)?.[1]}`,
        granularity: "variant",
        confidence: "exact"
      });
    }
  });

  it("keeps a historical-only ASNA URL fail-closed while replacing a current legacy hash", async () => {
    const current = "https://www.asna.ru/cards/otsillokoktsinum_1_doza_n12_granuly_gomeopaticheskie_laboratoires_boiron.html";
    const historical = "https://www.asna.ru/cards/otsillokoktsinum_1_doza_n60_granuly_gomeopaticheskie_laboratoires_boiron.html";
    const currentHash = "bed61415fd1fce6b6369";
    const historicalHash = "a458c3011df2e97eca10";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards.xml")) {
        return new Response(`<urlset><url><loc>${current}</loc></url></urlset>`);
      }
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards1.xml")) {
        return new Response("<urlset></urlset>");
      }
      if (url.hostname === "www-asna-ru.translate.goog") {
        const source = `https://www.asna.ru${url.pathname}`;
        return new Response(asnaCard(source, url.pathname.includes("_n12_") ? "9533" : "9999", 4), {
          headers: { "content-type": "text/html" }
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const adapter = new AsnaAdapter(new MemoryEvidenceStore(), fetchMock);

    const refs = await adapter.discover("Оциллококцинум", {
      region: "Москва",
      previousRefs: [
        { listingId: currentHash, url: current },
        { listingId: historicalHash, url: historical }
      ]
    });

    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["9533", historicalHash].sort());
    expect(refs.some((ref) => ref.listingId === currentHash)).toBe(false);
    const historicalRef = refs.find((ref) => ref.listingId === historicalHash)!;
    await expect(adapter.collect(historicalRef, { region: "Москва" })).rejects.toThrow(
      `asna.ru:${historicalHash}: product identity or aggregate changed`
    );
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

  it("discovers Cyrillic Х brands when first-party slugs use kh", async () => {
    const polzaFamilyUrl = "https://polza.ru/product/khondrofen/";
    const polzaProductUrl = "https://polza.ru/catalog/khondrofen-maz-30-g_53076/";
    const asnaUrl = "https://www.asna.ru/cards/khondrofen_30g_maz_biosintez.html";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "polza.ru") return new Response(`<urlset><url><loc>${polzaFamilyUrl}</loc></url></urlset>`);
      if (url.hostname === "polza-ru.translate.goog" && url.pathname === "/product/khondrofen/") {
        return new Response(translated(polzaFamilyUrl, `<div class="catalog__block--cards"><div class="catalog-block__items">
          <div class="catalog-card" itemscope><link itemprop="url" href="${polzaProductUrl}"><meta itemprop="sku" content="53076">
          <span itemprop="aggregateRating"><meta itemprop="reviewCount" content="3"><meta itemprop="ratingValue" content="5"></span></div>
        </div></div>`), { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "polza-ru.translate.goog" && url.pathname.includes("_53076")) {
        return new Response(translated(polzaProductUrl, `<main itemscope><meta itemprop="sku" content="53076">
          <div itemprop="aggregateRating"><meta itemprop="reviewCount" content="3"><meta itemprop="ratingValue" content="5"></div>
        </main>`), { headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "www.asna.ru" && url.pathname.endsWith("sitemap_cards.xml")) {
        return new Response(`<urlset><url><loc>${asnaUrl}</loc></url></urlset>`);
      }
      if (url.hostname === "www.asna.ru") return new Response("<urlset></urlset>");
      if (url.hostname === "www-asna-ru.translate.goog") {
        return new Response(asnaCard(asnaUrl, "519674", 5), { headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const polza = new PolzaAdapter(new MemoryEvidenceStore(), fetchMock);
    const polzaRefs = await polza.discover("Хондрофен", { region: "Москва" });
    expect(polzaRefs).toMatchObject([{ listingId: "53076", url: polzaProductUrl, title: "Хондрофен мазь 30 г" }]);
    const polzaResult = await polza.collect(polzaRefs[0], { region: "Москва" });
    expect(polzaResult).toMatchObject({
      product: "Хондрофен мазь 30 г", reviews: 3, rating: 5, status: "ok"
    });
    expect(analyzeProductIdentity({
      brand: polzaResult.brand,
      product: polzaResult.product,
      url: polzaResult.canonicalUrl,
      evidence: polzaResult.productEvidence
    })).toMatchObject({ label: "мазь 30 г", granularity: "variant", confidence: "exact" });
    await expect(new AsnaAdapter(new MemoryEvidenceStore(), fetchMock).discover("Хондрофен", { region: "Москва" }))
      .resolves.toMatchObject([{ listingId: "519674", url: asnaUrl }]);
  });
});
