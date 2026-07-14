import { describe, expect, it } from "vitest";
import { profileSite } from "../src/server/generic/profiler.js";

describe("automatic site profiler", () => {
  it("discovers a GET search form, pagination and three JSON-LD control products", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:");
      if (url.pathname.startsWith("/sitemap")) return new Response("missing", { status: 404 });
      if (url.pathname === "/") return new Response(`<form action="/find"><input type="search" name="term"></form>`);
      if (url.pathname === "/find") return new Response(`<main>
        <a href="/product/101">Бренд капсулы 10</a><a href="/product/102">Бренд капсулы 20</a>
        <a href="/product/103">Бренд капсулы 30</a><a rel="next" href="/find?term=Бренд&page=2">Далее</a>
      </main>`);
      if (/^\/product\/10[1-3]$/.test(url.pathname)) return new Response(`<script type="application/ld+json">{
        "@type":"Product","name":"Бренд капсулы","url":"${url.pathname}","sku":"${url.pathname.split("/").at(-1)}",
        "aggregateRating":{"@type":"AggregateRating","ratingValue":4.7,"reviewCount":12,"ratingCount":20}
      }</script>`);
      return new Response("not found", { status: 404 });
    };
    const profile = await profileSite("example.com", "Бренд", fetchMock as typeof fetch);
    expect(profile.searchUrlTemplate).toBe("https://example.com/find?term={query}");
    expect(profile.nextPageSelector).toBe("a[rel='next']");
    expect(profile.testExamples).toHaveLength(3);
    expect(profile.reviewCountMeaning).toBe("reviews");
    expect(profile.status).toBe("draft");
    expect(profile.infiniteScroll).toBe(false);
  });

  it("verifies every root sitemap when their count is within the hard cap", async () => {
    const declared = Array.from({ length: 11 }, (_, index) => `https://example.com/maps/${index}.xml`);
    const requestedSitemaps: string[] = [];
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/robots.txt") {
        return new Response([
          "User-agent: *",
          "Disallow:",
          ...declared.map((sitemap) => `Sitemap: ${sitemap}`)
        ].join("\n"));
      }
      if (url.pathname.endsWith(".xml")) {
        requestedSitemaps.push(url.toString());
        return new Response("<urlset></urlset>");
      }
      return new Response("not found", { status: 404 });
    };

    const profile = await profileSite("example.com", "Бренд", fetchMock as typeof fetch);

    expect(profile.status).toBe("draft");
    expect(profile.sitemapUrls).toHaveLength(13);
    expect(new Set(requestedSitemaps)).toEqual(new Set([
      ...declared,
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap_index.xml"
    ]));
  });

  it("blocks without partial sitemap probing when root candidates exceed the hard cap", async () => {
    const declared = Array.from({ length: 51 }, (_, index) => `https://example.com/maps/${index}.xml`);
    let sitemapRequests = 0;
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/robots.txt") {
        return new Response([
          "User-agent: *",
          "Disallow:",
          ...declared.map((sitemap) => `Sitemap: ${sitemap}`)
        ].join("\n"));
      }
      if (url.pathname.endsWith(".xml")) sitemapRequests += 1;
      return new Response("not found", { status: 404 });
    };

    const profile = await profileSite("example.com", "Бренд", fetchMock as typeof fetch);

    expect(profile.status).toBe("blocked_free_mode");
    expect(profile.sitemapUrls).toEqual([]);
    expect(sitemapRequests).toBe(0);
    expect(profile.notes.join(" ")).toContain("корневых sitemap при лимите 50");
    expect(profile.notes.join(" ")).toContain("нужен отдельный адаптер");
  });

  it("blocks an infinite-scroll profile instead of approving an SSR fragment", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:");
      if (url.pathname.endsWith(".xml")) return new Response("missing", { status: 404 });
      if (url.pathname === "/") return new Response(`<form action="/find"><input type="search" name="term"></form>`);
      if (url.pathname === "/find") {
        return new Response(`<main data-page="1"><a href="/product/101">Бренд капсулы</a></main><script>new IntersectionObserver(() => {})</script>`);
      }
      if (url.pathname === "/product/101") {
        return new Response(`<script type="application/ld+json">{
          "@type":"Product","name":"Бренд капсулы","url":"${url.pathname}",
          "aggregateRating":{"@type":"AggregateRating","ratingValue":4.8,"reviewCount":5}
        }</script>`);
      }
      return new Response("not found", { status: 404 });
    };

    const profile = await profileSite("example.com", "Бренд", fetchMock as typeof fetch);

    expect(profile.searchUrlTemplate).toBe("https://example.com/find?term={query}");
    expect(profile.infiniteScroll).toBe(true);
    expect(profile.status).toBe("blocked_free_mode");
    expect(profile.notes.join(" ")).toContain("infinite scroll; нужен отдельный адаптер");
  });

  it("blocks a partial profile when any robots-declared root sitemap fails validation", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/robots.txt") {
        return new Response([
          "User-agent: *",
          "Disallow:",
          "Sitemap: https://example.com/declared-invalid.xml",
          "Sitemap: https://example.com/declared-unavailable.xml"
        ].join("\n"));
      }
      if (url.pathname === "/declared-invalid.xml") return new Response("<html>not a sitemap</html>");
      if (url.pathname === "/declared-unavailable.xml") return new Response("unavailable", { status: 503 });
      if (url.pathname.endsWith(".xml")) return new Response("<urlset></urlset>");
      if (url.pathname === "/") return new Response(`<form action="/find"><input type="search" name="term"></form>`);
      if (url.pathname === "/find") return new Response("<main>Бренд</main>");
      return new Response("not found", { status: 404 });
    };

    const profile = await profileSite("example.com", "Бренд", fetchMock as typeof fetch);

    expect(profile.searchUrlTemplate).toBe("https://example.com/find?term={query}");
    expect(profile.status).toBe("blocked_free_mode");
    expect(profile.notes.join(" ")).toContain("невалидный XML");
    expect(profile.notes.join(" ")).toContain("HTTP 503");
  });

  it("blocks an unsafe robots-declared sitemap without fetching it", async () => {
    const requestedHosts: string[] = [];
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedHosts.push(url.hostname);
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nDisallow:\nSitemap: https://evil.example/root.xml");
      }
      if (url.pathname.endsWith(".xml")) return new Response("<urlset></urlset>");
      return new Response("not found", { status: 404 });
    };

    const profile = await profileSite("example.com", "Бренд", fetchMock as typeof fetch);

    expect(profile.status).toBe("blocked_free_mode");
    expect(profile.notes.join(" ")).toContain("небезопасный root sitemap");
    expect(requestedHosts).not.toContain("evil.example");
  });
});
