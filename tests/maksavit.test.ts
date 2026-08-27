import { describe, expect, it, vi } from "vitest";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { MaksavitAdapter } from "../src/server/adapters/maksavit.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const ORIGIN = "https://maksavit.ru";
const CONTEXT = { region: "Москва", runId: "maksavit-test" };
const liveIt = process.env.MAKSAVIT_LIVE === "1" ? it : it.skip;
const PRODUCTS = new Map([
  ["854959", "БИВИАРТ КОМФОРТ ГРОТЕКС р-р офтальмологич. фл.- кап. 0,18% 10 мл"],
  ["854538", "БИВИАРТ УЛЬТРА ГРОТЕКС р-р офтальмологич. фл.- кап. 0,3% 10 мл"],
  ["945500", "БИВИАРТ ИНТЕНСИВ ГРОТЕКС р-р офтальмологич. фл.- кап. 10 мл"],
  ["854961", "БИВИАРТ СОФТ ГРОТЕКС р-р офтальмологич. фл.- кап. 0,1% 10 мл"],
  ["2337", "КАГОЦЕЛ табл. 12 мг №10"],
  ["128266", "КАГОЦЕЛ табл. 12 мг №20"],
  ["512741", "КАГОЦЕЛ табл. 12 мг №30"],
  ["142672", "ОКУСАЛИН р-р офтальмологич. амп. пласт. 3% 2 мл №10"],
  ["126170", "ОКУСАЛИН ГРОТЕКС капли глазные 3% амп. пласт. 1 мл №10"],
  ["555978", "ОФТАРИНТ капли глазные фл.- кап. 10 мл"],
  ["149212", "ТАУСТИН ГРОТЕКС капли глазные 4% фл.- кап. 10 мл"],
  ["945425", "ХЛОРЭТТА табл. №21"]
]);

function productUrl(id: string): string {
  return `${ORIGIN}/catalog/${id}/`;
}

function productPage(id: string, options: {
  canonicalId?: string;
  emptyText?: string;
  includeAside?: boolean;
  includeFeedback?: boolean;
  title?: string;
} = {}): string {
  const title = options.title ?? PRODUCTS.get(id) ?? "Неизвестный товар";
  const canonicalId = options.canonicalId ?? id;
  const emptyText = options.emptyText ?? "Отзывы на препарат отсутствуют.";
  const includeAside = options.includeAside ?? true;
  const includeFeedback = options.includeFeedback ?? true;
  return `<!doctype html><html><head>
    <title>${title}</title>
    <meta property="og:url" content="${productUrl(canonicalId)}">
    <link rel="canonical" href="${productUrl(canonicalId)}">
    <script type="application/ld+json">{
      "@type":"Product","name":${JSON.stringify(title)},
      "aggregateRating":{"@type":"AggregateRating","ratingValue":5,"worstRating":"0","bestRating":"5","reviewCount":1}
    }</script>
  </head><body><h1>${title}</h1>
    ${includeFeedback ? `<section id="feedback">
      <h2>Отзывы покупателей ${title}</h2>
      <div class="product-feedback-main">
        <div class="product-feedback product-feedback-main__overview"><div>${emptyText}</div></div>
        ${includeAside ? '<div class="product-feedback-aside product-feedback-main__aside product-feedback-aside--empty"><button>Написать отзыв</button></div>' : ""}
      </div>
    </section>` : ""}
  </body></html>`;
}

function requestedUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function exactFetch(overrides: Partial<Record<string, Response>> = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    expect(url.hostname).toBe("maksavit-ru.translate.goog");
    expect(url.searchParams.get("_x_tr_sl")).toBe("ru");
    expect(url.searchParams.get("_x_tr_tl")).toBe("en");
    const id = url.pathname.match(/^\/catalog\/(\d+)\/$/u)?.[1];
    if (!id || !PRODUCTS.has(id)) throw new Error(`unexpected request ${url}`);
    return overrides[id] ?? new Response(productPage(id), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }) as unknown as typeof fetch;
}

function ref(id: string, brand: string) {
  return {
    domain: "maksavit.ru",
    platform: "maksavit.ru",
    listingId: id,
    brand,
    url: productUrl(id),
    title: PRODUCTS.get(id),
    metadata: {}
  };
}

describe("MaksavitAdapter", () => {
  it("discovers the complete bounded exact 4/2/1/1/1 product set", async () => {
    const fetchMock = exactFetch();
    const adapter = new MaksavitAdapter(new MemoryEvidenceStore(), fetchMock);

    const [biviart, okusalin, oftarint, taustin, chloretta] = await Promise.all([
      adapter.discover("Бивиарт", CONTEXT),
      adapter.discover("Окусалин", CONTEXT),
      adapter.discover("Офтаринт", CONTEXT),
      adapter.discover("Таустин", CONTEXT),
      adapter.discover("Хлорэтта", CONTEXT)
    ]);

    expect(biviart.map((item) => item.listingId)).toEqual(["854959", "854538", "945500", "854961"]);
    expect(okusalin.map((item) => item.listingId)).toEqual(["142672", "126170"]);
    expect(oftarint.map((item) => item.listingId)).toEqual(["555978"]);
    expect(taustin.map((item) => item.listingId)).toEqual(["149212"]);
    expect(chloretta.map((item) => item.listingId)).toEqual(["945425"]);
    expect([...biviart, ...okusalin, ...oftarint, ...taustin, ...chloretta].every((item) =>
      item.url === productUrl(item.listingId) && item.title === PRODUCTS.get(item.listingId)
    )).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it("returns three source-bound no_reviews rows for the bounded Кагоцел products", async () => {
    const evidence = new MemoryEvidenceStore();
    const fetchMock = exactFetch();
    const adapter = new MaksavitAdapter(evidence, fetchMock);

    const refs = await adapter.discover("Кагоцел", CONTEXT);
    expect(refs.map(({ listingId, title, url }) => ({ listingId, title, url }))).toEqual([
      { listingId: "2337", title: PRODUCTS.get("2337"), url: productUrl("2337") },
      { listingId: "128266", title: PRODUCTS.get("128266"), url: productUrl("128266") },
      { listingId: "512741", title: PRODUCTS.get("512741"), url: productUrl("512741") }
    ]);

    const observations = await Promise.all(refs.map((product) => adapter.collect(product, CONTEXT)));
    expect(observations.map((observation) => ({
      listingId: observation.listingId,
      canonicalUrl: observation.canonicalUrl,
      product: observation.product,
      reviews: observation.reviews,
      writtenReviewCount: observation.writtenReviewCount,
      rating: observation.rating,
      ratingCount: observation.ratingCount,
      status: observation.status,
      source: observation.source
    }))).toEqual(refs.map((product) => ({
      listingId: product.listingId,
      canonicalUrl: product.url,
      product: product.title,
      reviews: 0,
      writtenReviewCount: 0,
      rating: null,
      ratingCount: 0,
      status: "no_reviews",
      source: "maksavit-visible-product-feedback:google-translate"
    })));
    expect(observations.every((observation) =>
      observation.productEvidence?.identifiers.some((identifier) =>
        identifier.type === "product_id" && identifier.value === observation.listingId
      )
    )).toBe(true);
    expect([...evidence.items.values()]).toEqual(
      expect.arrayContaining(refs.map((product) => expect.objectContaining({
        parsed: expect.objectContaining({
          listingId: product.listingId,
          canonicalUrl: product.url,
          reviews: 0,
          rating: null,
          ignoredTemplateAggregate: true
        })
      })))
    );
    expect(evidence.items.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("publishes only the strict visible zero and ignores the contradictory template AggregateRating 5/1", async () => {
    const evidence = new MemoryEvidenceStore();
    const observation = await new MaksavitAdapter(evidence, exactFetch()).collect(ref("149212", "Таустин"), CONTEXT);

    expect(observation).toMatchObject({
      listingId: "149212",
      product: PRODUCTS.get("149212"),
      reviews: 0,
      writtenReviewCount: 0,
      rating: null,
      ratingCount: 0,
      status: "no_reviews",
      source: "maksavit-visible-product-feedback:google-translate"
    });
    expect(observation.productEvidence?.identifiers).toContainEqual({ type: "product_id", value: "149212" });
    expect(evidence.items.size).toBe(1);
    expect([...evidence.items.values()][0]).toMatchObject({
      parsed: { ignoredTemplateAggregate: true, reviews: 0, rating: null }
    });
  });

  it("rejects template AggregateRating 5/1 when the visible empty proof is absent", async () => {
    const fetchMock = exactFetch({
      "555978": new Response(productPage("555978", { includeFeedback: false }), { status: 200 })
    });

    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), fetchMock).collect(
      ref("555978", "Офтаринт"), CONTEXT
    )).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("fails closed on incomplete or contradictory visible feedback markup", async () => {
    for (const body of [
      productPage("142672", { includeAside: false }),
      productPage("142672", { emptyText: "Пока никто не оставил отзыв" }),
      productPage("142672", { emptyText: "Отзывы на препарат отсутствуют.<article class=\"product-feedback-item\">Отзыв</article>" })
    ]) {
      const fetchMock = exactFetch({ "142672": new Response(body, { status: 200 }) });
      await expect(new MaksavitAdapter(new MemoryEvidenceStore(), fetchMock).collect(
        ref("142672", "Окусалин"), CONTEXT
      )).rejects.toBeInstanceOf(ParserChangedError);
    }
  });

  it("rejects a wrong source canonical, product identity, or non-allowlisted reference", async () => {
    const wrongCanonical = exactFetch({
      "854959": new Response(productPage("854959", { canonicalId: "854538" }), { status: 200 })
    });
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), wrongCanonical).collect(
      ref("854959", "Бивиарт"), CONTEXT
    )).rejects.toBeInstanceOf(ParserChangedError);

    const wrongBrand = exactFetch({
      "854959": new Response(productPage("854959", { title: "ТАУСТИН капли глазные 10 мл" }), { status: 200 })
    });
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), wrongBrand).collect(
      ref("854959", "Бивиарт"), CONTEXT
    )).rejects.toBeInstanceOf(ParserChangedError);

    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), exactFetch()).collect(
      { ...ref("149212", "Таустин"), listingId: "999999", url: productUrl("999999") }, CONTEXT
    )).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("classifies CAPTCHA and access, throttle, and server statuses as blocked rather than zero", async () => {
    for (const status of [400, 401, 403, 429, 498, 502]) {
      const fetchMock = exactFetch({ "149212": new Response("blocked", { status }) });
      await expect(new MaksavitAdapter(new MemoryEvidenceStore(), fetchMock).collect(
        ref("149212", "Таустин"), CONTEXT
      )).rejects.toBeInstanceOf(AdapterBlockedError);
    }

    const captcha = exactFetch({
      "149212": new Response("<html><title>Проверка браузера</title><form class='captcha'></form></html>", { status: 200 })
    });
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), captcha).collect(
      ref("149212", "Таустин"), CONTEXT
    )).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("reports translated HTTP 400 as an external block rather than parser drift", async () => {
    const fetchMock = exactFetch({ "149212": new Response("origin access rejected", { status: 400 }) });
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), fetchMock).healthCheck(CONTEXT)).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/^blocked_free_mode: .*HTTP 400$/)
    });
  });

  it("binds the health request and blocker to the requested exact brand instead of the Taustin fallback", async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      requested.push(url.pathname);
      return new Response("browser check", { status: 503 });
    }) as unknown as typeof fetch;
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), fetchMock).healthCheck({
      ...CONTEXT,
      brands: ["Хлорэтта"]
    })).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/^blocked_free_mode: .*maksavit\.ru:945425: blocked response HTTP 503$/)
    });
    expect(requested).toEqual(["/catalog/945425/"]);
  });

  it("reports healthy only after the exact source-bound canary proves the visible zero", async () => {
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), exactFetch()).healthCheck(CONTEXT)).resolves.toMatchObject({
      ok: true,
      message: "maksavit.ru: exact source-bound product and visible empty-review state are healthy"
    });

    const incomplete = exactFetch({
      "149212": new Response(productPage("149212", { includeFeedback: false }), { status: 200 })
    });
    await expect(new MaksavitAdapter(new MemoryEvidenceStore(), incomplete).healthCheck(CONTEXT)).resolves.toMatchObject({
      ok: false
    });
  });

  liveIt("proves all eleven exact live cards and their visible zero state", async () => {
    const adapter = new MaksavitAdapter(new MemoryEvidenceStore());
    const refsByBrand = await Promise.all([
      adapter.discover("Бивиарт", { region: "Москва", runId: "maksavit-live" }),
      adapter.discover("Кагоцел", { region: "Москва", runId: "maksavit-live" }),
      adapter.discover("Окусалин", { region: "Москва", runId: "maksavit-live" }),
      adapter.discover("Офтаринт", { region: "Москва", runId: "maksavit-live" }),
      adapter.discover("Таустин", { region: "Москва", runId: "maksavit-live" })
    ]);
    expect(refsByBrand.map((refs) => refs.length)).toEqual([4, 3, 2, 1, 1]);

    const observations = await Promise.all(refsByBrand.flatMap((refs) => refs).map((product) =>
      adapter.collect(product, { region: "Москва", runId: "maksavit-live" })
    ));
    expect(observations).toHaveLength(11);
    expect(observations.every((observation) =>
      observation.reviews === 0 &&
      observation.writtenReviewCount === 0 &&
      observation.rating === null &&
      observation.ratingCount === 0 &&
      observation.status === "no_reviews"
    )).toBe(true);
  }, 120_000);
});
