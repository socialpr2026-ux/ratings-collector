import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";
import { canonicalProductDescriptor } from "../utils/product-name.js";

const MAX_HTML_BYTES = 12_000_000;
const TRANSLATE_PARAMETERS = { _x_tr_sl: "ru", _x_tr_tl: "en", _x_tr_hl: "en" } as const;
const BLOCK_MARKERS = /captcha|access denied|forbidden|доступ (?:ограничен|запрещен)|проверка браузера|can't reach this website|enable javascript/i;

type HtmlPage = { html: string; $: CheerioAPI; requestedUrl: string; status: number };

function compactText(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function host(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./, "");
}

function sameSource(left: URL, right: URL): boolean {
  if (left.protocol !== "https:" || right.protocol !== "https:") return false;
  if (host(left.hostname) !== host(right.hostname) || left.pathname !== right.pathname) return false;
  return JSON.stringify([...left.searchParams.entries()].sort()) === JSON.stringify([...right.searchParams.entries()].sort());
}

function sameSourcePage(left: URL, right: URL): boolean {
  return left.protocol === "https:" && right.protocol === "https:" &&
    host(left.hostname) === host(right.hostname) && left.pathname === right.pathname;
}

function translatedUrl(source: URL, translatedHost: string): URL {
  const result = new URL(`${source.pathname}${source.search}`, `https://${translatedHost}`);
  for (const [key, value] of Object.entries(TRANSLATE_PARAMETERS)) result.searchParams.set(key, value);
  return result;
}

function assertTranslatedSource($: CheerioAPI, source: URL): void {
  const proofs = [
    $("[data-source-url]").first().attr("data-source-url"),
    $("base[href]").first().attr("href")
  ].filter((value): value is string => Boolean(value));
  const proven = proofs.some((value) => {
    try { return sameSource(new URL(value, source), source); }
    catch { return false; }
  });
  // Google Translate now emits a first-party canonical URL plus a relative
  // base instead of repeating the full requested URL. The canonical proves
  // the exact source host and path; adapters must still bind query-specific
  // state (for example eTabl's searchQuery) before accepting any product.
  const canonical = $("link[rel='canonical']").first().attr("href");
  const canonicalProven = canonical ? (() => {
    try { return sameSourcePage(new URL(canonical, source), source); }
    catch { return false; }
  })() : false;
  if (!proven && !canonicalProven) {
    throw new ParserChangedError(`${host(source.hostname)}: translated page returned another source URL`);
  }
}

async function requestPage(
  source: URL,
  context: AdapterContext,
  fallbackFetch: typeof fetch,
  translatedHost?: string
): Promise<HtmlPage> {
  const endpoint = translatedHost ? translatedUrl(source, translatedHost) : source;
  let response: Response;
  try {
    response = await safeFetch(endpoint.toString(), {
      signal: context.signal,
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9,en;q=0.7" }
    }, context.fetch ?? fallbackFetch, 4, 60_000);
  } catch (error) {
    throw new AdapterBlockedError(`${host(source.hostname)}: request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, MAX_HTML_BYTES, 60_000).catch((error) => {
    throw new AdapterBlockedError(`${host(source.hostname)}: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
  });
  const $ = load(html);
  const title = compactText($("title").first().text());
  if (!response.ok || BLOCK_MARKERS.test(title)) {
    throw new AdapterBlockedError(`${host(source.hostname)}: free first-party page is unavailable (HTTP ${response.status})`);
  }
  if (translatedHost) assertTranslatedSource($, source);
  return { html, $, requestedUrl: endpoint.toString(), status: response.status };
}

function exactInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\s\u00a0\u202f]/g, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function exactRating(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = String(value).replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!/^\d(?:\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

function sourceHref(value: string | undefined, domain: string): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, `https://${domain}/`);
    if (parsed.protocol !== "https:") return undefined;
    const source = new URL(`https://${domain}${parsed.pathname}${parsed.search}`);
    for (const key of Object.keys(TRANSLATE_PARAMETERS)) source.searchParams.delete(key);
    return source;
  } catch {
    return undefined;
  }
}

function transliterate(value: string, useTs = false, kha: "h" | "kh" | "x" = "h"): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: kha, ц: useTs ? "ts" : "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value.toLocaleLowerCase("ru-RU").split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function transliteratedSlugs(value: string): string[] {
  return [...new Set((["h", "kh", "x"] as const).flatMap((kha) =>
    [transliterate(value, false, kha), transliterate(value, true, kha)]
  ).filter(Boolean))];
}

function historicalRefs(
  domain: string,
  brand: string,
  context: AdapterContext,
  parse: (url: string, listingId?: string) => { id: string; url: string } | undefined
): Map<string, ProductRef> {
  const refs = new Map<string, ProductRef>();
  for (const previous of context.previousRefs ?? []) {
    const parsed = parse(previous.url, previous.listingId);
    if (!parsed || parsed.id !== previous.listingId) continue;
    refs.set(parsed.id, {
      domain, platform: domain, listingId: parsed.id, brand, url: parsed.url,
      metadata: { discovery: "historical-registry" }
    });
  }
  return refs;
}

async function observation(
  evidence: EvidenceStore,
  ref: ProductRef,
  page: HtmlPage,
  input: { domain: string; title: string; canonicalUrl: string; reviews: number; rating: number | null; ratingCount?: number | null; source: string }
): Promise<Observation> {
  const capturedAt = new Date().toISOString();
  const productEvidence = titleProductEvidence(input.title, { type: "product_id", value: ref.listingId }, input.canonicalUrl);
  const parsed = {
    listingId: ref.listingId,
    title: input.title,
    canonicalUrl: input.canonicalUrl,
    writtenReviewCount: input.reviews,
    ratingCount: input.ratingCount ?? null,
    rating: input.rating
  };
  const evidenceRef = await evidence.put({
    capturedAt,
    url: page.requestedUrl,
    status: page.status,
    bodyDigest: createHash("sha256").update(page.html).digest("hex"),
    parsed,
    productEvidence,
    source: input.source
  });
  const feedbackCount = Math.max(input.reviews, input.ratingCount ?? 0);
  return {
    domain: input.domain,
    platform: input.domain,
    listingId: ref.listingId,
    brand: ref.brand,
    canonicalUrl: input.canonicalUrl,
    product: input.title,
    reviews: feedbackCount,
    writtenReviewCount: input.ratingCount !== undefined && input.ratingCount !== null ? input.reviews : undefined,
    rating: feedbackCount === 0 ? null : input.rating,
    rawRating: input.rating,
    rawRatingScale: 5,
    ratingCount: input.ratingCount,
    status: feedbackCount === 0 ? "no_reviews" : "ok",
    capturedAt,
    evidenceRef,
    productEvidence,
    source: input.source
  };
}

abstract class AdditionalPharmacyAdapter implements SiteAdapter {
  abstract readonly id: string;
  abstract readonly supportedDomains: readonly string[];
  abstract healthCheck(context: AdapterContext): Promise<AdapterHealth>;
  abstract discover(brand: string, context: AdapterContext): Promise<ProductRef[]>;
  abstract collect(ref: ProductRef, context: AdapterContext): Promise<Observation>;

  constructor(protected readonly evidence: EvidenceStore, protected readonly fetchImpl: typeof fetch = fetch) {}

  protected async canary(brand: string, context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const refs = await this.discover(brand, { ...context, previousIds: [], previousRefs: [] });
      return refs.length
        ? { ok: true, checkedAt, message: `${this.id}: ${refs.length} control product(s) found` }
        : { ok: false, checkedAt, message: `${this.id}: control brand returned no products` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

const APTEKA_DOMAIN = "apteka.ru";
const APTEKA_PRODUCT = /^\/product\/([a-z0-9-]+-([a-f0-9]{24}))\/?$/i;

function aptekaRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value, `https://${APTEKA_DOMAIN}/`);
    if (url.protocol !== "https:" || host(url.hostname) !== APTEKA_DOMAIN) return undefined;
    const match = url.pathname.match(APTEKA_PRODUCT);
    if (!match || expectedId && match[2] !== expectedId) return undefined;
    return { id: match[2], url: `https://${APTEKA_DOMAIN}/product/${match[1]}/` };
  } catch { return undefined; }
}

function jsonLdProducts($: CheerioAPI): Array<Record<string, unknown>> {
  const products: Array<Record<string, unknown>> = [];
  $("script[type='application/ld+json']").each((_index, node) => {
    try {
      const value = JSON.parse($(node).html() ?? "null") as unknown;
      const queue = Array.isArray(value) ? [...value] : [value];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record["@type"] === "Product") products.push(record);
        const graph = record["@graph"];
        if (Array.isArray(graph)) queue.push(...graph);
      }
    } catch { /* unrelated invalid JSON-LD is ignored */ }
  });
  return products;
}

function aptekaVisibleFeedback(
  $: CheerioAPI,
  expectedUrl: string,
  expectedTitle: string
): { count: number; rating: number } | undefined {
  const selected = $(".variantButton[aria-selected='true']");
  if (selected.length !== 1) return undefined;
  const link = selected.find("a.variantButton__link[href][aria-label]").first();
  const source = sourceHref(link.attr("href"), APTEKA_DOMAIN);
  const title = compactText(link.attr("aria-label") ?? "");
  if (!source || source.pathname !== new URL(expectedUrl).pathname || normalizeText(title) !== normalizeText(expectedTitle)) {
    return undefined;
  }
  const metric = selected.find(".variantButton__rating .ItemRating");
  if (metric.length !== 1) return undefined;
  const count = exactInteger(metric.find(".caption3 span").first().text());
  const rating = exactRating(metric.find(".ItemRating__label").first().text());
  return count === undefined || rating === undefined ? undefined : { count, rating };
}

export class AptekaRuAdapter extends AdditionalPharmacyAdapter {
  readonly id = "apteka.ru:preparation-jsonld-v1";
  readonly supportedDomains = [APTEKA_DOMAIN, `www.${APTEKA_DOMAIN}`] as const;

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    const canaryId = "5e3268eaca7bdc000192d316";
    const canaryUrl = `https://${APTEKA_DOMAIN}/product/oczillokokczinum-30-sht-granuly-${canaryId}/`;
    try {
      const page = await requestPage(new URL(canaryUrl), context, this.fetchImpl, "apteka-ru.translate.goog");
      const products = jsonLdProducts(page.$).filter((item) => String(item.sku ?? "") === canaryId);
      if (products.length !== 1 || !matchesBrand(compactText(String(products[0].name ?? "")), "Оциллококцинум")) {
        throw new ParserChangedError(`${this.id}: control Product JSON-LD is missing or ambiguous`);
      }
      return { ok: true, checkedAt, message: `${this.id}: control product structure is valid` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(APTEKA_DOMAIN, brand, context, aptekaRef);
    const slugs = transliteratedSlugs(brand);
    for (const slug of slugs) {
      const source = new URL(`https://${APTEKA_DOMAIN}/preparation/${slug}/`);
      let page: HtmlPage;
      try {
        page = await requestPage(source, context, this.fetchImpl);
      } catch (error) {
        // Preparation pages are only a fast discovery hint. Some valid brands
        // have no preparation route and the fixed Function egress can surface
        // that optional lookup as a transient upstream status. Keep walking
        // the bounded transliteration candidates and let the filtered,
        // first-party product sitemap remain the authoritative fallback.
        // Any access failure on this optional hint is non-authoritative. The
        // filtered first-party sitemap below remains the bounded proof source;
        // parser/content errors still fail closed instead of being hidden.
        if (error instanceof AdapterBlockedError) continue;
        throw error;
      }
      page.$("a[href*='/product/']").each((_index, node) => {
        const parsed = aptekaRef(page.$(node).attr("href") ?? "");
        if (!parsed) return;
        const card = page.$(node).closest("article, li, [class*='product'], [class*='item']");
        const title = compactText(page.$(node).attr("aria-label") || page.$(node).text() || card.text());
        if (!matchesBrand(title, brand)) return;
        refs.set(parsed.id, {
          domain: APTEKA_DOMAIN, platform: APTEKA_DOMAIN, listingId: parsed.id, brand,
          url: parsed.url, title, metadata: { discovery: "first-party-preparation-page" }
        });
      });
      if (refs.size) break;
    }
    if (!refs.size) {
      const sitemap = new URL(`https://${APTEKA_DOMAIN}/sitemap-product.xml`);
      sitemap.searchParams.set("slugs", slugs.join(","));
      const page = await requestPage(sitemap, context, this.fetchImpl);
      if (!/<urlset\b/i.test(page.html)) {
        throw new ParserChangedError(`${APTEKA_DOMAIN}: product sitemap proof is missing`);
      }
      for (const match of page.html.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        const parsed = aptekaRef(match[1].replace(/&amp;/gi, "&"));
        if (!parsed) continue;
        const productSlug = new URL(parsed.url).pathname.match(/^\/product\/([a-z0-9-]+)-[a-f0-9]{24}\/?$/i)?.[1] ?? "";
        if (!slugs.some((slug) => productSlug === slug || productSlug.startsWith(`${slug}-`))) continue;
        refs.set(parsed.id, {
          domain: APTEKA_DOMAIN, platform: APTEKA_DOMAIN, listingId: parsed.id, brand,
          url: parsed.url, metadata: { discovery: "first-party-product-sitemap" }
        });
      }
    }
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = aptekaRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    // Direct Apteka product egress is intermittently rejected while the
    // source-bound Translate SSR route returns the same canonical Product
    // JSON-LD. Keep discovery on the first-party sitemap and collect the exact
    // proven product through that bounded gateway.
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, "apteka-ru.translate.goog");
    const products = jsonLdProducts(page.$).filter((item) => String(item.sku ?? "") === ref.listingId);
    if (products.length !== 1) throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: exact Product JSON-LD is missing or ambiguous`);
    const product = products[0];
    const title = compactText(String(product.name ?? ""));
    if (!matchesBrand(title, ref.brand)) throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: product brand changed`);
    const aggregate = product.aggregateRating;
    let reviews: number | undefined;
    let ratingCount: number | undefined;
    let value: number | undefined;
    if (aggregate && typeof aggregate === "object") {
      const record = aggregate as Record<string, unknown>;
      reviews = exactInteger(record.reviewCount);
      ratingCount = exactInteger(record.ratingCount);
      value = exactRating(record.ratingValue);
    }
    const feedbackCount = Math.max(reviews ?? 0, ratingCount ?? 0);
    if (feedbackCount > 0) {
      const visible = aptekaVisibleFeedback(page.$, parsedRef.url, title);
      if (!visible || visible.count !== feedbackCount || visible.rating !== value) {
        throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: structured feedback is not proven by the selected product variant`);
      }
    }
    if (reviews === undefined && ratingCount === undefined) {
      const text = compactText(page.$("body").text());
      if (/Отзывы\s*0\b|нет отзывов/i.test(text)) reviews = 0;
    }
    if (reviews === undefined && ratingCount === undefined || feedbackCount > 0 && value === undefined) {
      throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: complete feedback aggregate is missing`);
    }
    return observation(this.evidence, ref, page, {
      domain: APTEKA_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews: reviews ?? 0,
      ratingCount: ratingCount ?? null,
      rating: value ?? null,
      source: "apteka-product-jsonld"
    });
  }
}

const NF_DOMAIN = "nfapteka.ru";
const NF_TRANSLATE_HOST = "nfapteka-ru.translate.goog";
const NF_PRODUCT = /^\/(?:[a-z0-9-]+\/)*catalog\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/i;

function nfRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  const id = expectedId;
  if (!id || !/^\d+$/.test(id)) return undefined;
  const url = sourceHref(value, NF_DOMAIN);
  if (!url || !NF_PRODUCT.test(url.pathname)) return undefined;
  return { id, url: `https://${NF_DOMAIN}${url.pathname}` };
}

function nfExplicitEmptyProductReviews($: CheerioAPI): boolean {
  const sections = $("#review");
  if (sections.length !== 1) return false;
  const section = sections.first();
  if (section.children().length !== 2 || section.children("h2").length !== 1 ||
    section.find("[itemprop='review'], [data-review-id], .review-item, [itemprop='ratingValue']").length) return false;
  const heading = compactText(section.children("h2").first().text());
  const links = section.find("a[href]");
  if (!/^Отзывы\s+\S/iu.test(heading) || links.length !== 1 || compactText(links.first().text()) !== "Оставить отзыв") return false;
  try {
    return new URL(links.first().attr("href") ?? "", "https://nfapteka.ru/").hash === "#testimonialModal";
  } catch {
    return false;
  }
}

function nfVisibleReviewMetrics($: CheerioAPI, brand: string, expectedTitle: string): { reviews: number; rating: number } | undefined {
  const section = $("#review");
  if (section.length !== 1) return undefined;
  const items = section.find(".testimonial[itemscope][itemtype*='Review']");
  if (!items.length) return undefined;
  const expectedProduct = canonicalProductDescriptor(brand, expectedTitle);
  if (!expectedProduct) return undefined;
  let sum = 0;
  for (const node of items.toArray()) {
    const item = $(node);
    const reviewed = compactText(item.find("meta[itemprop='itemReviewed']").first().attr("content") ?? "");
    const score = exactRating(item.find("[itemprop='reviewRating'] [itemprop='ratingValue']").first().attr("content"));
    if (canonicalProductDescriptor(brand, reviewed) !== expectedProduct || score === undefined) return undefined;
    sum += score;
  }
  return { reviews: items.length, rating: Math.round(sum / items.length * 100) / 100 };
}

export class NfAptekaAdapter extends AdditionalPharmacyAdapter {
  readonly id = "nfapteka.ru:translated-microdata-v1";
  readonly supportedDomains = [NF_DOMAIN, `www.${NF_DOMAIN}`] as const;

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    return this.canary("Оциллококцинум", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(NF_DOMAIN, brand, context, nfRef);
    const source = new URL(`https://${NF_DOMAIN}/catalog/`);
    source.searchParams.set("q", brand);
    const page = await requestPage(source, context, this.fetchImpl, NF_TRANSLATE_HOST);
    page.$(".productOuter, [class*='productOuter']").each((_index, node) => {
      const root = page.$(node);
      const id = root.find("[data-id]").first().attr("data-id")?.trim();
      if (!id) return;
      let selected: { parsed: { id: string; url: string }; title: string } | undefined;
      for (const candidate of root.find("a[href$='.html'], a[href*='.html?']").toArray()) {
        const link = page.$(candidate);
        const title = compactText(link.text() || link.find("img[alt]").first().attr("alt") || "");
        if (!title) continue;
        const parsed = nfRef(link.attr("href") ?? "", id);
        if (!parsed) continue;
        selected = { parsed, title };
        break;
      }
      if (!selected) return;
      const parsed = selected.parsed;
      const title = selected.title;
      if (!matchesBrand(title, brand)) return;
      refs.set(parsed.id, {
        domain: NF_DOMAIN, platform: NF_DOMAIN, listingId: parsed.id, brand,
        url: parsed.url, title, metadata: { discovery: "translated-first-party-search" }
      });
    });
    if (!refs.size) {
      const text = compactText(page.$("main, body").text());
      if (/ничего не найдено|товары не найдены|по вашему запросу.{0,80}не найдено/i.test(text)) return [];
      throw new AdapterBlockedError(`${NF_DOMAIN}: search proved neither exact products nor no results`);
    }
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = nfRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, NF_TRANSLATE_HOST);
    const pageId = page.$("input[name='productId'], [data-id]").first().attr("value")
      ?? page.$("[data-id]").first().attr("data-id");
    const canonical = sourceHref(page.$("link[rel='canonical']").first().attr("href"), NF_DOMAIN);
    const title = compactText(page.$("h1").first().text());
    if (pageId !== ref.listingId || !canonical || canonical.pathname !== new URL(parsedRef.url).pathname || !matchesBrand(title, ref.brand)) {
      throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: exact product identity changed`);
    }
    const aggregate = page.$("[itemprop='aggregateRating']").first();
    const reviews = exactInteger(aggregate.find("[itemprop='reviewCount']").first().attr("content") ?? aggregate.find("[itemprop='reviewCount']").first().text())
      ?? (nfExplicitEmptyProductReviews(page.$) ? 0 : undefined);
    const value = exactRating(aggregate.find("[itemprop='ratingValue']").first().attr("content") ?? aggregate.find("[itemprop='ratingValue']").first().text());
    if (reviews === undefined || reviews > 0 && value === undefined) {
      throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: complete product feedback microdata is missing`);
    }
    if (reviews > 0) {
      const visible = nfVisibleReviewMetrics(page.$, ref.brand, title);
      const aggregateMatchesVisible = visible && (
        Math.abs(visible.rating - value!) <= 0.01 ||
        Number.isInteger(value) && Math.round(visible.rating) === value
      );
      if (!visible || visible.reviews !== reviews || !aggregateMatchesVisible) {
        throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: aggregate feedback is not proven by the exact product review list`);
      }
    }
    return observation(this.evidence, ref, page, {
      domain: NF_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews,
      rating: reviews === 0 ? null : value!,
      source: "nfapteka-product-feedback:google-translate"
    });
  }
}

type EtablProduct = {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  subtitleFull?: unknown;
  reviewsStats?: { rating?: unknown; reviewsCount?: unknown };
};

const ETABL_DOMAIN = "etabl.ru";
const ETABL_TRANSLATE_HOST = "etabl-ru.translate.goog";
const ETABL_PRODUCT = /^\/product\/([a-z0-9-]+=(\d+))\/?$/i;

function initialState($: CheerioAPI, domain: string): Record<string, unknown> {
  const script = $("script").toArray().map((node) => $(node).html() ?? "")
    .find((value) => value.startsWith("window.__INITIAL_STATE__="));
  if (!script) throw new ParserChangedError(`${domain}: __INITIAL_STATE__ is missing`);
  const raw = script.slice("window.__INITIAL_STATE__=".length);
  const marker = raw.indexOf(";document.currentScript.remove()");
  try { return JSON.parse(marker >= 0 ? raw.slice(0, marker) : raw.replace(/;\s*$/, "")) as Record<string, unknown>; }
  catch { throw new ParserChangedError(`${domain}: __INITIAL_STATE__ is invalid JSON`); }
}

function etablRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  const url = sourceHref(value, ETABL_DOMAIN);
  if (!url) return undefined;
  const match = url.pathname.match(ETABL_PRODUCT);
  if (!match || expectedId && match[2] !== expectedId) return undefined;
  return { id: match[2], url: `https://${ETABL_DOMAIN}/product/${match[1]}` };
}

function etablTitle(product: EtablProduct): string {
  return compactText(`${String(product.name ?? "")} ${String(product.subtitleFull ?? "")}`);
}

export class EtablAdapter extends AdditionalPharmacyAdapter {
  readonly id = "etabl.ru:translated-state-v1";
  readonly supportedDomains = [ETABL_DOMAIN, `www.${ETABL_DOMAIN}`] as const;

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    return this.canary("Оциллококцинум", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(ETABL_DOMAIN, brand, context, etablRef);
    const source = new URL(`https://${ETABL_DOMAIN}/search`);
    source.searchParams.set("query", brand);
    source.searchParams.set("limit", "100");
    const page = await requestPage(source, context, this.fetchImpl, ETABL_TRANSLATE_HOST);
    const state = initialState(page.$, ETABL_DOMAIN);
    const search = state.search as {
      searchResultNew?: unknown;
      searchResultCount?: unknown;
      searchQuery?: unknown;
    } | undefined;
    const products = Array.isArray(search?.searchResultNew) ? search.searchResultNew as EtablProduct[] : undefined;
    const count = exactInteger(search?.searchResultCount);
    const normalizedQuery = compactText(String(search?.searchQuery ?? ""))
      .toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const normalizedBrand = compactText(brand).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    // searchResultCount is a broad catalogue counter and can exceed the
    // sellable cards in searchResultNew (live Хондрофен: 2 vs 1). It is not a
    // pagination proof. Require the exact echoed query and a structurally
    // consistent card array; a positive counter with no cards stays blocked.
    if (!products || count === undefined || normalizedQuery !== normalizedBrand ||
      count < products.length || count > 0 && products.length === 0) {
      throw new ParserChangedError(`${ETABL_DOMAIN}: search result is incomplete or malformed`);
    }
    for (const product of products) {
      const id = String(product.id ?? "");
      const parsed = etablRef(`https://${ETABL_DOMAIN}/product/${String(product.url ?? "")}`, id);
      const title = etablTitle(product);
      if (!parsed || !matchesBrand(title, brand)) continue;
      refs.set(parsed.id, {
        domain: ETABL_DOMAIN, platform: ETABL_DOMAIN, listingId: parsed.id, brand,
        url: parsed.url, title, metadata: { discovery: "translated-first-party-search-state" }
      });
    }
    if (!refs.size && count === 0) return [];
    if (!refs.size) throw new ParserChangedError(`${ETABL_DOMAIN}: search returned products but none proved the requested brand`);
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = etablRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${ETABL_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, ETABL_TRANSLATE_HOST);
    const state = initialState(page.$, ETABL_DOMAIN);
    const product = (state.products as { product?: EtablProduct } | undefined)?.product;
    const id = String(product?.id ?? "");
    const exact = product ? etablRef(`https://${ETABL_DOMAIN}/product/${String(product.url ?? "")}`, id) : undefined;
    const title = product ? etablTitle(product) : "";
    if (!product || id !== ref.listingId || exact?.url !== parsedRef.url || !matchesBrand(title, ref.brand)) {
      throw new ParserChangedError(`${ETABL_DOMAIN}:${ref.listingId}: exact product identity changed`);
    }
    const reviews = exactInteger(product.reviewsStats?.reviewsCount);
    const value = exactRating(product.reviewsStats?.rating);
    if (reviews === undefined || reviews > 0 && value === undefined) {
      throw new ParserChangedError(`${ETABL_DOMAIN}:${ref.listingId}: complete reviewsStats is missing`);
    }
    return observation(this.evidence, ref, page, {
      domain: ETABL_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews,
      rating: reviews === 0 ? null : value!,
      source: "etabl-product-state:google-translate"
    });
  }
}

const BUD_DOMAIN = "budzdorov.ru";
const BUD_TRANSLATE_HOST = "www-budzdorov-ru.translate.goog";
const BUD_PRODUCT = /^\/product\/(?:[a-z0-9-]+-)?(\d+)\/?$/i;
const BUD_FORM_SLUG_ALIASES: Record<string, string> = {
  "оциллококцинум": "ocillokokcinum"
};

function budFormSlug(brand: string): string {
  const normalized = brand.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
  return BUD_FORM_SLUG_ALIASES[normalized] ?? transliterate(brand);
}

function budRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  const url = sourceHref(value, `www.${BUD_DOMAIN}`);
  if (!url || host(url.hostname) !== BUD_DOMAIN) return undefined;
  const id = url.pathname.match(BUD_PRODUCT)?.[1];
  if (!id || expectedId && id !== expectedId) return undefined;
  return { id, url: `https://www.${BUD_DOMAIN}${url.pathname}` };
}

type BudReview = { id?: unknown; ratings?: Array<{ attribute_code?: unknown; value?: unknown }> };

export class BudZdorovAdapter extends AdditionalPharmacyAdapter {
  readonly id = "budzdorov.ru:translated-review-state-v1";
  readonly supportedDomains = [BUD_DOMAIN, `www.${BUD_DOMAIN}`] as const;
  private readonly successfulDiscovery = new Map<string, ProductRef[]>();

  private discoveryKey(brand: string, context: AdapterContext): string {
    return `${context.runId ?? "standalone"}:${normalizeText(brand)}`;
  }

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    // Check the product family that this run is actually about. A transient
    // block on an unrelated canary must not prevent a healthy brand partition.
    return this.canary(context.brands?.[0]?.trim() || "Оциллококцинум", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(BUD_DOMAIN, brand, context, budRef);
    const cacheKey = this.discoveryKey(brand, context);
    const cached = this.successfulDiscovery.get(cacheKey);
    if (cached) {
      this.successfulDiscovery.delete(cacheKey);
      for (const ref of cached) refs.set(ref.listingId, { ...ref, metadata: { ...ref.metadata } });
      return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
    }
    const source = new URL(`https://www.${BUD_DOMAIN}/forms/${budFormSlug(brand)}`);
    const page = await requestPage(source, context, this.fetchImpl, BUD_TRANSLATE_HOST);
    const liveRefs = new Map<string, ProductRef>();
    page.$("a[href*='/product/']").each((_index, node) => {
      const parsed = budRef(page.$(node).attr("href") ?? "");
      const title = compactText(page.$(node).attr("title") || page.$(node).text());
      if (!parsed || !matchesBrand(title, brand)) return;
      liveRefs.set(parsed.id, {
        domain: BUD_DOMAIN, platform: BUD_DOMAIN, listingId: parsed.id, brand,
        url: parsed.url, title, metadata: { discovery: "translated-first-party-form-page" }
      });
    });
    if (!liveRefs.size && !refs.size) {
      const text = compactText(page.$("main, body").text());
      if (/ничего не найдено|товары не найдены|нет препаратов/i.test(text)) return [];
      throw new AdapterBlockedError(`${BUD_DOMAIN}: form page proved neither exact products nor no results`);
    }
    if (liveRefs.size) {
      const snapshot = [...liveRefs.values()].map((ref) => ({ ...ref, metadata: { ...ref.metadata } }));
      this.successfulDiscovery.set(cacheKey, snapshot);
      for (const ref of snapshot) refs.set(ref.listingId, ref);
    }
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = budRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, BUD_TRANSLATE_HOST);
    const title = compactText(page.$("h1").first().text());
    if (!matchesBrand(title, ref.brand)) throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: product brand changed`);
    const state = initialState(page.$, BUD_DOMAIN);
    const productView = state.productView as { reviews?: unknown } | undefined;
    const reviews = Array.isArray(productView?.reviews) ? productView.reviews as BudReview[] : undefined;
    const visibleCount = exactInteger(page.$("[allreviewsqty]").first().attr("allreviewsqty"));
    if (!reviews || visibleCount === undefined || visibleCount !== reviews.length) {
      throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: full review list is missing or incomplete`);
    }
    const ids = new Set<string>();
    let sum = 0;
    for (const review of reviews) {
      const id = String(review.id ?? "");
      const scores = (review.ratings ?? []).filter((item) => String(item.attribute_code ?? "").toLocaleLowerCase("ru-RU") === "оценка");
      const score = scores.length === 1 ? exactRating(scores[0].value) : undefined;
      if (!id || ids.has(id) || score === undefined) {
        throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: review identities or scores are incomplete`);
      }
      ids.add(id);
      sum += score;
    }
    const value = reviews.length ? Math.round(sum / reviews.length * 10) / 10 : null;
    return observation(this.evidence, ref, page, {
      domain: BUD_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews: reviews.length,
      rating: value,
      source: "budzdorov-complete-review-state:google-translate"
    });
  }
}

export class AptekaAprilAdapter extends AdditionalPharmacyAdapter {
  readonly id = "apteka-april.ru:blocked-free-mode-v1";
  readonly supportedDomains = ["apteka-april.ru", "www.apteka-april.ru"] as const;

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await requestPage(new URL("https://apteka-april.ru/robots.txt"), context, this.fetchImpl);
      return { ok: false, checkedAt, message: "apteka-april.ru: a verified free product profile is not available" };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(_brand: string, context: AdapterContext): Promise<ProductRef[]> {
    try {
      await requestPage(new URL("https://apteka-april.ru/robots.txt"), context, this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`apteka-april.ru: blocked_free_mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new AdapterBlockedError("apteka-april.ru: blocked_free_mode: no verified first-party search path");
  }

  async collect(): Promise<Observation> {
    throw new AdapterBlockedError("apteka-april.ru: blocked_free_mode");
  }
}

export function createAdditionalPharmacyAdapters(evidence: EvidenceStore, fetchImpl?: typeof fetch): SiteAdapter[] {
  return [
    new AptekaRuAdapter(evidence, fetchImpl),
    new NfAptekaAdapter(evidence, fetchImpl),
    new BudZdorovAdapter(evidence, fetchImpl),
    new EtablAdapter(evidence, fetchImpl),
    new AptekaAprilAdapter(evidence, fetchImpl)
  ];
}
