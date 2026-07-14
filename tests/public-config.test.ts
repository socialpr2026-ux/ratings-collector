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
