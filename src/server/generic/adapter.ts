import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter, SiteProfile } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { AdapterBlockedError } from "../adapters/errors.js";
import { safeErrorMessage } from "../utils/error-message.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { matchesBrand, normalizeRating } from "../utils/normalize.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { extractPageProductEvidence } from "../utils/product-evidence.js";
import { extractJsonLdProducts } from "./jsonld.js";

const MAX_DISCOVERY_PAGES = 50;
const MAX_DISCOVERY_URLS = 500;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const decodeUrl = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

function idFor(url: string, profile: SiteProfile): string {
  if (profile.listingIdPattern) {
    const match = url.match(new RegExp(profile.listingIdPattern));
    if (match?.[1]) return match[1];
  }
  return createHash("sha256").update(canonicalizeUrl(url)).digest("hex").slice(0, 20);
}

function linksFromHtml(html: string, base: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decode(match[1]), base);
      if (url.protocol !== "https:") continue;
      const text = decode(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      links.push({ url: canonicalizeUrl(url.toString()), text });
    } catch { /* malformed link */ }
  }
  return links;
}

function sameSite(url: string, domain: string): boolean {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function latinSlug(value: string): string {
  const map: Record<string, string> = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
  return value.toLocaleLowerCase("ru").split("").map((char) => map[char] ?? char).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decode(match[1].trim()));
}

function numericText(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const compact = value.replace(/[\s ]/g, "").replace(",", ".");
  const match = compact.match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : undefined;
}

function sameCanonicalPage(left: string, right: string): boolean {
  try {
    const first = new URL(canonicalizeUrl(left));
    const second = new URL(canonicalizeUrl(right));
    const normalizedPath = (value: URL) => value.pathname.replace(/\/+$/, "") || "/";
    return first.origin === second.origin && normalizedPath(first) === normalizedPath(second) && first.search === second.search;
  } catch {
    return false;
  }
}

function selectJsonLdProduct(
  candidates: ReturnType<typeof extractJsonLdProducts>,
  pageUrl: string,
  brand?: string
): { product?: ReturnType<typeof extractJsonLdProducts>[number]; ambiguous: boolean } {
  const matchesRequestedBrand = (candidate: ReturnType<typeof extractJsonLdProducts>[number]) =>
    !brand || matchesBrand(candidate.name ?? "", brand);
  const canonicalMatches = candidates.filter((candidate) =>
    candidate.url && sameCanonicalPage(candidate.url, pageUrl) && matchesRequestedBrand(candidate)
  );
  if (canonicalMatches.length === 1) return { product: canonicalMatches[0], ambiguous: false };
  if (canonicalMatches.length > 1) return { ambiguous: true };
  if (candidates.length === 1 && matchesRequestedBrand(candidates[0])) {
    return { product: candidates[0], ambiguous: false };
  }
  return { ambiguous: candidates.length > 0 };
}

function visibleMetrics(html: string, profile: SiteProfile) {
  const $ = load(html);
  const read = (selector?: string) => {
    if (!selector) return { value: undefined, ambiguous: false };
    const nodes = $(selector);
    if (nodes.length !== 1) return { value: undefined, ambiguous: nodes.length > 1 };
    const node = nodes.first();
    const secondaryContainer = node.parents().filter((_index, parent) => {
      const marker = `${$(parent).attr("class") ?? ""} ${$(parent).attr("id") ?? ""}`;
      return /(?:^|[\s_-])(analog(?:ue)?s?|recommend(?:ation)?s?|related|similar|upsell|cross[-_ ]?sell)(?:[\s_-]|$)/i.test(marker);
    });
    if (secondaryContainer.length) return { value: undefined, ambiguous: true };
    return {
      value: node.attr("content") ?? node.attr("data-rating") ?? node.attr("data-review-count") ?? node.text(),
      ambiguous: false
    };
  };
  const title = read(profile.titleSelector);
  const ratingValue = read(profile.ratingSelector);
  const reviewValue = read(profile.reviewCountSelector);
  const rawRating = numericText(ratingValue.value);
  const rawReviews = numericText(reviewValue.value);
  return {
    name: title.value?.replace(/\s+/g, " ").trim(),
    rawRating,
    rating: rawRating === undefined ? undefined : normalizeRating(rawRating, profile.ratingScale),
    reviewCount: rawReviews === undefined ? undefined : Math.trunc(rawReviews),
    ambiguous: title.ambiguous || ratingValue.ambiguous || reviewValue.ambiguous
  };
}

function nextPageLinks(html: string, base: string, profile: SiteProfile): string[] {
  const $ = load(html);
  const selectors = [profile.nextPageSelector, "a[rel='next']", ".pagination a.next", ".pagination__next", "a.next", "[data-next-page]"]
    .filter((value): value is string => Boolean(value));
  const urls: string[] = [];
  for (const selector of selectors) {
    $(selector).each((_index, node) => {
      const href = $(node).attr("href") ?? $(node).attr("data-next-page");
      if (!href) return;
      try {
        const target = canonicalizeUrl(new URL(href, base).toString());
        if (sameSite(target, profile.domain)) urls.push(target);
      } catch { /* malformed pagination link */ }
    });
    if (urls.length) break;
  }
  return [...new Set(urls)];
}

export class GenericSiteAdapter implements SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];
  private readonly sitemapCache = new Map<string, string>();

  constructor(
    private readonly profile: SiteProfile,
    private readonly evidence: EvidenceStore,
    private readonly fallbackFetch?: typeof globalThis.fetch
  ) {
    this.id = `generic:${profile.domain}:v${profile.version}`;
    this.supportedDomains = [profile.domain];
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    if (this.profile.status === "blocked_free_mode" || this.profile.status === "parser_changed") {
      return { ok: false, checkedAt: new Date().toISOString(), message: this.profile.status };
    }
    const target = this.profile.canaryUrls[0] ?? `https://${this.profile.domain}`;
    try {
      const response = await safeFetch(target, { headers: { "x-ratings-browser": "1" } }, this.fetchFor(context));
      if (!response.ok) return { ok: false, checkedAt: new Date().toISOString(), message: `HTTP ${response.status}` };
      if (this.profile.status === "approved") {
        if (!this.profile.canaryUrls.length || this.profile.reviewCountMeaning === "unknown") {
          return { ok: false, checkedAt: new Date().toISOString(), message: "У одобренного профиля нет canary или семантики счётчика" };
        }
        const html = await readTextBounded(response, 10_000_000);
        const jsonLd = extractJsonLdProducts(html, target);
        const selected = selectJsonLdProduct(jsonLd, target);
        const visible = visibleMetrics(html, this.profile);
        if (selected.ambiguous || visible.ambiguous) {
          return { ok: false, checkedAt: new Date().toISOString(), message: "Canary contains ambiguous product metrics" };
        }
        const hasFeedback = selected.product?.reviewCount !== undefined || selected.product?.ratingCount !== undefined || visible.reviewCount !== undefined;
        const hasRating = selected.product?.rating !== undefined || visible.rating !== undefined;
        const confirmedNoFeedback = selected.product?.reviewCount === 0 || selected.product?.ratingCount === 0 || visible.reviewCount === 0;
        if (!hasFeedback || !hasRating && !confirmedNoFeedback) {
          return { ok: false, checkedAt: new Date().toISOString(), message: "Canary больше не содержит ожидаемые отзыв/рейтинг" };
        }
      }
      return { ok: true, checkedAt: new Date().toISOString(), message: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, checkedAt: new Date().toISOString(), message: safeErrorMessage(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const urls = new Set<string>();
    const addCandidate = (url: string) => {
      urls.add(canonicalizeUrl(url));
      if (urls.size > MAX_DISCOVERY_URLS) {
        throw new AdapterBlockedError(
          `Площадка ${this.profile.domain} вернула более ${MAX_DISCOVERY_URLS} уникальных карточек; полный результат не помещается в безопасный лимит`
        );
      }
    };
    if (this.profile.searchUrlTemplate) {
      const target = this.profile.searchUrlTemplate.replace("{query}", encodeURIComponent(brand));
      const searchQueue = [target];
      const queuedSearch = new Set(searchQueue);
      const visitedSearch = new Set<string>();
      while (searchQueue.length && visitedSearch.size < MAX_DISCOVERY_PAGES) {
        const pageUrl = searchQueue.shift()!;
        if (visitedSearch.has(pageUrl)) continue;
        visitedSearch.add(pageUrl);
        const response = await safeFetch(pageUrl, { headers: {
          "x-ratings-browser": "1",
          "x-ratings-scroll": this.profile.infiniteScroll ? "1" : "0"
        } }, this.fetchFor(context));
        if (!response.ok) {
          throw new AdapterBlockedError(
            `Поиск ${this.profile.domain} не может быть полностью прочитан: HTTP ${response.status} на ${pageUrl}`
          );
        }
        const html = await readTextBounded(response, 5_000_000);
        const paginationLinks = nextPageLinks(html, pageUrl, this.profile);
        const paginationSet = new Set(paginationLinks);
        for (const link of linksFromHtml(html, pageUrl)) {
          if (!paginationSet.has(link.url) && sameSite(link.url, this.profile.domain) && matchesBrand(`${link.text} ${decodeUrl(link.url)}`, brand)) {
            addCandidate(link.url);
          }
        }
        for (const next of paginationLinks) {
          if (visitedSearch.has(next) || queuedSearch.has(next)) continue;
          searchQueue.push(next);
          queuedSearch.add(next);
        }
      }
      if (searchQueue.some((url) => !visitedSearch.has(url))) {
        throw new AdapterBlockedError(
          `Поиск ${this.profile.domain} достиг лимита ${MAX_DISCOVERY_PAGES} страниц без доказанного исчерпания`
        );
      }
    }
    const slug = latinSlug(brand);
    const queue = [...this.profile.sitemapUrls];
    const queuedSitemaps = new Set(queue);
    const visited = new Set<string>();
    while (queue.length && visited.size < MAX_DISCOVERY_PAGES) {
      const sitemap = queue.shift()!;
      if (visited.has(sitemap)) continue;
      visited.add(sitemap);
      let xml = this.sitemapCache.get(sitemap);
      if (xml === undefined) {
        const response = await safeFetch(sitemap, { headers: { "x-ratings-browser": "1" } }, this.fetchFor(context));
        if (!response.ok) {
          throw new AdapterBlockedError(
            `Sitemap ${this.profile.domain} не может быть полностью прочитан: HTTP ${response.status} на ${sitemap}`
          );
        }
        xml = await readTextBounded(response, 15_000_000);
        this.sitemapCache.set(sitemap, xml);
      }
      const locations = sitemapLocations(xml);
      if (/<sitemap(?:index|\s)/i.test(xml)) {
        for (const location of locations) {
          if (!sameSite(location, this.profile.domain) || visited.has(location) || queuedSitemaps.has(location)) continue;
          queue.push(location);
          queuedSitemaps.add(location);
        }
      } else {
        for (const location of locations) {
          if (!sameSite(location, this.profile.domain)) continue;
          const haystack = decodeUrl(location).toLocaleLowerCase("ru");
          if (matchesBrand(haystack, brand) || slug && haystack.includes(slug)) addCandidate(location);
        }
      }
    }
    if (queue.some((url) => !visited.has(url))) {
      throw new AdapterBlockedError(
        `Sitemap ${this.profile.domain} достиг лимита ${MAX_DISCOVERY_PAGES} документов без доказанного исчерпания`
      );
    }
    for (const previous of context.previousIds ?? []) {
      const canary = this.profile.canaryUrls.find((url) => idFor(url, this.profile) === previous);
      if (canary) addCandidate(canary);
    }
    for (const previous of context.previousRefs ?? []) {
      try {
        if (sameSite(previous.url, this.profile.domain)) addCandidate(previous.url);
      } catch { /* ignore malformed historical references */ }
    }
    const unique = [...urls];
    if (!unique.length && this.profile.status !== "approved") {
      throw new AdapterBlockedError("Профиль новой площадки требует контрольных примеров перед подтверждением");
    }
    return unique.map((url) => ({
      domain: this.profile.domain,
      platform: this.profile.domain,
      listingId: idFor(url, this.profile),
      brand,
      url,
      metadata: { profileVersion: this.profile.version }
    }));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    await delay(this.profile.rateLimitMs);
    const response = await safeFetch(ref.url, { headers: { "x-ratings-browser": "1" } }, this.fetchFor(context));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await readTextBounded(response, 10_000_000);
    const candidates = extractJsonLdProducts(html, ref.url);
    const selected = selectJsonLdProduct(candidates, ref.url, ref.brand);
    const product = selected.product;
    const visible = visibleMetrics(html, this.profile);
    const productEvidence = extractPageProductEvidence(html, ref.url, ref.brand, {
      structuredSignals: candidates.flatMap((item) => [item.name, item.description].filter((value): value is string => Boolean(value)))
    });
    const evidenceRef = await this.evidence.put({
      capturedAt: new Date().toISOString(),
      url: ref.url,
      status: response.status,
      jsonLd: candidates.slice(0, 10),
      productEvidence,
      bodyDigest: createHash("sha256").update(html).digest("hex")
    });
    const canUseVisibleMetrics = !selected.ambiguous && !visible.ambiguous && matchesBrand(visible.name ?? "", ref.brand);
    const rawReviewCount = selected.ambiguous ? undefined : product?.reviewCount ?? (canUseVisibleMetrics ? visible.reviewCount : undefined);
    const rating = selected.ambiguous ? undefined : product?.rating ?? (canUseVisibleMetrics ? visible.rating : undefined);
    const reviews = rawReviewCount === undefined ? null : Math.max(0, Math.trunc(rawReviewCount));
    const ratingCount = product?.ratingCount === undefined ? null : Math.max(0, Math.trunc(product.ratingCount));
    const feedbackCount = Math.max(...[reviews, ratingCount].filter((value): value is number => value !== null));
    const resolvedName = product?.name ?? visible.name ?? ref.title ?? ref.brand;
    const metricsComplete = !selected.ambiguous && !visible.ambiguous && matchesBrand(resolvedName, ref.brand) && Number.isFinite(feedbackCount) &&
      (feedbackCount === 0 || rating !== undefined) && this.profile.reviewCountMeaning !== "unknown";
    return {
      domain: ref.domain,
      platform: ref.platform,
      listingId: product?.sku ?? product?.productId ?? ref.listingId,
      brand: ref.brand,
      canonicalUrl: canonicalizeUrl(product?.url ?? ref.url),
      product: resolvedName,
      reviews,
      rating: feedbackCount === 0 ? null : rating ?? null,
      rawRating: selected.ambiguous ? undefined : product?.rating ?? (canUseVisibleMetrics ? visible.rawRating : undefined),
      rawRatingScale: product?.ratingScale ?? this.profile.ratingScale,
      ratingCount,
      status: this.profile.status === "approved" && metricsComplete ? (feedbackCount === 0 ? "no_reviews" : "ok") : "needs_review",
      capturedAt: new Date().toISOString(),
      evidenceRef,
      productEvidence,
      source: product ? "json-ld" : "visible-dom",
      profileVersion: this.profile.version
    };
  }

  private fetchFor(context: AdapterContext): typeof globalThis.fetch | undefined {
    return context.fetch ?? this.fallbackFetch;
  }
}
