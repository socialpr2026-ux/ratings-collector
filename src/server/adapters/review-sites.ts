import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductEvidence, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { extractJsonLdProducts, type JsonLdProduct } from "../generic/jsonld.js";
import { aliasesForBrand, matchesBrand, normalizeRating } from "../utils/normalize.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { extractPageProductEvidence, titleProductEvidence } from "../utils/product-evidence.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./errors.js";

const MAX_SEARCH_PAGES = 20;
const MAX_PRODUCTS = 500;
const MEGAPTEKA_SEARCH_PAGE_SIZE = 40;
const BLOCK_MARKERS = /captcha|access denied|temporarily unavailable|доступ (?:ограничен|запрещен)|проверка браузера|не робот/i;
const PHARMACEUTICAL_REVIEW_TITLE = /(?:лекарственн|противовирусн|препарат|медицинск|ноотропн|гомеопат|средств|таблет|капсул|сироп|суспенз|раствор|спрей|мазь)/iu;
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const TRANSIENT_HTML_STATUSES = new Set([408, 425, 429, 499, 500, 502, 503, 504]);
const TERMINAL_RETRY_BODY = /captcha|access denied|forbidden|проверка\s+браузера|не\s+робот/iu;
const QUOTA_BODY = /monthly\s+sandbox[\s\S]{0,80}gb-s|(?:quota|limit)[\s\S]{0,80}(?:exceeded|exhausted|reached)|(?:лимит|квот\w*)[\s\S]{0,80}(?:исчерпан\w*|превышен\w*|законч\w*)/iu;
const TRANSIENT_TRANSPORT_ERROR = /fetch\s+failed|network|socket|econn|etimedout|headers?\s+timeout|request\s+exceeded|чтение\s+ответа\s+превысило|таймаут\s+внешнего\s+запроса|operation\s+was\s+aborted\s+due\s+to\s+timeout/iu;

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds <= 2_000 ? milliseconds : undefined;
  }
  return 100 + Math.floor(Math.random() * 151);
}

type ParsedMetrics = {
  title?: string;
  canonicalUrl?: string;
  listingId?: string;
  reviews?: number;
  rating?: number;
  ratingCount?: number;
  rawRating?: number;
  rawRatingScale?: number;
  source: string;
};

type MegaptekaSearchPayload = {
  items?: Array<{
    id?: number;
    code?: string;
    group_code?: string;
    name?: string;
  }>;
  search?: { empty_info?: unknown };
};

type ReviewSiteDefinition = {
  domain: string;
  origin: string;
  dynamicBrowser?: boolean;
  rateLimitMs?: number;
  healthCanary?: { url: string; brand: string };
  searchUrl(brand: string, context: AdapterContext): string;
  isProductUrl(url: URL): boolean;
  idFromUrl(url: URL): string | undefined;
  parse(html: string, pageUrl: string, brand: string): ParsedMetrics;
};

function isBlockPage(html: string): boolean {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ") ?? "";
  const sample = html.slice(0, 100_000);
  // A healthy iRecommend page preloads captcha-checker JavaScript. Only an
  // actual challenge element/page is blocking; a dormant script asset is not.
  const captcha = /<(?:input|iframe|form|img|div|section|body)\b[^>]*(?:id|class|name|src)=["'][^"']*(?:captcha|db-offline|in-maintenance)/i.test(sample) ||
    /(?:подтвердите,?\s+что\s+вы\s+не\s+робот|провер(?:ка|яем)\s+(?:ваш(?:е|его)\s+)?(?:браузера|соединение)|verify\s+you\s+are\s+human)/iu.test(sample);
  const aggregateMetrics = /itemprop=["']reviewCount["']/i.test(sample) || /"reviewCount"\s*:/i.test(sample);
  const searchMetrics = /ProductTizer/i.test(sample) && /read-all-reviews-link/i.test(sample) &&
    /average-rating/i.test(sample);
  return BLOCK_MARKERS.test(title) || captcha && !aggregateMetrics && !searchMetrics;
}

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\s\u00a0]/g, "").replace(",", ".");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integerFrom(value: string | undefined): number | undefined {
  const parsed = numberFrom(value);
  return parsed === undefined || parsed < 0 ? undefined : Math.trunc(parsed);
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function latinSlug(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value.toLocaleLowerCase("ru-RU").split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function brandSlugs(brand: string): string[] {
  return [...new Set(aliasesForBrand(brand).map(latinSlug).filter(Boolean))];
}

function ruOtzyvBrandSlugs(brand: string): string[] {
  const aliases = aliasesForBrand(brand);
  return [...new Set([
    ...aliases.map(latinSlug),
    // ru.otzyv.com conventionally writes Cyrillic "ц" as "ts" (Кагоцел ->
    // kagotsel), while the other reviewed sites use the shorter "c" form.
    ...aliases.map((alias) => latinSlug(alias.replace(/ц/giu, "тс")))
  ].filter(Boolean))];
}

function sameSite(url: URL, domain: string): boolean {
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  return host === domain || host.endsWith(`.${domain}`);
}

function canonicalOtzovikProductUrl(value: string | URL): string | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || !sameSite(url, "otzovik.com")) return undefined;
    const slug = url.pathname.match(/^\/reviews\/([a-z0-9_-]+)\/?$/i)?.[1];
    if (!slug) return undefined;
    // The static product gateway deliberately accepts only the apex host and
    // an exact product path. Old Sheet/registry URLs may retain www or view
    // parameters, so normalize them before identity deduplication and fetch.
    return `https://otzovik.com/reviews/${slug}/`;
  } catch {
    return undefined;
  }
}

function absoluteProductUrl(value: string | undefined, base: string, definition: ReviewSiteDefinition): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || !sameSite(url, definition.domain) || !definition.isProductUrl(url)) return undefined;
    return canonicalizeUrl(url.toString());
  } catch {
    return undefined;
  }
}

const OTZYV_PRO_EDITORIAL_SUBJECT = /(?:отзыв(?:ы)?\s+(?:врач(?:ей|а)?|невролог(?:ов|а)?|пациент(?:ов|а)?)|инструкц(?:ия|ии)\s+по\s+применению|совет(?:ы|ов)?\s+и\s+инструкц)/iu;
const DEDICATED_FAMILY_DOMAINS = new Set(["irecommend.ru", "otzovik.com", "otzyv.pro"]);

function isExplicitNonProductReviewPage(html: string, definition: ReviewSiteDefinition): boolean {
  if (definition.domain !== "otzyv.pro") return false;
  const $ = load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const itemReviewed = $("[itemprop='itemReviewed']").first().attr("content") ??
    $("[itemprop='itemReviewed']").first().text().replace(/\s+/g, " ").trim();
  const hasAggregate = $("[itemprop='aggregateRating'], [itemprop='reviewCount'], [itemprop='ratingValue']").length > 0 ||
    /"aggregateRating"\s*:|"reviewCount"\s*:|"ratingValue"\s*:/i.test(html);
  // Otzyv.pro search mixes product aggregates with editorial advice pages.
  // Some single-review articles also expose reviewCount=1/ratingValue=5 as
  // microdata for that author's review. The itemReviewed/title still names an
  // audience or an instruction, not a product. Reject that prose even when it
  // carries rating markup; ordinary product/form titles remain eligible.
  const editorialSubject = OTZYV_PRO_EDITORIAL_SUBJECT.test(itemReviewed || title);
  return editorialSubject || !hasAggregate && /(?:советы\s+и\s+инструкции|стать[ьяи]|справочн)/iu.test(title);
}

function dedicatedFamilyEvidence(
  evidence: ProductEvidence,
  definition: ReviewSiteDefinition,
  listingId: string,
  title: string,
  brand: string
): ProductEvidence {
  if (
    evidence.scope !== "product_family" ||
    !DEDICATED_FAMILY_DOMAINS.has(definition.domain) ||
    !listingId.trim() ||
    !matchesBrand(title, brand)
  ) return evidence;

  // Search/aggregate parsing has already bound title, stable page id and
  // metrics to one first-party card. Preserve that dedicated page title as
  // its single family option so legitimate form-specific aggregates are not
  // mistaken for one collapsed generic product. Review bodies never take
  // part in this proof.
  const productId = evidence.identifiers.some((identifier) =>
    identifier.type === "product_id" && identifier.value === listingId
  ) ? [] : [{ type: "product_id" as const, value: listingId }];
  return {
    ...evidence,
    variants: evidence.variants.length ? evidence.variants : [title],
    identifiers: [...evidence.identifiers, ...productId]
  };
}

function jsonLdMetrics(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const products = extractJsonLdProducts(html, pageUrl);
  const canonicalPageUrl = canonicalizeUrl(pageUrl);
  const exact = products.filter((item) => item.url && canonicalizeUrl(item.url) === canonicalPageUrl);
  const branded = products.filter((item) => matchesBrand(item.name ?? "", brand));
  // Recommendation and analogue widgets frequently expose their own Product
  // JSON-LD. Never borrow the first same-brand aggregate: accept one exact
  // canonical Product, or a single unambiguous Product when the site omits URL.
  const product = exact.length === 1
    ? exact[0]
    : products.length === 1 && branded.length === 1
      ? products[0]
      : undefined;
  return product ? metricsFromProduct(product) : { source: "visible-dom" };
}

function metricsFromProduct(product: JsonLdProduct): ParsedMetrics {
  return {
    title: product.name,
    canonicalUrl: product.url,
    listingId: product.sku ?? product.productId,
    reviews: product.reviewCount === undefined ? undefined : Math.max(0, Math.trunc(product.reviewCount)),
    rating: product.rating,
    ratingCount: product.ratingCount === undefined ? undefined : Math.max(0, Math.trunc(product.ratingCount)),
    rawRating: product.rating,
    rawRatingScale: product.ratingScale,
    source: "json-ld"
  };
}

function firstText($: CheerioAPI, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = (node.attr("content") ?? node.text()).replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return undefined;
}

function parseMegaptekaReviews(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const definition = REVIEW_SITE_DEFINITIONS.find((item) => item.domain === "megapteka.ru")!;
  const base = microdataMetrics(html, pageUrl, brand, definition);
  const $ = load(html);
  const title = $("title").text().replace(/\s+/g, " ").trim();
  const body = $.root().text().replace(/\s+/g, " ");
  let feedback: { avg?: number; count?: number; fill_count?: number } | undefined;
  const feedbackObject = html.match(/"feedback"\s*:\s*(\{(?=[^{}]{0,1000}"(?:fill_count|count|avg)"\s*:)[^{}]{0,1000}\})/i)?.[1];
  if (feedbackObject) {
    try { feedback = JSON.parse(feedbackObject) as { avg?: number; count?: number; fill_count?: number }; }
    catch { /* malformed optional transfer state */ }
  }
  const textualReviews = integerFrom(
    title.match(/-\s*([\d\s\u00a0]+)\s+отзыв/i)?.[1] ??
    body.match(/Отзывы\s*\(([\d\s\u00a0]+)\)/i)?.[1]
  );
  return {
    ...base,
    title: base.title ?? title.replace(/\s*-\s*\d+\s+отзыв.*$/i, "").trim(),
    reviews: feedback?.fill_count ?? (feedback?.count === 0 ? 0 : undefined) ?? textualReviews ?? base.reviews,
    rating: feedback?.avg ?? base.rating,
    ratingCount: feedback?.count ?? base.ratingCount ?? base.reviews,
    rawRating: feedback?.avg ?? base.rawRating,
    source: "megapteka-reviews"
  };
}

function megaptekaFamilySlug(html: string, brand: string): string | undefined {
  const $ = load(html);
  let resolved: string | undefined;
  $("script[type='application/ld+json']").each((_index, node) => {
    if (resolved) return;
    try {
      const value = JSON.parse($(node).text()) as { "@type"?: string; itemListElement?: Array<{ name?: string; item?: string }> };
      if (value["@type"] !== "BreadcrumbList") return;
      for (const item of value.itemListElement ?? []) {
        if (!item.item || !matchesBrand(item.name ?? "", brand)) continue;
        const url = new URL(item.item, "https://megapteka.ru/");
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 2 && parts[0] !== "product" && parts[0] !== "catalog") resolved = parts[1];
      }
    } catch { /* malformed optional breadcrumb JSON-LD */ }
  });
  return resolved;
}

function canonicalFromPage($: CheerioAPI, pageUrl: string, definition: ReviewSiteDefinition): string | undefined {
  return absoluteProductUrl($("link[rel='canonical']").attr("href"), pageUrl, definition);
}

function microdataMetrics(html: string, pageUrl: string, brand: string, definition: ReviewSiteDefinition): ParsedMetrics {
  const $ = load(html);
  const json = jsonLdMetrics(html, pageUrl, brand);
  const aggregates = $("[itemprop='aggregateRating']");
  const uniqueMetric = (property: string): string | undefined => {
    if (aggregates.length > 1) return undefined;
    const nodes = aggregates.length === 1
      ? aggregates.first().find(`[itemprop='${property}']`)
      : $(`[itemprop='${property}']`);
    if (nodes.length !== 1) return undefined;
    return nodes.first().attr("content") ?? nodes.first().text();
  };
  const rawRating = numberFrom(uniqueMetric("ratingValue"));
  const bestRating = numberFrom(uniqueMetric("bestRating")) ?? 5;
  const reviews = integerFrom(uniqueMetric("reviewCount"));
  const text = $.root().text().replace(/\s+/g, " ");
  const confirmedZero = /(?:отзывов пока нет|нет отзывов|(?:^|[^\d])0\s+отзыв)/i.test(text);
  return {
    title: json.title ?? firstText($, ["h1[itemprop='name']", "h1", "meta[property='og:title']"]),
    canonicalUrl: json.canonicalUrl ?? canonicalFromPage($, pageUrl, definition),
    listingId: json.listingId,
    reviews: json.reviews ?? reviews ?? (confirmedZero ? 0 : undefined),
    rating: json.rating ?? (rawRating === undefined ? undefined : normalizeRating(rawRating, bestRating)),
    ratingCount: json.ratingCount,
    rawRating: json.rawRating ?? rawRating,
    rawRatingScale: json.rawRatingScale ?? bestRating,
    source: json.source === "json-ld" ? "json-ld" : "microdata"
  };
}

function parseIrecommend(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const $ = load(html);
  const text = $.root().text().replace(/\s+/g, " ").trim();
  const rawRating = numberFrom(
    firstText($, [".fivestar-summary .average-rating span", ".average-rating span"]) ??
    text.match(/Среднее\s*:\s*(?:Среднее\s*:\s*)?(\d+(?:[.,]\d+)?)/i)?.[1]
  );
  const ratingCount = integerFrom(text.match(/\(([\d\s\u00a0]+)\s+голос/i)?.[1]);
  const explicitReviews = integerFrom(
    firstText($, [".read-all-reviews-link .counter"]) ??
    text.match(/Читать\s+все\s+отзывы\s*([\d\s\u00a0]+)/i)?.[1]
  );
  const confirmedZero = /(?:отзывов пока нет|нет отзывов|(?:^|[^\d])0\s+отзыв)/i.test(text);
  const allReviewsHref = $("a").filter((_index, node) => /читать\s+все\s+отзывы/i.test($(node).text())).first().attr("href");
  const definition = REVIEW_SITE_DEFINITIONS.find((item) => item.domain === "irecommend.ru")!;
  const canonicalUrl = absoluteProductUrl(allReviewsHref, pageUrl, definition) ?? canonicalFromPage($, pageUrl, definition);
  const noderefHref = $("a[href*='noderef=']").first().attr("href");
  let noderef: string | undefined;
  try { noderef = noderefHref ? new URL(noderefHref, pageUrl).searchParams.get("noderef") ?? undefined : undefined; }
  catch { /* malformed optional add-review link */ }
  const json = jsonLdMetrics(html, pageUrl, brand);
  return {
    title: json.title ?? firstText($, ["[itemprop='itemReviewed'] [itemprop='name']", "h1", ".product-header"]),
    canonicalUrl: canonicalUrl ?? json.canonicalUrl,
    listingId: noderef,
    reviews: explicitReviews ?? json.reviews ?? (confirmedZero ? 0 : undefined),
    rating: rawRating ?? json.rating,
    ratingCount: ratingCount ?? json.ratingCount,
    rawRating: rawRating ?? json.rawRating,
    rawRatingScale: 5,
    source: "irecommend-visible"
  };
}

function parseOtzovik(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const definition = REVIEW_SITE_DEFINITIONS.find((item) => item.domain === "otzovik.com")!;
  const parsed = microdataMetrics(html, pageUrl, brand, definition);
  const $ = load(html);
  const listingId = $("[data-pid]").first().attr("data-pid")?.trim();
  return { ...parsed, listingId: listingId && /^\d+$/.test(listingId) ? listingId : parsed.listingId };
}

function parseVseotzyvy(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const definition = REVIEW_SITE_DEFINITIONS.find((item) => item.domain === "vseotzyvy.ru")!;
  const base = microdataMetrics(html, pageUrl, brand, definition);
  if (base.reviews !== undefined && (base.reviews === 0 || base.rating !== undefined)) return base;

  const $ = load(html);
  const text = $.root().text().replace(/\s+/g, " ").trim();
  const title = firstText($, ["h1"]);
  const reviews = integerFrom(
    text.match(/Отзывы\s+покупателей\s+о\s+.+?\(([\d\s\u00a0]+)\s+отзыв/iu)?.[1] ??
    text.match(/(?:^|\s)([\d\s\u00a0]+)\s+отзыв(?:а|ов)?(?:\s|$)/iu)?.[1]
  );
  const rawRating = numberFrom(
    $("img[alt*='Оценка'][alt*='из 5']").first().attr("alt")
      ?.match(/Оценка\s+([\d.,]+)\s+из\s+5/iu)?.[1] ??
    text.match(/(?:^|\s)([\d.,]+)\s*[·•]\s*[\d\s\u00a0]+\s+оцен/iu)?.[1]
  );
  const canonicalUrl = canonicalFromPage($, pageUrl, definition) ?? canonicalizeUrl(pageUrl);
  const listingId = definition.idFromUrl(new URL(canonicalUrl));
  return {
    title,
    canonicalUrl,
    listingId,
    reviews,
    rating: reviews === 0 ? undefined : rawRating,
    ratingCount: reviews,
    rawRating,
    rawRatingScale: 5,
    source: "vseotzyvy-visible-aggregate"
  };
}

function otzyvruOrganizationMetrics(html: string, pageUrl: string, brand: string): ParsedMetrics | undefined {
  const $ = load(html);
  const page = canonicalizeUrl(pageUrl);
  const candidates: ParsedMetrics[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    visit(node["@graph"]);
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (!types.some((type) => String(type).toLocaleLowerCase("en-US") === "organization")) return;
    const name = typeof node.name === "string" ? node.name.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
    const aggregate = node.aggregateRating;
    if (!name || !matchesBrand(name, brand) || !aggregate || typeof aggregate !== "object") return;
    let sourceUrl: string;
    try { sourceUrl = canonicalizeUrl(new URL(String(node.url ?? ""), pageUrl).toString()); }
    catch { return; }
    if (sourceUrl !== page) return;
    const rating = aggregate as Record<string, unknown>;
    const reviews = integerFrom(String(rating.reviewCount ?? ""));
    const ratingCount = integerFrom(String(rating.ratingCount ?? ""));
    const rawRating = numberFrom(String(rating.ratingValue ?? ""));
    const scale = numberFrom(String(rating.bestRating ?? "5")) ?? 5;
    if (reviews === undefined || rawRating === undefined || scale <= 0 || scale > 5 || rawRating <= 0 || rawRating > scale) return;
    candidates.push({
      title: name,
      canonicalUrl: sourceUrl,
      reviews,
      rating: normalizeRating(rawRating, scale),
      ratingCount,
      rawRating,
      rawRatingScale: scale,
      source: "otzyvru-json-ld-organization"
    });
  };
  $("script[type='application/ld+json']").each((_index, node) => {
    try { visit(JSON.parse($(node).text()) as unknown); }
    catch { /* malformed unrelated JSON-LD */ }
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function parseOtzyvru(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const definition = REVIEW_SITE_DEFINITIONS.find((item) => item.domain === "otzyvru.com")!;
  const parsed = microdataMetrics(html, pageUrl, brand, definition);
  const organization = otzyvruOrganizationMetrics(html, pageUrl, brand);
  const $ = load(html);
  const summary = $(".item-card #descr").first();
  const visibleRating = summary.length === 1 ? numberFrom(summary.find(".rtng_value").first().text()) : undefined;
  const bestRating = summary.length === 1 ? numberFrom(summary.find(".rtng_best").first().text()) ?? 5 : 5;
  const visibleReviews = summary.length === 1 ? integerFrom(summary.find(".reviews_count").first().text()) : undefined;
  if (organization && visibleReviews !== undefined && organization.reviews !== visibleReviews) {
    throw new ParserChangedError("otzyvru.com: JSON-LD и видимый счетчик отзывов расходятся");
  }
  if (organization && visibleRating !== undefined && organization.rating !== normalizeRating(visibleRating, bestRating)) {
    throw new ParserChangedError("otzyvru.com: JSON-LD и видимый рейтинг расходятся");
  }
  const numericId = $("h1[data-id]").first().attr("data-id")?.trim();
  return {
    ...parsed,
    title: organization?.title ?? parsed.title ?? firstText($, ["h1", "#itemname"]),
    canonicalUrl: organization?.canonicalUrl ?? parsed.canonicalUrl,
    listingId: numericId && /^\d+$/.test(numericId) ? numericId : parsed.listingId,
    reviews: organization?.reviews ?? visibleReviews ?? parsed.reviews,
    rating: organization?.rating ?? (visibleRating === undefined ? parsed.rating : normalizeRating(visibleRating, bestRating)),
    ratingCount: organization?.ratingCount ?? parsed.ratingCount,
    rawRating: organization?.rawRating ?? visibleRating ?? parsed.rawRating,
    rawRatingScale: organization?.rawRatingScale ?? (visibleRating === undefined ? parsed.rawRatingScale : bestRating),
    source: organization?.source ?? (visibleReviews !== undefined && visibleRating !== undefined ? "otzyvru-visible" : parsed.source)
  };
}

function parsePravogolosa(html: string, pageUrl: string, brand: string): ParsedMetrics {
  const $ = load(html);
  const text = $.root().text().replace(/\s+/g, " ").trim();
  const title = firstText($, ["h1.contentheading", "h1"]);
  const reviews = integerFrom(text.match(/все\s+отзывы\s+([\d\s\u00a0]+)/iu)?.[1]);
  const rawRating = numberFrom(
    $("[title*='Рейтинг::Оценка объекта отзыва']").first().attr("title")
      ?.match(/([\d.,]+)\s+из\s+5/iu)?.[1]
  );
  return {
    title,
    canonicalUrl: pageUrl,
    listingId: new URL(pageUrl).searchParams.get("catid") ?? undefined,
    reviews,
    rating: rawRating,
    ratingCount: reviews,
    rawRating,
    rawRatingScale: 5,
    source: "pravogolosa-category-summary"
  };
}

function pageId(pattern: RegExp, url: URL): string | undefined {
  return url.pathname.match(pattern)?.[1];
}

function megaptekaCity(html: string): { id: number; code: string } | undefined {
  const match = html.match(/"city"\s*:\s*\{\s*"id"\s*:\s*(\d+)\s*,\s*"code"\s*:\s*"([a-z0-9-]+)"/i);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? { id, code: match[2] } : undefined;
}

export const REVIEW_SITE_DEFINITIONS: readonly ReviewSiteDefinition[] = [
  {
    domain: "irecommend.ru",
    origin: "https://irecommend.ru/",
    dynamicBrowser: true,
    rateLimitMs: 3200,
    searchUrl: (brand) => `https://irecommend.ru/srch?query=${encodeURIComponent(brand)}`,
    isProductUrl: (url) => /^\/content\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname),
    idFromUrl: (url) => hashId(`${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`),
    parse: parseIrecommend
  },
  {
    domain: "otzyv.pro",
    origin: "https://otzyv.pro/",
    rateLimitMs: 700,
    // The live search access rule distinguishes the raw percent-escape case:
    // uppercase `%D0...` redirects to the same lowercase URL and loops, while
    // the site's own lowercase form is stable.
    searchUrl: (brand) => `https://otzyv.pro/?do=search&subaction=search&story=${
      encodeURIComponent(brand).replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase())
    }`,
    isProductUrl: (url) => /^\/category\/.+\/\d+-[^/]+\.html$/i.test(url.pathname),
    idFromUrl: (url) => pageId(/\/(\d+)-[^/]+\.html$/i, url),
    parse: (html, pageUrl, brand) => microdataMetrics(html, pageUrl, brand, REVIEW_SITE_DEFINITIONS[1])
  },
  {
    domain: "vseotzyvy.ru",
    origin: "https://vseotzyvy.ru/",
    rateLimitMs: 700,
    healthCanary: {
      url: "https://vseotzyvy.ru/otzyvy/kagotsel-49555",
      brand: "Кагоцел"
    },
    searchUrl: (brand) => `https://vseotzyvy.ru/search?q=${encodeURIComponent(brand)}`,
    isProductUrl: (url) => /^\/item\/\d+\/reviews-[^/]+\/?$/i.test(url.pathname) ||
      /^\/otzyvy\/[a-z0-9-]+-\d+\/?$/i.test(url.pathname),
    idFromUrl: (url) => pageId(/^\/item\/(\d+)\//i, url) ?? pageId(/-(\d+)\/?$/i, url),
    parse: parseVseotzyvy
  },
  {
    domain: "otzyvru.com",
    origin: "https://www.otzyvru.com/",
    rateLimitMs: 700,
    searchUrl: (brand) => `https://www.otzyvru.com/search/?q=${encodeURIComponent(brand)}`,
    isProductUrl: (url) => /^\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname) && !/^\/(?:search|login|register|about|contact-us)\/?$/i.test(url.pathname),
    idFromUrl: (url) => pageId(/\/(?:amp\/)?([a-z0-9][a-z0-9-]*)\/?$/i, url),
    parse: parseOtzyvru
  },
  {
    domain: "uteka.ru",
    origin: "https://uteka.ru/",
    rateLimitMs: 700,
    healthCanary: {
      url: "https://uteka.ru/lekarstvennye-sredstva/krov-i-krovoobrashhenie/tikalizis/reviews/",
      brand: "Тикализис"
    },
    searchUrl: () => "https://uteka.ru/sitemaps/sitemap-reviews.xml",
    isProductUrl: (url) => /\/reviews\/$/i.test(url.pathname),
    idFromUrl: (url) => hashId(`${url.hostname.replace(/^www\./, "")}${url.pathname}`),
    parse: (html, pageUrl, brand) => microdataMetrics(html, pageUrl, brand, REVIEW_SITE_DEFINITIONS[4])
  },
  {
    domain: "megapteka.ru",
    origin: "https://megapteka.ru/",
    rateLimitMs: 700,
    healthCanary: {
      url: "https://megapteka.ru/tomsk/catalog/protivovirusnoe-dejstvie-70/kagocel-tab-12mg-901309",
      brand: "Кагоцел"
    },
    searchUrl: (brand) => `https://megapteka.ru/search?q=${encodeURIComponent(brand)}`,
    isProductUrl: (url) => /^\/(?:[a-z0-9-]+\/)?catalog\/.+-\d+\/?$/i.test(url.pathname),
    idFromUrl: (url) => pageId(/-(\d+)\/?$/i, url),
    parse: parseMegaptekaReviews
  },
  {
    domain: "otzovik.com",
    origin: "https://otzovik.com/",
    rateLimitMs: 3200,
    healthCanary: {
      url: "https://otzovik.com/reviews/protivovirusniy_preparat_kagocel/",
      brand: "Кагоцел"
    },
    searchUrl: (brand) => `https://otzovik.com/__external_search__?brand=${encodeURIComponent(brand)}`,
    isProductUrl: (url) => /^\/reviews\/[a-z0-9_-]+\/?$/i.test(url.pathname),
    idFromUrl: (url) => hashId(`${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`),
    parse: parseOtzovik
  },
  {
    domain: "pravogolosa.net",
    origin: "https://pravogolosa.net/",
    rateLimitMs: 4200,
    searchUrl: (brand) => {
      const url = new URL("https://pravogolosa.net/otzyvcategory");
      url.searchParams.set("catid", "0");
      url.searchParams.set("page", "search");
      url.searchParams.set("text_search", brand);
      return url.toString();
    },
    isProductUrl: (url) => url.pathname === "/otzyvcategory" && url.searchParams.get("page") === "show_category" && /^\d+$/.test(url.searchParams.get("catid") ?? ""),
    idFromUrl: (url) => url.searchParams.get("catid") ?? undefined,
    parse: parsePravogolosa
  },
  {
    domain: "ru.otzyv.com",
    origin: "https://ru.otzyv.com/",
    rateLimitMs: 700,
    healthCanary: {
      url: "https://ru.otzyv.com/kagotsel",
      brand: "Кагоцел"
    },
    // The live search route applies a case-sensitive access rule to Cyrillic
    // queries: its own lowercase form is stable while title-case can return
    // 403 for the same exact brand.
    searchUrl: (brand) => `https://ru.otzyv.com/search/?q=${encodeURIComponent(brand.toLocaleLowerCase("ru-RU"))}`,
    isProductUrl: (url) => /^\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname) && !/^\/(?:login|register|meditsina|search)\/?$/i.test(url.pathname),
    idFromUrl: (url) => pageId(/^\/([a-z0-9][a-z0-9-]*)\/?$/i, url),
    parse: (html, pageUrl, brand) => microdataMetrics(html, pageUrl, brand, REVIEW_SITE_DEFINITIONS[8])
  }
];

// These sites cannot currently provide a product-bound public review aggregate:
// Medum blocks the free paths, while Magnit and eTabl expose only hidden
// aggregates without a proven customer-visible block.
// Keep every path explicit and fail closed instead of publishing zeroes.
export const BLOCKED_FREE_MODE_DOMAINS = ["medum.ru"] as const;
export const UNPROVEN_AGGREGATE_DOMAINS = ["apteka.magnit.ru", "etabl.ru"] as const;
const PRAVOGOLOSA_HEALTH_CANARY = "ratingscollector-healthcheck-7f4c2a";

function paginationCandidates($: CheerioAPI, pageUrl: string, definition: ReviewSiteDefinition): string[] {
  const result = new Set<string>();
  $("a[rel='next'], .pagination a, .pager a, .pages a, [class*='pagination'] a").each((_index, node) => {
    const href = $(node).attr("href");
    if (!href) return;
    try {
      const target = new URL(href, pageUrl);
      if (target.protocol !== "https:" || !sameSite(target, definition.domain)) return;
      const isSearch = /(?:search|srch)/i.test(target.pathname) || target.searchParams.get("do") === "search" || target.searchParams.has("search_text");
      const hasPage = [...target.searchParams.keys()].some((key) => /^(?:page|p|start|search_start|result_from)$/i.test(key));
      if (isSearch && hasPage) result.add(canonicalizeUrl(target.toString()));
    } catch { /* malformed pagination link */ }
  });
  return [...result];
}

function hasExplicitSearchNoResults($: CheerioAPI, brand: string, domain: string): boolean {
  const text = $.root().text().replace(/\s+/g, " ").trim();
  if (domain === "otzyv.pro") return /Ничего не найдено!/iu.test(text);
  if (domain === "vseotzyvy.ru") {
    const query = $("input[name='q'], input[type='search']").first().attr("value")?.replace(/\s+/g, " ").trim();
    return matchesBrand(query || text, brand) &&
      /(?:Ничего не найдено|По вашему запросу ничего не найдено|Подходящих объектов не найдено|Найдено\s+0\s+результат)/iu.test(text);
  }
  if (domain === "irecommend.ru") {
    const heading = $("h1").first().text().replace(/\s+/g, " ").trim();
    return matchesBrand(heading, brand) && /Не нашли\?\s*Попробуйте поиск по сайту/iu.test(text);
  }
  if (domain === "otzyvru.com" || domain === "ru.otzyv.com") {
    const query = $("input[name='q']").first().attr("value")?.replace(/\s+/g, " ").trim();
    const heading = $("h1").first().text().replace(/\s+/g, " ").trim();
    return matchesBrand(query || heading, brand) &&
      /(?:найдено\s+результатов\s*:\s*0|найдено\s*:\s*0\s+результат)/iu.test(text);
  }
  return false;
}

async function readHtml(
  url: string,
  context: AdapterContext,
  fallbackFetch: typeof fetch | undefined,
  dynamicBrowser = false,
  captureUnsafeRedirect = false
): Promise<{ html: string; status: number; redirectLocation?: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await safeFetch(url, {
        signal: context.signal,
        headers: dynamicBrowser
          ? { "x-ratings-browser": "1", "x-ratings-scroll": "1" }
          : undefined
      }, context.fetch ?? fallbackFetch, 4, dynamicBrowser ? 90_000 : 45_000, {
        returnUnsafeRedirectResponse: captureUnsafeRedirect
      });
      const html = await readTextBounded(response, 12_000_000, 60_000);
      if (!response.ok && QUOTA_BODY.test(html.slice(0, 200_000))) {
        throw new AdapterQuotaError(`${new URL(url).hostname}: provider quota is exhausted`);
      }
      const backoff = retryDelay(response);
      const retryable = attempt === 1 && TRANSIENT_HTML_STATUSES.has(response.status) &&
        !TERMINAL_RETRY_BODY.test(html.slice(0, 200_000)) && backoff !== undefined;
      if (retryable) {
        await delay(backoff);
        context.signal?.throwIfAborted();
        continue;
      }
      return {
        html,
        status: response.status,
        redirectLocation: response.headers.get("location") ?? undefined
      };
    } catch (error) {
      lastError = error;
      const terminal = error instanceof AdapterQuotaError ||
        TERMINAL_RETRY_BODY.test(error instanceof Error ? error.message : String(error)) ||
        QUOTA_BODY.test(error instanceof Error ? error.message : String(error));
      const transient = TRANSIENT_TRANSPORT_ERROR.test(error instanceof Error ? error.message : String(error));
      if (attempt === 2 || context.signal?.aborted || terminal || error instanceof AdapterBlockedError ||
        error instanceof ParserChangedError || !transient) throw error;
      await delay(100 + Math.floor(Math.random() * 151));
      context.signal?.throwIfAborted();
    }
  }
  throw lastError;
}

function isRetiredVseotzyvyRedirect(requestedUrl: string, location: string | undefined): boolean {
  if (!location) return false;
  try {
    const target = new URL(location, requestedUrl);
    return target.protocol === "http:" && sameSite(target, "vseotzyvy.ru") &&
      target.pathname === "/" && !target.search && !target.hash;
  } catch {
    return false;
  }
}

export class ReviewSiteAdapter implements SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];
  private nextRequestAt = 0;
  private utekaSitemap?: string;
  private megaptekaCity?: { id: number; code: string };

  constructor(
    private readonly definition: ReviewSiteDefinition,
    private readonly evidence: EvidenceStore,
    private readonly fallbackFetch?: typeof fetch,
    private readonly rateLimitMs = definition.rateLimitMs ?? 700
  ) {
    this.id = `review-site:${definition.domain}:v1`;
    this.supportedDomains = [definition.domain, `www.${definition.domain}`];
  }

  private async throttle(): Promise<void> {
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait) await delay(wait);
    this.nextRequestAt = Date.now() + this.rateLimitMs;
  }

  private async request(url: string, context: AdapterContext, captureUnsafeRedirect = false) {
    await this.throttle();
    return readHtml(url, context, this.fallbackFetch, this.definition.dynamicBrowser, captureUnsafeRedirect);
  }

  private async requestJson(url: string, context: AdapterContext): Promise<{ payload: unknown; status: number }> {
    await this.throttle();
    const response = await safeFetch(url, {
      signal: context.signal,
      headers: { accept: "application/json", origin: "https://megapteka.ru", referer: "https://megapteka.ru/" }
    }, context.fetch ?? this.fallbackFetch, 4, 45_000);
    const text = await readTextBounded(response, 2_000_000, 45_000);
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new ParserChangedError("megapteka.ru search API вернул невалидный JSON"); }
    return { payload, status: response.status };
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      if (this.definition.domain === "pravogolosa.net") {
        const refs = await this.discoverPravogolosa(PRAVOGOLOSA_HEALTH_CANARY, context);
        if (refs.length !== 0) {
          return {
            ok: false,
            checkedAt,
            message: "pravogolosa.net health canary unexpectedly returned review cards"
          };
        }
        return {
          ok: true,
          checkedAt,
          message: "pravogolosa.net search returned an explicit no-results proof"
        };
      }
      if (this.definition.domain === "irecommend.ru") {
        // The canary must exercise the same reachable search that this run is
        // about. A stale cached response for an unrelated hard-coded brand
        // must not block an otherwise provable requested product.
        const canaryBrand = context.brands?.find((brand) => brand.trim()) ?? "Кагоцел";
        const refs = await this.discoverIrecommend(canaryBrand, context);
        if (refs.length === 0) {
          return {
            ok: true,
            checkedAt,
            message: `irecommend.ru search proved no current product for ${canaryBrand}`
          };
        }
        const proved = refs.find((ref) => {
          try {
            const target = new URL(ref.url);
            return /^\d+$/.test(ref.listingId) && sameSite(target, "irecommend.ru") &&
              this.definition.isProductUrl(target) && matchesBrand(ref.title ?? "", canaryBrand);
          } catch {
            return false;
          }
        });
        if (!proved) {
          return { ok: false, checkedAt, message: "irecommend.ru search has no exact product identity proof" };
        }
        return {
          ok: true,
          checkedAt,
          message: `irecommend.ru search proved exact product ${proved.listingId}`
        };
      }
      if (this.definition.domain === "uteka.ru") {
        // Uteka discovery is backed by its first-party reviews sitemap. Do not
        // block every requested brand because an unrelated hard-coded product
        // canary was removed or temporarily rendered without its aggregate.
        // Each discovered target page is still parsed strictly in collect().
        const { html, status } = await this.request("https://uteka.ru/sitemaps/sitemap-reviews.xml", context);
        if (status < 200 || status >= 300) return { ok: false, checkedAt, message: `HTTP ${status}` };
        const completeReviewsSitemap = /<urlset\b/i.test(html) && /<\/urlset>/i.test(html) &&
          /<loc>\s*https:\/\/uteka\.ru\/[^<]*\/reviews\/\s*<\/loc>/i.test(html);
        if (!completeReviewsSitemap) {
          return { ok: false, checkedAt, message: "parser_changed: Uteka reviews sitemap is incomplete" };
        }
        this.utekaSitemap = html;
        return { ok: true, checkedAt, message: "uteka.ru: official reviews sitemap is complete" };
      }
      const target = this.definition.healthCanary?.url ?? this.definition.origin;
      const { html, status } = await this.request(target, context);
      if (status < 200 || status >= 300) return { ok: false, checkedAt, message: `HTTP ${status}` };
      if (isBlockPage(html)) return { ok: false, checkedAt, message: "Защитная страница вместо площадки" };
      if (this.definition.healthCanary) {
        const parsed = this.definition.parse(html, target, this.definition.healthCanary.brand);
        if (parsed.reviews === undefined) {
          return { ok: false, checkedAt, message: "parser_changed: canary не содержит reviewCount письменных отзывов" };
        }
        if (parsed.reviews > 0 && (parsed.rating === undefined || parsed.rating <= 0 || parsed.rating > 5)) {
          return { ok: false, checkedAt, message: "parser_changed: canary содержит отзывы без корректного рейтинга" };
        }
        return {
          ok: true,
          checkedAt,
          message: `${this.definition.domain}: canary reviewCount=${parsed.reviews}, rating=${parsed.rating ?? "n/a"}`
        };
      }
      return { ok: true, checkedAt, message: `HTTP ${status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        checkedAt,
        message: error instanceof AdapterBlockedError ? `blocked: ${message}` :
          error instanceof ParserChangedError ? `parser_changed: ${message}` : message
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    if (this.definition.domain === "uteka.ru") return this.discoverUteka(brand, context);
    if (this.definition.domain === "megapteka.ru") return this.discoverMegapteka(brand, context);
    if (this.definition.domain === "irecommend.ru") return this.discoverIrecommend(brand, context);
    if (this.definition.domain === "otzovik.com") return this.discoverOtzovik(brand, context);
    if (this.definition.domain === "otzyvru.com" || this.definition.domain === "ru.otzyv.com") {
      return this.discoverDirectBrandPage(brand, context);
    }
    if (this.definition.domain === "pravogolosa.net") return this.discoverPravogolosa(brand, context);
    const start = canonicalizeUrl(this.definition.searchUrl(brand, context));
    const queue = [start];
    const queued = new Set(queue);
    const visited = new Set<string>();
    const products = new Map<string, ProductRef>();
    let provedNoResults = false;

    while (queue.length && visited.size < MAX_SEARCH_PAGES) {
      const pageUrl = queue.shift()!;
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      const { html, status } = await this.request(pageUrl, context);
      if (status < 200 || status >= 300) {
        throw new AdapterBlockedError(`Поиск ${this.definition.domain} недоступен: HTTP ${status}`);
      }
      if (isBlockPage(html)) {
        throw new AdapterBlockedError(`Поиск ${this.definition.domain} вернул защитную страницу`);
      }
      const $ = load(html);
      if (pageUrl === start) provedNoResults = hasExplicitSearchNoResults($, brand, this.definition.domain);
      $("a[href]").each((_index, node) => {
        const href = $(node).attr("href");
        if (!href) return;
        try {
          const url = new URL(href, pageUrl);
          if (!sameSite(url, this.definition.domain) || !this.definition.isProductUrl(url)) return;
          url.protocol = "https:";
          const card = $(node).closest("article, li, [class*='item'], [class*='result'], [class*='product']");
          const cardTitle = card.find("h1, h2, h3, h4, [class*='title'], [itemprop='name']").first().text();
          // Match the product title, not a review snippet that merely mentions
          // the requested brand while linking to a different product.
          const haystack = `${$(node).text()} ${cardTitle}`.replace(/\s+/g, " ");
          if (!matchesBrand(haystack, brand)) return;
          const canonical = canonicalizeUrl(url.toString());
          const listingId = this.definition.idFromUrl(url) ?? hashId(canonical);
          products.set(canonical, {
            domain: this.definition.domain,
            platform: this.definition.domain,
            listingId,
            brand,
            url: canonical,
            title: $(node).text().replace(/\s+/g, " ").trim() || undefined,
            metadata: { source: "site-search" }
          });
          if (products.size > MAX_PRODUCTS) {
            throw new AdapterBlockedError(`${this.definition.domain} вернул более ${MAX_PRODUCTS} карточек для одного бренда`);
          }
        } catch (error) {
          if (error instanceof AdapterBlockedError) throw error;
        }
      });
      for (const next of paginationCandidates($, pageUrl, this.definition)) {
        if (visited.has(next) || queued.has(next)) continue;
        queued.add(next);
        queue.push(next);
      }
    }
    if (queue.length) {
      throw new AdapterBlockedError(`Поиск ${this.definition.domain} достиг лимита ${MAX_SEARCH_PAGES} страниц без доказанного окончания`);
    }

    for (const previous of context.previousRefs ?? []) {
      try {
        const url = new URL(previous.url);
        if (!sameSite(url, this.definition.domain) || !this.definition.isProductUrl(url)) continue;
        const canonical = canonicalizeUrl(url.toString());
        if (!products.has(canonical)) products.set(canonical, {
          domain: this.definition.domain,
          platform: this.definition.domain,
          listingId: previous.listingId,
          brand,
          url: canonical,
          metadata: { source: "historical-registry" }
        });
      } catch { /* malformed historical URL */ }
    }
    if (!products.size && !provedNoResults) {
      throw new AdapterBlockedError(`${this.definition.domain}: поиск не подтвердил ни карточки бренда, ни их отсутствие`);
    }
    return [...products.values()];
  }

  private async discoverOtzovik(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const searchUrl = canonicalizeUrl(this.definition.searchUrl(brand, context));
    const { html, status } = await this.request(searchUrl, context);
    if (status < 200 || status >= 300 || isBlockPage(html)) {
      throw new AdapterBlockedError(`Внешний поиск карточек otzovik.com недоступен: HTTP ${status}`);
    }
    const $ = load(html);
    const refs = new Map<string, ProductRef>();
    $("a.result__a[href]").each((_index, node) => {
      const text = $(node).text().replace(/\s+/g, " ").trim();
      if (!matchesBrand(text, brand)) return;
      const href = $(node).attr("href");
      if (!href) return;
      try {
        let target = new URL(href, "https://html.duckduckgo.com/");
        const redirected = target.searchParams.get("uddg");
        if (redirected) target = new URL(redirected);
        if (!sameSite(target, "otzovik.com")) return;
        const slug = target.pathname.match(/^\/reviews\/([a-z0-9_-]+)(?:\/|$)/i)?.[1];
        if (!slug) return;
        const canonical = `https://otzovik.com/reviews/${slug}/`;
        const reviewCount = integerFrom($(node).attr("data-review-count"));
        const rating = numberFrom($(node).attr("data-rating"));
        const exactAggregate = reviewCount !== undefined &&
          (reviewCount === 0 || rating !== undefined && rating > 0 && rating <= 5);
        refs.set(canonical, {
          domain: this.definition.domain,
          platform: this.definition.domain,
          listingId: this.definition.idFromUrl(new URL(canonical)) ?? hashId(canonical),
          brand,
          url: canonical,
          title: text,
          metadata: {
            source: exactAggregate ? "otzovik-search" : "external-search",
            ...(exactAggregate ? { reviewCount, ...(reviewCount > 0 ? { rating } : {}) } : {})
          }
        });
      } catch { /* malformed external result */ }
    });
    this.appendHistorical(refs, brand, context);
    if (!refs.size) {
      const text = $.root().text().replace(/\s+/g, " ");
      if (/\bNo results found for\b/i.test(text)) return [];
      throw new AdapterBlockedError("Внешний поиск Otzovik не нашёл проверяемых карточек; отсутствие результатов нельзя доказать");
    }
    return [...refs.values()];
  }

  private async discoverDirectBrandPage(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map<string, ProductRef>();
    let provedMissing = 0;
    let provedNoResults = false;
    const slugs = this.definition.domain === "ru.otzyv.com" ? ruOtzyvBrandSlugs(brand) : brandSlugs(brand);
    for (const slug of slugs) {
      const url = canonicalizeUrl(new URL(slug, this.definition.origin).toString());
      const { html, status } = await this.request(url, context);
      if (status === 404 || status === 410) {
        provedMissing += 1;
        continue;
      }
      if (status < 200 || status >= 300 || isBlockPage(html)) {
        throw new AdapterBlockedError(`${this.definition.domain} не отдал прямую карточку бренда: HTTP ${status}`);
      }
      const parsed = this.definition.parse(html, url, brand);
      const title = parsed.title?.replace(/\s+/g, " ").trim() ?? "";
      if (!matchesBrand(title, brand)) {
        throw new ParserChangedError(`${this.definition.domain}: прямая карточка не подтверждает бренд ${brand}`);
      }
      refs.set(url, this.refFor(url, brand, title));
    }
    if (!refs.size && provedMissing === slugs.length) {
      const searchUrl = canonicalizeUrl(this.definition.searchUrl(brand, context));
      const { html, status } = await this.request(searchUrl, context);
      if (status < 200 || status >= 300 || isBlockPage(html)) {
        throw new AdapterBlockedError(`${this.definition.domain} не отдал поиск карточки бренда: HTTP ${status}`);
      }
      const $ = load(html);
      $("a[href]").each((_index, node) => {
        const title = $(node).text().normalize("NFKC").replace(/\s+/g, " ").trim();
        if (!title || !matchesBrand(title, brand)) return;
        const productUrl = absoluteProductUrl($(node).attr("href"), searchUrl, this.definition);
        if (!productUrl) return;
        refs.set(productUrl, this.refFor(productUrl, brand, title));
      });
      provedNoResults = hasExplicitSearchNoResults($, brand, this.definition.domain);
      if (!refs.size && !provedNoResults) {
        throw new AdapterBlockedError(`${this.definition.domain}: поиск не доказал ни карточку бренда, ни отсутствие результатов`);
      }
    }
    this.appendHistorical(refs, brand, context);
    if (!refs.size && provedNoResults) return [];
    if (!refs.size) throw new AdapterBlockedError(`${this.definition.domain}: отсутствие карточки бренда не доказано`);
    return [...refs.values()];
  }

  private async discoverPravogolosa(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const searchUrl = canonicalizeUrl(this.definition.searchUrl(brand, context));
    const normalizeQuery = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
    const queue = [searchUrl];
    const queued = new Set(queue);
    const visited = new Set<string>();
    const individualIds = new Set<string>();
    const candidates = new Map<string, { listingId: string; reviewCount: number }>();
    let advertisedCount: number | undefined;

    while (queue.length && visited.size < MAX_SEARCH_PAGES) {
      const pageUrl = queue.shift()!;
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      const { html, status } = await this.request(pageUrl, context);
      if (status < 200 || status >= 300 || isBlockPage(html)) {
        throw new AdapterBlockedError(`Поиск pravogolosa.net недоступен: HTTP ${status}`);
      }
      const $ = load(html);
      const text = $.root().text().replace(/\s+/g, " ");
      const result = text.match(/По вашему запросу\s*[«"]?\s*([^»"]+?)\s*[»"]?\s*всего найдено отзывов\s*:\s*([\d\s\u00a0]+)/iu);
      const resultBrand = result?.[1];
      const count = integerFrom(result?.[2]);
      const empty = text.match(/По запросу\s*[«"]?\s*([^»"]+?)\s*[»"]?\s*ничего не нашлось/iu);
      if (empty && normalizeQuery(empty[1]) === normalizeQuery(brand) && visited.size === 1) return [];
      if (count === undefined || !resultBrand || normalizeQuery(resultBrand) !== normalizeQuery(brand)) {
        throw new ParserChangedError("pravogolosa.net не связал результаты с точным поисковым запросом");
      }
      if (count === 0 && visited.size === 1) return [];
      if (advertisedCount === undefined) advertisedCount = count;
      if (count !== advertisedCount) {
        throw new ParserChangedError("pravogolosa.net изменил число результатов между страницами поиска");
      }

      let conflictingCategoryCount = false;
      $("a[href]").each((_index, node) => {
        const href = $(node).attr("href");
        if (!href) return;
        try {
          const target = new URL(href, searchUrl);
          if (!sameSite(target, "pravogolosa.net") || target.pathname !== "/otzyvcategory") return;
          if (target.searchParams.get("page") === "show_ad" && /^\d+$/.test(target.searchParams.get("adid") ?? "")) {
            individualIds.add(target.searchParams.get("adid")!);
          }
          if (this.definition.isProductUrl(target)) {
            const categoryReviews = integerFrom($(node).text().match(/(?:все|читать\s+все)\s+отзывы\s*\(?([\d\s\u00a0]+)\)?/iu)?.[1]);
            // Search totals count every matching review body and may mix the
            // requested medicine with analogues. The linked category has its
            // own aggregate, verified below against the category H1 and count.
            if (categoryReviews === undefined || categoryReviews <= 0) return;
            target.protocol = "https:";
            target.search = "";
            target.searchParams.set("page", "show_category");
            target.searchParams.set("catid", new URL(href, pageUrl).searchParams.get("catid")!);
            target.searchParams.set("order", "0");
            target.searchParams.set("expand", "0");
            const canonical = canonicalizeUrl(target.toString());
            const listingId = this.definition.idFromUrl(new URL(canonical));
            const previous = candidates.get(canonical);
            if (previous && previous.reviewCount !== categoryReviews) {
              conflictingCategoryCount = true;
              return;
            }
            if (listingId) candidates.set(canonical, { listingId, reviewCount: categoryReviews });
          }
          if (target.searchParams.get("page") === "search" && /^\d+$/.test(target.searchParams.get("start") ?? "")) {
            const query = target.searchParams.get("text_search");
            if (query && normalizeQuery(query) !== normalizeQuery(brand)) return;
            target.protocol = "https:";
            const next = canonicalizeUrl(target.toString());
            if (!visited.has(next) && !queued.has(next)) {
              queued.add(next);
              queue.push(next);
            }
          }
        } catch { /* malformed category link */ }
      });
      if (conflictingCategoryCount) {
        throw new ParserChangedError("pravogolosa.net показал противоречивые итоги категории");
      }
    }

    if (queue.length) {
      throw new AdapterBlockedError(`Поиск pravogolosa.net достиг лимита ${MAX_SEARCH_PAGES} страниц без доказанного окончания`);
    }
    if (advertisedCount === undefined || individualIds.size !== advertisedCount) {
      throw new ParserChangedError("pravogolosa.net не отдал полный набор заявленных результатов поиска");
    }

    if (advertisedCount > 0) {
      const refs = new Map<string, ProductRef>();
      let provedNonMatchingCategories = 0;
      for (const [canonical, candidate] of candidates) {
        const category = await this.request(canonical, context);
        if (category.status < 200 || category.status >= 300 || isBlockPage(category.html)) {
          throw new AdapterBlockedError(`Категория pravogolosa.net недоступна: HTTP ${category.status}`);
        }
        const parsed = this.definition.parse(category.html, canonical, brand);
        const categoryTitle = parsed.title?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
        if (!categoryTitle || parsed.reviews === undefined || parsed.reviews !== candidate.reviewCount) {
          throw new ParserChangedError("pravogolosa.net не подтвердил заголовок и агрегат категории");
        }
        // Search snippets may mention the requested medicine under a
        // manufacturer-wide category. Bind identity to the category page H1;
        // review bodies and snippets never prove product identity.
        if (!matchesBrand(categoryTitle, brand)) {
          provedNonMatchingCategories += 1;
          continue;
        }
        refs.set(canonical, {
          domain: this.definition.domain,
          platform: this.definition.domain,
          listingId: candidate.listingId,
          brand,
          url: canonical,
          title: categoryTitle,
          metadata: { source: "pravogolosa-search-category", reviewCount: candidate.reviewCount }
        });
      }
      this.appendHistorical(refs, brand, context);
      if (refs.size) return [...refs.values()];
      if (candidates.size > 0 && provedNonMatchingCategories === candidates.size) return [];
      throw new ParserChangedError("pravogolosa.net показывает отдельные отзывы, но не доказан агрегат бренда");
    }
    throw new AdapterBlockedError("pravogolosa.net не подтвердил ни результаты, ни их отсутствие");
  }

  private async discoverIrecommend(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const searchUrl = canonicalizeUrl(this.definition.searchUrl(brand, context));
    const { html, status } = await this.request(searchUrl, context);
    if (status < 200 || status >= 300 || isBlockPage(html)) {
      throw new AdapterBlockedError(`Поиск irecommend.ru недоступен: HTTP ${status}`);
    }
    const $ = load(html);
    const refs = new Map<string, ProductRef>();
    const candidates: ProductRef[] = [];
    const historicalIdByUrl = new Map<string, string>();
    for (const previous of context.previousRefs ?? []) {
      try {
        const canonical = canonicalizeUrl(previous.url);
        const target = new URL(canonical);
        if (sameSite(target, "irecommend.ru") && this.definition.isProductUrl(target)) {
          historicalIdByUrl.set(canonical, previous.listingId);
        }
      } catch { /* malformed historical URL */ }
    }
    $("ul.srch-result-nodes > li .ProductTizer[data-type='2'][data-nid]").each((_index, node) => {
      const card = $(node);
      const nid = card.attr("data-nid")?.trim();
      const anchor = card.find(".title a[href]").first();
      const href = anchor.attr("href");
      const title = anchor.text().replace(/\s+/g, " ").trim();
      if (!nid || !/^\d+$/.test(nid) || !href || !matchesBrand(title, brand)) return;
      try {
        const target = new URL(href, searchUrl);
        if (!sameSite(target, "irecommend.ru") || !this.definition.isProductUrl(target)) return;
        target.protocol = "https:";
        const canonical = canonicalizeUrl(target.toString());
        const cardText = card.text().replace(/\s+/g, " ");
        const reviewCount = integerFrom(
          card.find(".read-all-reviews-link .counter").first().text() || (
            cardText.match(/([\d\s\u00a0]+)\s+отзыв/iu)?.[1] ??
            cardText.match(/читать\s+все\s+отзывы\s*([\d\s\u00a0]+)/iu)?.[1]
          )
        );
        const rating = numberFrom(
          card.find(".fivestar-summary .average-rating span, .average-rating span").first().text().trim() ||
          cardText.match(/Среднее\s*:\s*(\d+(?:[.,]\d+)?)/iu)?.[1]
        );
        candidates.push({
          domain: this.definition.domain,
          platform: this.definition.domain,
          // Cached reader Markdown exposes a product-image id instead of the
          // DOM node id. Preserve the registered id for the same canonical
          // product across direct/reader route changes.
          listingId: historicalIdByUrl.get(canonical) ?? nid,
          brand,
          url: canonical,
          title,
          metadata: {
            source: "irecommend-search",
            ...(reviewCount === undefined ? {} : { reviewCount }),
            ...(rating === undefined ? {} : { rating })
          }
        });
      } catch { /* malformed result link */ }
    });
    const pharmaceutical = candidates.filter((item) => PHARMACEUTICAL_REVIEW_TITLE.test(item.title ?? ""));
    for (const item of candidates.length > 1 && pharmaceutical.length ? pharmaceutical : candidates) {
      refs.set(item.url, item);
    }
    this.appendHistorical(refs, brand, context);
    if (!refs.size && !hasExplicitSearchNoResults($, brand, this.definition.domain)) {
      throw new AdapterBlockedError("irecommend.ru не подтвердил ни карточки бренда, ни их отсутствие");
    }
    return [...refs.values()];
  }

  private async discoverUteka(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    if (this.utekaSitemap === undefined) {
      const response = await this.request("https://uteka.ru/sitemaps/sitemap-reviews.xml", context);
      if (response.status < 200 || response.status >= 300) {
        throw new AdapterBlockedError(`Sitemap uteka.ru недоступен: HTTP ${response.status}`);
      }
      this.utekaSitemap = response.html;
    }
    const slugs = brandSlugs(brand);
    const refs = new Map<string, ProductRef>();
    for (const match of this.utekaSitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      try {
        const url = new URL(match[1].replace(/&amp;/g, "&"));
        if (!sameSite(url, "uteka.ru") || !/\/reviews\/$/i.test(url.pathname)) continue;
        const path = decodeURIComponent(url.pathname).toLocaleLowerCase("ru-RU");
        if (!slugs.some((slug) => path.split("/").some((part) => part === slug || part.startsWith(`${slug}-`)))) continue;
        const canonical = canonicalizeUrl(url.toString());
        refs.set(canonical, this.refFor(canonical, brand));
      } catch { /* malformed sitemap location */ }
    }
    this.appendHistorical(refs, brand, context);
    return [...refs.values()];
  }

  private async discoverMegapteka(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    if (!this.megaptekaCity) {
      const home = await this.request(this.definition.origin, context);
      if (home.status < 200 || home.status >= 300 || isBlockPage(home.html)) {
        throw new AdapterBlockedError(`Главная megapteka.ru недоступна: HTTP ${home.status}`);
      }
      this.megaptekaCity = megaptekaCity(home.html);
      if (!this.megaptekaCity) throw new ParserChangedError("megapteka.ru не отдал city id/code для catalog API");
    }
    const refs = new Map<string, ProductRef>();
    let explicitEmpty = false;
    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const data = JSON.stringify({
        query: brand,
        count: MEGAPTEKA_SEARCH_PAGE_SIZE,
        page,
        city_id: this.megaptekaCity.id,
        sorting: [{ by: "popularity", direction: "desc", sort: 0 }]
      });
      const searchUrl = `https://api.megapteka.ru/ma/site/v4/search/items?data=${encodeURIComponent(data)}`;
      const response = await this.requestJson(searchUrl, context);
      if (response.status < 200 || response.status >= 300) {
        throw new AdapterBlockedError(`Catalog API megapteka.ru недоступен: HTTP ${response.status}`);
      }
      const payload = response.payload as MegaptekaSearchPayload;
      if (!Array.isArray(payload.items)) throw new ParserChangedError("megapteka.ru search API не содержит items");
      explicitEmpty = page === 1 && payload.items.length === 0 && Boolean(payload.search?.empty_info);
      for (const item of payload.items) {
        if (!item.code || !item.group_code || !item.name || !Number.isSafeInteger(item.id) || !matchesBrand(item.name, brand)) continue;
        const url = canonicalizeUrl(
          `https://megapteka.ru/${this.megaptekaCity.code}/catalog/${item.group_code}/${item.code}`
        );
        refs.set(url, {
          domain: this.definition.domain,
          platform: this.definition.domain,
          listingId: String(item.id),
          brand,
          url,
          title: item.name,
          metadata: { source: "megapteka-search-json" }
        });
        if (refs.size > MAX_PRODUCTS) {
          throw new AdapterBlockedError(`megapteka.ru вернул более ${MAX_PRODUCTS} карточек для одного бренда`);
        }
      }
      if (payload.items.length < MEGAPTEKA_SEARCH_PAGE_SIZE) break;
      if (page === MAX_SEARCH_PAGES) {
        throw new AdapterBlockedError(`Catalog API megapteka.ru достиг лимита ${MAX_SEARCH_PAGES} страниц`);
      }
    }
    this.appendHistorical(refs, brand, context);
    if (!refs.size && !explicitEmpty) {
      throw new AdapterBlockedError("Catalog API megapteka.ru не доказал ни карточки, ни их отсутствие");
    }
    return [...refs.values()];
  }

  private refFor(url: string, brand: string, title?: string): ProductRef {
    const canonical = this.definition.domain === "otzovik.com"
      ? canonicalOtzovikProductUrl(url)
      : canonicalizeUrl(url);
    if (!canonical) throw new ParserChangedError(`Небезопасная ссылка карточки ${this.definition.domain}`);
    const parsed = new URL(canonical);
    return {
      domain: this.definition.domain,
      platform: this.definition.domain,
      listingId: this.definition.idFromUrl(parsed) ?? hashId(canonical),
      brand,
      url: canonical,
      title,
      metadata: { source: "site-search" }
    };
  }

  private appendHistorical(refs: Map<string, ProductRef>, brand: string, context: AdapterContext): void {
    for (const previous of context.previousRefs ?? []) {
      try {
        const url = new URL(previous.url);
        if (!sameSite(url, this.definition.domain) || !this.definition.isProductUrl(url)) continue;
        url.protocol = "https:";
        const canonical = this.definition.domain === "otzovik.com"
          ? canonicalOtzovikProductUrl(url)
          : canonicalizeUrl(url.toString());
        if (!canonical) continue;
        if (!refs.has(canonical)) refs.set(canonical, {
          domain: this.definition.domain,
          platform: this.definition.domain,
          listingId: previous.listingId,
          brand,
          url: canonical,
          metadata: { source: "historical-registry" }
        });
      } catch { /* malformed historical URL */ }
    }
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const capturedAt = new Date().toISOString();
    // These source-bound search cards are themselves aggregate product
    // records. Once identity, count and rating are proved together, a second
    // request adds no data and is less reliable behind the site's protection.
    const exactSearchAggregate = (
      this.definition.domain === "irecommend.ru" && ref.metadata.source === "irecommend-search" &&
        /^\d+$/.test(ref.listingId) ||
      this.definition.domain === "otzovik.com" && ref.metadata.source === "otzovik-search" &&
        canonicalOtzovikProductUrl(ref.url) !== undefined
    );
    if (
      exactSearchAggregate &&
      Boolean(ref.title) &&
      matchesBrand(ref.title!, ref.brand) &&
      typeof ref.metadata.reviewCount === "number" &&
      Number.isInteger(ref.metadata.reviewCount) &&
      ref.metadata.reviewCount >= 0 &&
      (ref.metadata.reviewCount === 0 ||
        typeof ref.metadata.rating === "number" && Number.isFinite(ref.metadata.rating) &&
        ref.metadata.rating > 0 && ref.metadata.rating <= 5)
    ) {
      const canonicalUrl = canonicalizeUrl(ref.url);
      const reviews = ref.metadata.reviewCount;
      const rating: number | null = reviews === 0 ? null : ref.metadata.rating as number;
      const productEvidence = dedicatedFamilyEvidence({
        ...titleProductEvidence(ref.title!, { type: "product_id" as const, value: ref.listingId }, canonicalUrl),
        scope: "product_family" as const
      }, this.definition, ref.listingId, ref.title!, ref.brand);
      const proof = JSON.stringify({
        listingId: ref.listingId, canonicalUrl, title: ref.title, reviews, rating,
        source: ref.metadata.source
      });
      const evidenceRef = await this.evidence.put({
        capturedAt,
        url: canonicalUrl,
        status: 200,
        bodyDigest: createHash("sha256").update(proof).digest("hex"),
        parsed: { listingId: ref.listingId, title: ref.title, reviews, rating, source: ref.metadata.source },
        productEvidence
      });
      return {
        domain: this.definition.domain,
        platform: this.definition.domain,
        listingId: ref.listingId,
        brand: ref.brand,
        canonicalUrl,
        product: ref.title!,
        reviews,
        rating,
        rawRating: rating,
        rawRatingScale: 5,
        ratingCount: this.definition.domain === "otzovik.com" ? reviews : null,
        status: reviews === 0 ? "no_reviews" : "ok",
        capturedAt,
        evidenceRef,
        productEvidence,
        source: String(ref.metadata.source)
      };
    }
    const { html, status, redirectLocation } = await this.request(
      ref.url,
      context,
      this.definition.domain === "vseotzyvy.ru"
    );
    if (
      this.definition.domain === "vseotzyvy.ru" &&
      [301, 302, 303, 307, 308].includes(status) &&
      isRetiredVseotzyvyRedirect(ref.url, redirectLocation)
    ) {
      return {
        domain: this.definition.domain,
        platform: this.definition.domain,
        listingId: ref.listingId,
        brand: ref.brand,
        canonicalUrl: canonicalizeUrl(ref.url),
        product: ref.title ?? ref.brand,
        reviews: null,
        rating: null,
        status: "not_found",
        capturedAt,
        source: "review_site_missing_candidate"
      };
    }
    if (status === 404 || status === 410) {
      return {
        domain: this.definition.domain,
        platform: this.definition.domain,
        listingId: ref.listingId,
        brand: ref.brand,
        canonicalUrl: canonicalizeUrl(ref.url),
        product: ref.title ?? ref.brand,
        reviews: null,
        rating: null,
        status: "not_found",
        capturedAt,
        // Otzovik's first-party search can retain explicitly retired product
        // cards. Mark that exact 404/410 proof so orchestration can omit a new
        // stale result without weakening other missing-page handling.
        source: this.definition.domain === "otzovik.com"
          ? "otzovik_missing_candidate"
          : "review-site-missing"
      };
    }
    if (status < 200 || status >= 300) {
      throw new AdapterBlockedError(`${this.definition.domain} не отдал карточку ${ref.listingId}: HTTP ${status}`);
    }
    if (isBlockPage(html)) {
      throw new AdapterBlockedError(`${this.definition.domain} вернул защитную страницу для карточки ${ref.listingId}`);
    }
    if (isExplicitNonProductReviewPage(html, this.definition)) {
      return {
        domain: this.definition.domain,
        platform: this.definition.domain,
        listingId: ref.listingId,
        brand: ref.brand,
        canonicalUrl: canonicalizeUrl(ref.url),
        product: ref.title ?? ref.brand,
        reviews: null,
        rating: null,
        status: "not_found",
        capturedAt,
        source: "review_site_non_product_candidate"
      };
    }
    const parsed = this.definition.parse(html, ref.url, ref.brand);
    const canonicalUrl = absoluteProductUrl(parsed.canonicalUrl, ref.url, this.definition) ?? canonicalizeUrl(ref.url);
    // Discovery owns the stable listing identity. Page-local numeric ids may
    // describe a review or another nested entity and must never replace it.
    const listingId = ref.listingId;
    const title = parsed.title?.replace(/\s+/g, " ").trim() || ref.title || ref.brand;
    const discoveredReviewCount = ref.metadata.reviewCount;
    const discoveredRating = ref.metadata.rating;
    const reviews = parsed.reviews ?? (
      this.definition.domain === "irecommend.ru" &&
      typeof discoveredReviewCount === "number" &&
      Number.isInteger(discoveredReviewCount) &&
      discoveredReviewCount >= 0
        ? discoveredReviewCount
        : undefined
    );
    const rating = parsed.rating ?? (
      this.definition.domain === "irecommend.ru" &&
      typeof discoveredRating === "number" &&
      Number.isFinite(discoveredRating) &&
      discoveredRating > 0 &&
      discoveredRating <= 5
        ? discoveredRating
        : undefined
    );
    const ratingCount = parsed.ratingCount;
    const feedbackCount = Math.max(...[reviews, ratingCount].filter((value): value is number => value !== undefined));
    if (!Number.isFinite(feedbackCount)) {
      throw new ParserChangedError(`${this.definition.domain}: не найден подтверждённый счётчик отзывов, оценок или голосов`);
    }
    if (feedbackCount > 0 && rating === undefined) throw new ParserChangedError(`${this.definition.domain}: есть обратная связь, но не найден рейтинг`);
    // Dedicated Megapteka pages are sellable SKUs; the other definitions are
    // aggregate review pages for a product/family.
    const rawProductEvidence = this.definition.domain === "megapteka.ru"
      // Megapteka catalog pages contain same-brand recommendations for adjacent
      // packs. Discovery already gave us a stable first-party SKU and the page
      // parser resolved the canonical Product title, so only those listing-local
      // facts may participate in product identity.
      ? titleProductEvidence(title, { type: "product_id", value: listingId }, canonicalUrl)
      : extractPageProductEvidence(html, canonicalUrl, ref.brand, { forceFamily: true });
    const productEvidence = dedicatedFamilyEvidence(
      rawProductEvidence,
      this.definition,
      listingId,
      title,
      ref.brand
    );
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: ref.url,
      status,
      bodyDigest: createHash("sha256").update(html).digest("hex"),
      parsed: { ...parsed, title, canonicalUrl, listingId },
      productEvidence
    });
    const brandMatches = matchesBrand(title, ref.brand);
    return {
      domain: this.definition.domain,
      platform: this.definition.domain,
      listingId,
      brand: ref.brand,
      canonicalUrl,
      product: title,
      reviews: reviews ?? null,
      rating: feedbackCount === 0 ? null : rating ?? null,
      rawRating: parsed.rawRating ?? rating,
      rawRatingScale: parsed.rawRatingScale ?? 5,
      ratingCount: ratingCount ?? null,
      status: !brandMatches ? "needs_review" : feedbackCount === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence,
      source: parsed.source
    };
  }
}

export class BlockedFreeModeAdapter implements SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];

  constructor(private readonly domain: typeof BLOCKED_FREE_MODE_DOMAINS[number]) {
    this.id = `blocked-free-mode:${domain}`;
    this.supportedDomains = [domain, `www.${domain}`];
  }

  async healthCheck(_context: AdapterContext): Promise<AdapterHealth> {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      message: `blocked_free_mode: ${this.domain} блокирует бесплатный автоматизированный доступ; платный резерв не используется`
    };
  }

  async discover(): Promise<ProductRef[]> {
    throw new AdapterBlockedError(`blocked_free_mode: ${this.domain}; платный резерв не используется`);
  }

  async collect(): Promise<Observation> {
    throw new AdapterBlockedError(`blocked_free_mode: ${this.domain}; платный резерв не используется`);
  }
}

export class UnprovenAggregateAdapter implements SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];

  constructor(private readonly domain: typeof UNPROVEN_AGGREGATE_DOMAINS[number]) {
    this.id = `unproven-aggregate:${domain}`;
    this.supportedDomains = [domain, `www.${domain}`];
  }

  private message(): string {
    return `blocked: unsupported_aggregate: ${this.domain} не показывает рейтинг и отзывы на карточке товара; скрытые API-агрегаты не публикуются; no_results не выводится`;
  }

  async healthCheck(_context: AdapterContext): Promise<AdapterHealth> {
    return { ok: false, checkedAt: new Date().toISOString(), message: this.message() };
  }

  async discover(): Promise<ProductRef[]> {
    throw new ParserChangedError(this.message());
  }

  async collect(): Promise<Observation> {
    throw new ParserChangedError(this.message());
  }
}

export function createReviewSiteAdapters(evidence: EvidenceStore, fetchImpl?: typeof fetch): SiteAdapter[] {
  return [
    ...REVIEW_SITE_DEFINITIONS.map((definition) => new ReviewSiteAdapter(definition, evidence, fetchImpl)),
    ...BLOCKED_FREE_MODE_DOMAINS.map((domain) => new BlockedFreeModeAdapter(domain)),
    ...UNPROVEN_AGGREGATE_DOMAINS.map((domain) => new UnprovenAggregateAdapter(domain))
  ];
}
