import { describe, expect, it, vi } from "vitest";
import { AdapterBlockedError, ParserChangedError } from "../src/server/adapters/errors.js";
import { VaptekeAdapter } from "../src/server/adapters/vapteke.js";
import { MemoryEvidenceStore } from "../src/server/evidence.js";

const context = { region: "Москва" };

function requestedUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function autocompleteResponse(hits: unknown[], total: number, relation = "eq"): Response {
  return Response.json({ success: true, data: { total: { value: total, relation }, hits }, error: "200" });
}

function hit(productId: number, name: string, slug: string, overrides: Record<string, unknown> = {}) {
  return { product_id: productId, name, slug, is_active: true, ...overrides };
}

function productHtml(input: {
  id: string;
  brand: string;
  title: string;
  slug: string;
  rating: number;
  votes: number;
  visibleRating?: number;
  visibleVotes?: number;
  includeAggregate?: boolean;
}): string {
  const aggregate = input.includeAggregate === false ? "" : `,"aggregateRating":{
    "@type":"AggregateRating","bestRating":"5.0","worstRating":"1.0",
    "ratingValue":"${input.rating}","reviewCount":"${input.votes}"
  }`;
  return `<!doctype html><html><head>
    <link rel="canonical" href="https://vapteke.ru/product/${input.slug}">
    <script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Product","name":"${input.brand}",
      "description":"${input.title}"${aggregate}
    }</script>
  </head><body>
    <h1 class="q-product__header-title">${input.title}</h1>
    <div><span>${input.brand}</span><div id="active_rating" class="item-rating">
      <div class="item-rating-stars" data-id="${input.id}"></div>
      <span class="rating-value">${input.visibleRating ?? input.rating}</span>
      <span class="rating-count">(<span>${input.visibleVotes ?? input.votes}</span> голосов)</span>
    </div></div>
  </body></html>`;
}

const intense = {
  id: "788912",
  brand: "Бивиарт",
  title: "Бивиарт Интенсив раствор офтальмологический увлажняющий 1 шт. 10 мл",
  slug: "biviart-intensiv-rastvor-oftalmologicheskiy-10-ml-788912",
  rating: 3.6,
  votes: 5
};

describe("VaptekeAdapter", () => {
  it("proves complete exact autocomplete discovery, excludes fuzzy hits and deduplicates identical products", async () => {
    const hits = [
      hit(682540, "Бивиарт Софт раствор офтальмологический 0.1% 10 мл", "biviart-soft-01-10-ml-682540"),
      hit(682542, "Бивиарт Комфорт раствор офтальмологический 0.18% 10 мл", "biviart-komfort-018-10-ml-682542"),
      hit(682538, "Бивиарт Ультра раствор офтальмологический 0.3% 10 мл", "biviart-ultra-03-10-ml-682538"),
      hit(788912, "Бивиарт Интенсив раствор офтальмологический 10 мл", intense.slug),
      hit(788912, "Бивиарт Интенсив раствор офтальмологический 10 мл", intense.slug),
      hit(123, "Другой препарат", "drug-123")
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestedUrl(input);
      expect(url.pathname).toBe("/ajax/autocomplete");
      expect(init?.method).toBe("POST");
      expect(new URLSearchParams(String(init?.body)).get("query")).toBe("Бивиарт");
      return autocompleteResponse(hits, 4);
    }) as unknown as typeof fetch;

    const refs = await new VaptekeAdapter(new MemoryEvidenceStore(), fetchMock).discover("Бивиарт", context);

    expect(refs.map((ref) => ref.listingId).sort()).toEqual(["682538", "682540", "682542", "788912"]);
    expect(refs.find((ref) => ref.listingId === "788912")).toMatchObject({
      domain: "vapteke.ru",
      platform: "vapteke.ru",
      url: `https://vapteke.ru/product/${intense.slug}`,
      metadata: { discovery: "vapteke-exact-autocomplete" }
    });
  });

  it.each([
    ["non-exact total", autocompleteResponse([], 0, "gte")],
    ["truncated exact hits", autocompleteResponse([
      hit(682540, "Бивиарт Софт раствор 10 мл", "biviart-soft-10-ml-682540")
    ], 2)]
  ])("fails closed when autocomplete is %s", async (_label, response) => {
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), vi.fn(async () => response) as unknown as typeof fetch);
    await expect(adapter.discover("Бивиарт", context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it("collects a source-bound 3.6/5 vote aggregate without claiming written reviews", async () => {
    const evidence = new MemoryEvidenceStore();
    const adapter = new VaptekeAdapter(evidence, vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-ratings-browser")).toBeNull();
      return new Response(productHtml(intense), {
        status: 200, headers: { "content-type": "text/html; charset=UTF-8" }
      });
    }) as unknown as typeof fetch);

    const observation = await adapter.collect({
      domain: "vapteke.ru",
      platform: "vapteke.ru",
      listingId: intense.id,
      brand: intense.brand,
      url: `https://vapteke.ru/product/${intense.slug}`,
      title: intense.title,
      metadata: {}
    }, context);

    expect(observation).toMatchObject({
      listingId: "788912",
      product: intense.title,
      canonicalUrl: `https://vapteke.ru/product/${intense.slug}`,
      reviews: 5,
      ratingCount: 5,
      rating: 3.6,
      status: "ok",
      source: "vapteke-product-jsonld-visible-votes"
    });
    expect(observation).not.toHaveProperty("writtenReviewCount");
    expect(observation.productEvidence?.identifiers).toContainEqual({ type: "product_id", value: "788912" });
    expect(observation.evidenceRef).toMatch(/^evidence:[a-f0-9]{64}$/u);
    expect(evidence.items.size).toBe(1);
  });

  it.each([
    ["visible count mismatch", productHtml({ ...intense, visibleVotes: 4 })],
    ["unknown aggregate markup", productHtml({ ...intense, includeAggregate: false })],
    ["wrong visible product ID", productHtml(intense).replace('data-id="788912"', 'data-id="682540"')],
    ["zero without explicit source proof", productHtml({ ...intense, rating: 0, votes: 0 })]
  ])("rejects %s", async (_label, html) => {
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })
    ) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "vapteke.ru", platform: "vapteke.ru", listingId: intense.id, brand: intense.brand,
      url: `https://vapteke.ru/product/${intense.slug}`, metadata: {}
    }, context)).rejects.toBeInstanceOf(ParserChangedError);
  });

  it.each([401, 403, 429, 498, 502])("never turns HTTP %s into zero feedback", async (status) => {
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response("blocked", { status })
    ) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "vapteke.ru", platform: "vapteke.ru", listingId: intense.id, brand: intense.brand,
      url: `https://vapteke.ru/product/${intense.slug}`, metadata: {}
    }, context)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it("treats a CAPTCHA page as blocked even with HTTP 200", async () => {
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response("<html><title>Captcha</title><input class='captcha'></html>", { status: 200 })
    ) as unknown as typeof fetch);
    await expect(adapter.discover("Бивиарт", context)).rejects.toBeInstanceOf(AdapterBlockedError);
  });

  it.each([404, 410])("returns not_found only for an exact product HTTP %s", async (status) => {
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), vi.fn(async () =>
      new Response("gone", { status })
    ) as unknown as typeof fetch);
    await expect(adapter.collect({
      domain: "vapteke.ru", platform: "vapteke.ru", listingId: intense.id, brand: intense.brand,
      url: `https://vapteke.ru/product/${intense.slug}`, title: intense.title, metadata: {}
    }, context)).resolves.toMatchObject({ reviews: null, rating: null, status: "not_found" });
  });

  it("uses the fixed exact АкваОптик product as the health canary", async () => {
    const canary = {
      id: "365917",
      brand: "АкваОптик",
      title: "Раствор для ухода за контактными линзами АкваОптик многофункциональный 60 мл",
      slug: "rastvor-dlya-uhoda-za-kontaktnymi-linzami-akvaoptik-mnogofunktsionalnyy-60-ml-365917",
      rating: 5,
      votes: 1
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestedUrl(input).toString()).toBe(`https://vapteke.ru/product/${canary.slug}`);
      expect(new Headers(init?.headers).get("x-ratings-browser")).toBeNull();
      return new Response(productHtml(canary), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    await expect(new VaptekeAdapter(new MemoryEvidenceStore(), fetchMock).healthCheck(context)).resolves.toMatchObject({
      ok: true,
      message: "vapteke.ru: exact АкваОптик vote canary is healthy"
    });
  });

  it("recovers a transient exact product response before using the quota-bearing browser", async () => {
    const headers: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const browser = new Headers(init?.headers).get("x-ratings-browser");
      headers.push(browser);
      return headers.length === 1
        ? new Response("transient upstream failure", { status: 502 })
        : new Response(productHtml(intense), { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.collect({
      domain: "vapteke.ru", platform: "vapteke.ru", listingId: intense.id, brand: intense.brand,
      url: `https://vapteke.ru/product/${intense.slug}`, metadata: {}
    }, context)).resolves.toMatchObject({ listingId: intense.id, rating: 3.6 });
    expect(headers).toEqual([null, null]);
  });

  it("uses the quota-bearing browser only after two static exact product attempts are blocked", async () => {
    const headers: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const browser = new Headers(init?.headers).get("x-ratings-browser");
      headers.push(browser);
      return browser === "1"
        ? new Response(productHtml(intense), { status: 200, headers: { "content-type": "text/html" } })
        : new Response("upstream blocked", { status: 502 });
    }) as unknown as typeof fetch;
    const adapter = new VaptekeAdapter(new MemoryEvidenceStore(), fetchMock);

    await expect(adapter.collect({
      domain: "vapteke.ru", platform: "vapteke.ru", listingId: intense.id, brand: intense.brand,
      url: `https://vapteke.ru/product/${intense.slug}`, metadata: {}
    }, context)).resolves.toMatchObject({ listingId: intense.id, rating: 3.6 });
    expect(headers).toEqual([null, null, "1"]);
  });
});
