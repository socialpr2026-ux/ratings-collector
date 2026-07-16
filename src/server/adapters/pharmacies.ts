import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { aliasesForBrand, matchesBrand, normalizeText } from "../utils/normalize.js";
import { titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const MAX_HTML_BYTES = 12_000_000;
const MAX_REVIEW_PAGES = 20;
const BLOCK_MARKERS = /captcha|access denied|unusual traffic|enable javascript|подозрительн\w*\s+активност|доступ\s+(?:ограничен|запрещен)|проверка\s+браузера/i;
const TRANSLATE_PARAMETERS = { _x_tr_sl: "ru", _x_tr_tl: "en", _x_tr_hl: "en" } as const;

type HtmlResult = { html: string; status: number; requestedUrl: string };

function compactText(value: string): string {
  return value.replace(/№/g, "\uE000").normalize("NFKC").replace(/\uE000/g, "№")
    .replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\s\u00a0\u202f]/g, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function rating(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

function translatedUrl(host: string, source: URL): string {
  const translated = new URL(`https://${host}${source.pathname}`);
  for (const [key, value] of source.searchParams) translated.searchParams.set(key, value);
  for (const [key, value] of Object.entries(TRANSLATE_PARAMETERS)) translated.searchParams.set(key, value);
  return translated.toString();
}

function sourceUrlFromTranslatedHref(value: string | undefined, sourceHost: string, translateHost: string): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, `https://${translateHost}/`);
    if (url.protocol !== "https:") return undefined;
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (host !== sourceHost && url.hostname !== translateHost) return undefined;
    const source = new URL(`https://${sourceHost}${url.pathname}`);
    for (const [key, item] of url.searchParams) {
      if (!(key in TRANSLATE_PARAMETERS)) source.searchParams.append(key, item);
    }
    return source;
  } catch {
    return undefined;
  }
}

function isBlocked(html: string): boolean {
  const $ = load(html);
  const title = compactText($("title").first().text());
  return BLOCK_MARKERS.test(title) || /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 150_000));
}

async function requestHtml(
  url: string,
  context: AdapterContext,
  fallbackFetch: typeof fetch
): Promise<HtmlResult> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      signal: context.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.7"
      }
    }, context.fetch ?? fallbackFetch, 4, 60_000);
  } catch (error) {
    throw new AdapterBlockedError(`HTTP-запрос не выполнен: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, MAX_HTML_BYTES, 60_000).catch((error) => {
    throw new AdapterBlockedError(`Ответ площадки не прочитан: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { html, status: response.status, requestedUrl: url };
}

function assertUsable(domain: string, result: HtmlResult): void {
  if (result.status < 200 || result.status >= 300 || isBlocked(result.html)) {
    throw new AdapterBlockedError(`${domain}: страница недоступна в бесплатном режиме (HTTP ${result.status})`);
  }
}

function sourceBase($: CheerioAPI, expectedHost: string): URL {
  const value = $("base[href]").first().attr("href");
  if (!value) throw new ParserChangedError(`${expectedHost}: translated page has no source base`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.replace(/^www\./, "") !== expectedHost) {
    throw new ParserChangedError(`${expectedHost}: translated page points to another source`);
  }
  return url;
}

function productRef(domain: string, listingId: string, brand: string, url: string, title?: string, source?: string): ProductRef {
  return {
    domain,
    platform: domain,
    listingId,
    brand,
    url: canonicalizeUrl(url),
    title: title ? compactText(title) : undefined,
    metadata: source ? { source } : {}
  };
}

function appendPrevious(
  refs: Map<string, ProductRef>,
  domain: string,
  brand: string,
  context: AdapterContext,
  parse: (value: string) => { id: string; url: string } | undefined
): void {
  for (const previous of context.previousRefs ?? []) {
    const parsed = parse(previous.url);
    if (!parsed || parsed.id !== previous.listingId) continue;
    if (!refs.has(parsed.id)) refs.set(parsed.id, productRef(domain, parsed.id, brand, parsed.url, undefined, "historical-registry"));
  }
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

function riglaBrandSlugs(brand: string): string[] {
  const aliases = aliasesForBrand(brand);
  const siteSpecific = aliases
    .filter((alias) => /ц/i.test(alias))
    .map((alias) => latinSlug(alias.toLocaleLowerCase("ru-RU").replaceAll("ц", "тс")))
    .filter(Boolean);
  return [...new Set([...siteSpecific, ...aliases.map(latinSlug).filter(Boolean)])];
}

async function evidenceObservation(
  evidence: EvidenceStore,
  input: {
    domain: string;
    listingId: string;
    brand: string;
    canonicalUrl: string;
    title: string;
    reviews: number;
    rating: number | null;
    ratingCount?: number | null;
    capturedAt: string;
    html: string;
    status: number;
    requestedUrl: string;
    source: string;
  }
): Promise<Observation> {
  const productEvidence = titleProductEvidence(
    input.title,
    { type: "product_id", value: input.listingId },
    input.canonicalUrl
  );
  const evidenceRef = await evidence.put({
    capturedAt: input.capturedAt,
    url: input.requestedUrl,
    status: input.status,
    bodyDigest: createHash("sha256").update(input.html).digest("hex"),
    parsed: {
      listingId: input.listingId,
      title: input.title,
      canonicalUrl: input.canonicalUrl,
      reviews: input.reviews,
      rating: input.rating,
      ratingCount: input.ratingCount ?? null
    },
    productEvidence,
    source: input.source
  });
  return {
    domain: input.domain,
    platform: input.domain,
    listingId: input.listingId,
    brand: input.brand,
    canonicalUrl: input.canonicalUrl,
    product: input.title,
    reviews: input.reviews,
    rating: input.reviews === 0 ? null : input.rating,
    rawRating: input.rating,
    rawRatingScale: 5,
    ratingCount: input.ratingCount,
    status: input.reviews === 0 ? "no_reviews" : "ok",
    capturedAt: input.capturedAt,
    evidenceRef,
    productEvidence,
    source: input.source
  };
}

abstract class PharmacyAdapter implements SiteAdapter {
  abstract readonly id: string;
  abstract readonly supportedDomains: readonly string[];
  abstract discover(brand: string, context: AdapterContext): Promise<ProductRef[]>;
  abstract collect(ref: ProductRef, context: AdapterContext): Promise<Observation>;

  constructor(protected readonly evidence: EvidenceStore, protected readonly fetchImpl: typeof fetch = fetch) {}

  protected async canary(brand: string, context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const refs = await this.discover(brand, { ...context, previousIds: [], previousRefs: [] });
      return refs.length
        ? { ok: true, checkedAt, message: `${this.id}: найдено контрольных карточек ${refs.length}` }
        : { ok: false, checkedAt, message: `${this.id}: контрольный бренд не найден` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  abstract healthCheck(context: AdapterContext): Promise<AdapterHealth>;
}

const OK_DOMAIN = "okapteka.ru";
const OK_TRANSLATE_HOST = "okapteka-ru.translate.goog";
const OK_PRODUCT = /^\/([a-z0-9][a-z0-9-]*-(\d+))\/?$/i;

function okProduct(value: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (url.protocol !== "https:" || host !== OK_DOMAIN && url.hostname !== OK_TRANSLATE_HOST) return undefined;
    const match = url.pathname.match(OK_PRODUCT);
    if (!match) return undefined;
    return { id: match[2], url: `https://${OK_DOMAIN}/${match[1]}/` };
  } catch {
    return undefined;
  }
}

type OkReviewAggregate = { reviews: number; sum: number; ratings: number };

function okaptekaExplicitEmptyReviews($: CheerioAPI, brand: string): boolean {
  const wrappers = $(".s-reviews-wrapper");
  if (wrappers.length !== 1) return false;
  const wrapper = wrappers.first();
  if (wrapper.find("[itemprop='review'], [data-review-id], .review-item").length) return false;
  if (wrapper.children().not("a[name], h1").length) return false;
  const link = wrapper.find("h1 a[href]").first();
  if (link.length !== 1 || compactText(wrapper.find("h1").first().text()) !== `Отзывы на ${brand}`) return false;
  try {
    const target = sourceUrlFromTranslatedHref(link.attr("href"), OK_DOMAIN, OK_TRANSLATE_HOST);
    const linkedBrand = target?.pathname.match(/^\/pg\/([^/]+)\/$/i)?.[1];
    return linkedBrand !== undefined && normalizeText(decodeURIComponent(linkedBrand)) === normalizeText(brand);
  } catch {
    return false;
  }
}

export class OkaptekaAdapter extends PharmacyAdapter {
  readonly id = "pharmacy:okapteka:v1";
  readonly supportedDomains = [OK_DOMAIN, `www.${OK_DOMAIN}`] as const;
  private reviewCache = new Map<string, Promise<{ html: string; status: number; requestedUrl: string; metrics: Map<string, OkReviewAggregate> }>>();

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    return this.canary("Кагоцел", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const source = new URL(`https://${OK_DOMAIN}/pg/${encodeURIComponent(brand)}/`);
    const result = await requestHtml(translatedUrl(OK_TRANSLATE_HOST, source), context, this.fetchImpl);
    assertUsable(OK_DOMAIN, result);
    const $ = load(result.html);
    const base = sourceBase($, OK_DOMAIN);
    if (!/^\/pg\//i.test(base.pathname)) throw new ParserChangedError(`${OK_DOMAIN}: unexpected group page`);
    const refs = new Map<string, ProductRef>();
    $("a[href]").each((_index, node) => {
      const parsed = okProduct($(node).attr("href") ?? "");
      if (!parsed) return;
      const card = $(node).closest("article, li, [class*='product'], [class*='item']");
      const title = compactText($(node).text() || card.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!matchesBrand(title, brand)) return;
      refs.set(parsed.id, productRef(OK_DOMAIN, parsed.id, brand, parsed.url, title, "okapteka-product-group"));
    });
    appendPrevious(refs, OK_DOMAIN, brand, context, okProduct);
    if (!refs.size) {
      const text = compactText($.root().text());
      if (/ничего не найдено|товары не найдены|no products found/i.test(text)) return [];
      throw new AdapterBlockedError(`${OK_DOMAIN}: страница бренда не доказала ни карточки, ни отсутствие результатов`);
    }
    return [...refs.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ru") || a.listingId.localeCompare(b.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsed = okProduct(ref.url);
    if (!parsed || parsed.id !== ref.listingId) throw new ParserChangedError(`${OK_DOMAIN}: некорректный ID карточки ${ref.listingId}`);
    const cacheKey = `${context.runId ?? "single"}\u0000${ref.brand}`;
    const snapshot = await (this.reviewCache.get(cacheKey) ?? this.loadReviews(ref.brand, context, cacheKey));
    const aggregate = snapshot.metrics.get(new URL(parsed.url).pathname) ?? { reviews: 0, sum: 0, ratings: 0 };
    if (aggregate.reviews > 0 && aggregate.ratings !== aggregate.reviews) {
      throw new ParserChangedError(`${OK_DOMAIN}:${ref.listingId}: не у каждого текстового отзыва найдена оценка`);
    }
    const normalizedRating = aggregate.reviews ? Math.round(aggregate.sum / aggregate.ratings * 100) / 100 : null;
    return evidenceObservation(this.evidence, {
      domain: OK_DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: parsed.url,
      title: compactText(ref.title ?? ref.brand),
      reviews: aggregate.reviews,
      rating: normalizedRating,
      ratingCount: aggregate.ratings,
      capturedAt: new Date().toISOString(),
      html: snapshot.html,
      status: snapshot.status,
      requestedUrl: snapshot.requestedUrl,
      source: "okapteka-brand-review-list"
    });
  }

  private loadReviews(brand: string, context: AdapterContext, key: string) {
    const task = this.readAllReviews(brand, context).catch((error) => {
      this.reviewCache.delete(key);
      throw error;
    });
    this.reviewCache.set(key, task);
    return task;
  }

  private async readAllReviews(brand: string, context: AdapterContext) {
    const source = new URL(`https://${OK_DOMAIN}/reviews/${encodeURIComponent(brand)}/`);
    const queue = [translatedUrl(OK_TRANSLATE_HOST, source)];
    const visited = new Set<string>();
    const metrics = new Map<string, OkReviewAggregate>();
    const seenReviews = new Set<string>();
    const bodies: string[] = [];
    let explicitNoReviews = false;
    let lastStatus = 200;
    while (queue.length && visited.size < MAX_REVIEW_PAGES) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const result = await requestHtml(url, context, this.fetchImpl);
      assertUsable(OK_DOMAIN, result);
      lastStatus = result.status;
      bodies.push(result.html);
      const $ = load(result.html);
      const base = sourceBase($, OK_DOMAIN);
      if (!/^\/reviews\//i.test(base.pathname)) throw new ParserChangedError(`${OK_DOMAIN}: unexpected reviews page`);
      const pageText = compactText($.root().text());
      explicitNoReviews ||= /отзывов пока нет|нет отзывов|no reviews yet|no reviews/i.test(pageText);
      explicitNoReviews ||= okaptekaExplicitEmptyReviews($, brand);
      $("[itemprop='review']").each((_index, node) => {
        const reviewId = $(node).attr("data-id")?.trim();
        const href = $(node).find("a[href]").first().attr("href");
        const product = okProduct(href ?? "");
        if (!reviewId || !product || seenReviews.has(reviewId)) return;
        const raw = rating($(node).find("[itemprop='ratingValue']").first().attr("content"));
        seenReviews.add(reviewId);
        const pathname = new URL(product.url).pathname;
        const aggregate = metrics.get(pathname) ?? { reviews: 0, sum: 0, ratings: 0 };
        aggregate.reviews += 1;
        if (raw !== undefined) { aggregate.sum += raw; aggregate.ratings += 1; }
        metrics.set(pathname, aggregate);
      });
      $(".pagination a[href], .pager a[href], a[rel='next'][href]").each((_index, node) => {
        const target = sourceUrlFromTranslatedHref($(node).attr("href"), OK_DOMAIN, OK_TRANSLATE_HOST);
        if (!target || target.pathname !== source.pathname) return;
        const next = translatedUrl(OK_TRANSLATE_HOST, target);
        if (!visited.has(next) && !queue.includes(next)) queue.push(next);
      });
    }
    if (queue.length) throw new AdapterBlockedError(`${OK_DOMAIN}: список отзывов превысил безопасный лимит ${MAX_REVIEW_PAGES} страниц`);
    if (!seenReviews.size && !explicitNoReviews) {
      throw new ParserChangedError(`${OK_DOMAIN}: список отзывов не доказал ни отзывы, ни их отсутствие`);
    }
    return { html: bodies.join("\n<!-- page -->\n"), status: lastStatus, requestedUrl: translatedUrl(OK_TRANSLATE_HOST, source), metrics };
  }
}

const RIGLA_DOMAIN = "rigla.ru";
const RIGLA_ORIGIN = "https://www.rigla.ru";
const RIGLA_PRODUCT = /^\/product\/[a-z0-9][a-z0-9-]*-(\d+)\/?$/i;

function riglaProduct(value: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value, RIGLA_ORIGIN);
    if (url.protocol !== "https:" || url.hostname.replace(/^www\./, "") !== RIGLA_DOMAIN) return undefined;
    const id = url.pathname.match(RIGLA_PRODUCT)?.[1];
    return id ? { id, url: `${RIGLA_ORIGIN}${url.pathname.replace(/\/$/, "")}` } : undefined;
  } catch { return undefined; }
}

function riglaState(html: string): Record<string, unknown> {
  const $ = load(html);
  const script = $("script").toArray().map((node) => $(node).html() ?? "")
    .find((value) => value.startsWith("window.__INITIAL_STATE__="));
  if (!script) throw new ParserChangedError(`${RIGLA_DOMAIN}: __INITIAL_STATE__ не найден`);
  const raw = script.slice("window.__INITIAL_STATE__=".length);
  const end = raw.indexOf(";(function");
  try { return JSON.parse(end >= 0 ? raw.slice(0, end) : raw.replace(/;\s*$/, "")) as Record<string, unknown>; }
  catch { throw new ParserChangedError(`${RIGLA_DOMAIN}: __INITIAL_STATE__ содержит невалидный JSON`); }
}

export class RiglaAdapter extends PharmacyAdapter {
  readonly id = "pharmacy:rigla:v1";
  readonly supportedDomains = [RIGLA_DOMAIN, `www.${RIGLA_DOMAIN}`] as const;

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    return this.canary(context.brands?.[0]?.trim() || "Кагоцел", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map<string, ProductRef>();
    let provedMissing = 0;
    const slugs = riglaBrandSlugs(brand);
    for (const slug of slugs) {
      const source = `${RIGLA_ORIGIN}/forms/${slug}`;
      const result = await requestHtml(source, context, this.fetchImpl);
      if (result.status === 404 || result.status === 410) { provedMissing += 1; continue; }
      assertUsable(RIGLA_DOMAIN, result);
      const $ = load(result.html);
      $("a[href*='/product/']").each((_index, node) => {
        const parsed = riglaProduct($(node).attr("href") ?? "");
        if (!parsed) return;
        const card = $(node).closest("article, li, [class*='product'], [class*='item']");
        const title = compactText($(node).text() || card.text());
        if (!matchesBrand(title, brand)) return;
        refs.set(parsed.id, productRef(RIGLA_DOMAIN, parsed.id, brand, parsed.url, title, "rigla-forms-page"));
      });
      if (refs.size) break;
    }
    appendPrevious(refs, RIGLA_DOMAIN, brand, context, riglaProduct);
    if (!refs.size && provedMissing === slugs.length) return [];
    if (!refs.size) throw new AdapterBlockedError(`${RIGLA_DOMAIN}: страницы форм не доказали результат поиска`);
    return [...refs.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ru") || a.listingId.localeCompare(b.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsed = riglaProduct(ref.url);
    if (!parsed || parsed.id !== ref.listingId) throw new ParserChangedError(`${RIGLA_DOMAIN}: некорректный ID карточки ${ref.listingId}`);
    const result = await requestHtml(parsed.url, context, this.fetchImpl);
    assertUsable(RIGLA_DOMAIN, result);
    const $ = load(result.html);
    const canonical = riglaProduct($("link[rel='canonical']").first().attr("href") ?? parsed.url);
    if (!canonical || canonical.id !== ref.listingId) throw new ParserChangedError(`${RIGLA_DOMAIN}:${ref.listingId}: canonical ведёт на другую карточку`);
    const title = compactText($("h1").first().text());
    if (!title) throw new ParserChangedError(`${RIGLA_DOMAIN}:${ref.listingId}: название не найдено`);
    const state = riglaState(result.html) as { productView?: { reviews?: unknown[] } };
    const reviewItems = state.productView?.reviews;
    if (!Array.isArray(reviewItems)) throw new ParserChangedError(`${RIGLA_DOMAIN}:${ref.listingId}: список отзывов не найден`);
    const reviewIds = new Set<string>();
    const ratings: number[] = [];
    for (const item of reviewItems) {
      if (!item || typeof item !== "object") throw new ParserChangedError(`${RIGLA_DOMAIN}:${ref.listingId}: некорректный отзыв`);
      const object = item as { id?: unknown; ratings?: unknown };
      const id = String(object.id ?? "").trim();
      if (!id || reviewIds.has(id)) throw new ParserChangedError(`${RIGLA_DOMAIN}:${ref.listingId}: дублирован или отсутствует ID отзыва`);
      reviewIds.add(id);
      const values = Array.isArray(object.ratings)
        ? object.ratings.map((entry) => rating((entry as { value?: unknown })?.value)).filter((value): value is number => value !== undefined)
        : [];
      if (values.length !== 1) throw new ParserChangedError(`${RIGLA_DOMAIN}:${ref.listingId}: у отзыва нет единственной общей оценки`);
      ratings.push(values[0]);
    }
    const reviews = reviewItems.length;
    const average = reviews ? Math.round(ratings.reduce((sum, value) => sum + value, 0) / reviews * 100) / 100 : null;
    return evidenceObservation(this.evidence, {
      domain: RIGLA_DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: canonical.url,
      title,
      reviews,
      rating: average,
      ratingCount: ratings.length,
      capturedAt: new Date().toISOString(),
      html: result.html,
      status: result.status,
      requestedUrl: result.requestedUrl,
      source: "rigla-initial-state-reviews"
    });
  }
}

const ZDRAV_DOMAIN = "zdravcity.ru";
const ZDRAV_ORIGIN = `https://${ZDRAV_DOMAIN}`;
const ZDRAV_PRODUCT = /^\/p_([a-z0-9][a-z0-9-]*-\d+)\.html\/?$/i;

function zdravProduct(value: string): { pathId: string; url: string } | undefined {
  try {
    const url = new URL(value, ZDRAV_ORIGIN);
    if (url.protocol !== "https:" || url.hostname.replace(/^www\./, "") !== ZDRAV_DOMAIN) return undefined;
    const pathId = url.pathname.match(ZDRAV_PRODUCT)?.[1];
    return pathId ? { pathId, url: `${ZDRAV_ORIGIN}/p_${pathId}.html` } : undefined;
  } catch { return undefined; }
}

function zdravStructuredFeedback(
  html: string,
  binding: { canonicalUrl: string; title: string; sku?: string }
): number | null {
  const $ = load(html);
  const counts = new Set<number>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const item = value as {
      "@type"?: unknown;
      "@graph"?: unknown;
      name?: unknown;
      sku?: unknown;
      url?: unknown;
      aggregateRating?: { reviewCount?: unknown; ratingCount?: unknown };
    };
    visit(item["@graph"]);
    const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
    if (!types.includes("Product")) return;

    const candidateName = typeof item.name === "string" ? item.name : "";
    const candidateSku = typeof item.sku === "string" || typeof item.sku === "number" ? String(item.sku).trim() : "";
    const candidateUrl = typeof item.url === "string" ? zdravProduct(item.url)?.url : undefined;
    const nameMatches = Boolean(candidateName) && normalizeText(candidateName) === normalizeText(binding.title);
    const skuMatches = Boolean(candidateSku && binding.sku) && candidateSku === binding.sku;
    const urlMatches = candidateUrl === binding.canonicalUrl;
    if (candidateSku && binding.sku && !skuMatches || candidateUrl && !urlMatches) return;
    if (!nameMatches && !skuMatches && !urlMatches) return;

    const reviewCount = integer(item.aggregateRating?.reviewCount);
    const ratingCount = integer(item.aggregateRating?.ratingCount);
    for (const count of [reviewCount, ratingCount]) if (count !== undefined) counts.add(count);
  };
  for (const script of $("script[type='application/ld+json']").toArray()) {
    try { visit(JSON.parse($(script).text())); }
    catch { /* optional structured counter */ }
  }
  return counts.size ? Math.max(...counts) : null;
}

function nextData(html: string, domain: string): Record<string, unknown> {
  const source = load(html)("#__NEXT_DATA__").first().text();
  if (!source) throw new ParserChangedError(`${domain}: __NEXT_DATA__ не найден`);
  try { return JSON.parse(source) as Record<string, unknown>; }
  catch { throw new ParserChangedError(`${domain}: __NEXT_DATA__ содержит невалидный JSON`); }
}

type ZdravPreview = { id?: unknown; url?: unknown; name?: unknown; brand?: { name?: unknown }; sku?: unknown };

export class ZdravcityAdapter extends PharmacyAdapter {
  readonly id = "pharmacy:zdravcity:v1";
  readonly supportedDomains = [ZDRAV_DOMAIN, `www.${ZDRAV_DOMAIN}`] as const;

  healthCheck(context: AdapterContext): Promise<AdapterHealth> { return this.canary("Кагоцел", context); }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map<string, ProductRef>();
    let missing = 0;
    let ambiguous = 0;
    for (const slug of brandSlugs(brand)) {
      const source = `${ZDRAV_ORIGIN}/g_${slug}/`;
      const result = await requestHtml(source, context, this.fetchImpl);
      if (result.status === 404 || result.status === 410) { missing += 1; continue; }
      assertUsable(ZDRAV_DOMAIN, result);
      const data = nextData(result.html, ZDRAV_DOMAIN) as { props?: { pageProps?: { products?: ZdravPreview[] } } };
      const products = data.props?.pageProps?.products;
      if (!Array.isArray(products)) throw new ParserChangedError(`${ZDRAV_DOMAIN}: список товаров бренда не найден`);
      for (const item of products) {
        const id = typeof item.id === "string" ? item.id.trim().toUpperCase() : "";
        const parsed = zdravProduct(String(item.url ?? ""));
        const title = compactText(String(item.name ?? ""));
        const detectedBrand = compactText(String(item.brand?.name ?? ""));
        if (!id || !parsed || !title) continue;
        if (!matchesBrand(`${title} ${detectedBrand}`, brand)) continue;
        refs.set(id, productRef(ZDRAV_DOMAIN, id, brand, parsed.url, title, "zdravcity-group-next-data"));
      }
      if (refs.size) break;
      ambiguous += 1;
    }
    for (const previous of context.previousRefs ?? []) {
      const parsed = zdravProduct(previous.url);
      const id = previous.listingId.trim().toUpperCase();
      if (parsed && /^[0-9A-F-]{36}$/.test(id) && !refs.has(id)) {
        refs.set(id, productRef(ZDRAV_DOMAIN, id, brand, parsed.url, undefined, "historical-registry"));
      }
    }
    if (!refs.size && missing === brandSlugs(brand).length) return [];
    if (!refs.size && ambiguous) throw new AdapterBlockedError(`${ZDRAV_DOMAIN}: брендовая страница не доказала карточки или отсутствие результатов`);
    return [...refs.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ru") || a.listingId.localeCompare(b.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsed = zdravProduct(ref.url);
    if (!parsed) throw new ParserChangedError(`${ZDRAV_DOMAIN}: некорректный URL карточки`);
    const result = await requestHtml(parsed.url, context, this.fetchImpl);
    assertUsable(ZDRAV_DOMAIN, result);
    const data = nextData(result.html, ZDRAV_DOMAIN) as {
      props?: { pageProps?: { productV2?: {
        id?: unknown;
        attributes?: { name?: unknown; url?: unknown; rating?: unknown; sku?: unknown };
        reviews?: Array<{ ID?: unknown; rate?: unknown }>;
      } } }
    };
    const product = data.props?.pageProps?.productV2;
    const id = typeof product?.id === "string" ? product.id.trim().toUpperCase() : "";
    if (!id || id !== ref.listingId.toUpperCase()) throw new ParserChangedError(`${ZDRAV_DOMAIN}:${ref.listingId}: страница вернула другой product ID`);
    const canonical = zdravProduct(String(product?.attributes?.url ?? parsed.url));
    const title = compactText(String(product?.attributes?.name ?? ""));
    const reviewItems = product?.reviews;
    if (!product || !canonical || !title || !Array.isArray(reviewItems)) throw new ParserChangedError(`${ZDRAV_DOMAIN}:${ref.listingId}: карточка неполна`);
    const reviewIds = new Set<string>();
    for (const item of reviewItems) {
      const reviewId = String(item.ID ?? "").trim();
      if (!reviewId || reviewIds.has(reviewId)) throw new ParserChangedError(`${ZDRAV_DOMAIN}:${ref.listingId}: дублирован или отсутствует ID отзыва`);
      reviewIds.add(reviewId);
    }
    const reviews = reviewItems.length;
    const rawRating = rating(product.attributes?.rating);
    if (reviews > 0 && rawRating === undefined) throw new ParserChangedError(`${ZDRAV_DOMAIN}:${ref.listingId}: отзывы есть, но общий рейтинг отсутствует`);
    const structuredCount = zdravStructuredFeedback(result.html, {
      canonicalUrl: canonical.url,
      title,
      sku: typeof product.attributes?.sku === "string" || typeof product.attributes?.sku === "number"
        ? String(product.attributes.sku).trim()
        : undefined
    });
    return evidenceObservation(this.evidence, {
      domain: ZDRAV_DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: canonical.url,
      title,
      reviews,
      rating: rawRating ?? null,
      // The storefront labels this structured counter reviewCount, while its
      // visible written-review array can differ. Preserve it only technically.
      ratingCount: structuredCount,
      capturedAt: new Date().toISOString(),
      html: result.html,
      status: result.status,
      requestedUrl: result.requestedUrl,
      source: "zdravcity-next-data-written-reviews"
    });
  }
}

const FARMLEND_DOMAIN = "farmlend.ru";
const FARMLEND_TRANSLATE_HOST = "farmlend-ru.translate.goog";
const FARMLEND_PRODUCT = /^\/(?:([a-z0-9][a-z0-9-]*)\/)?product\/(\d+)\/?$/i;

function farmlendProduct(value: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value, `https://${FARMLEND_DOMAIN}/`);
    const host = url.hostname.replace(/^www\./, "");
    if (url.protocol !== "https:" || host !== FARMLEND_DOMAIN && url.hostname !== FARMLEND_TRANSLATE_HOST) return undefined;
    const match = url.pathname.match(FARMLEND_PRODUCT);
    if (!match) return undefined;
    const city = match[1] ? `${match[1]}/` : "";
    return { id: match[2], url: `https://${FARMLEND_DOMAIN}/${city}product/${match[2]}` };
  } catch { return undefined; }
}

export class FarmlendAdapter extends PharmacyAdapter {
  readonly id = "pharmacy:farmlend:v1";
  readonly supportedDomains = [FARMLEND_DOMAIN, `www.${FARMLEND_DOMAIN}`] as const;

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const source = new URL("https://farmlend.ru/vysokaya-gora/product/377094");
      const result = await requestHtml(translatedUrl(FARMLEND_TRANSLATE_HOST, source), context, this.fetchImpl);
      assertUsable(FARMLEND_DOMAIN, result);
      const $ = load(result.html);
      const base = sourceBase($, FARMLEND_DOMAIN);
      return farmlendProduct(base.toString())
        ? { ok: true, checkedAt, message: `${FARMLEND_DOMAIN}: translated first-party product is readable` }
        : { ok: false, checkedAt, message: `${FARMLEND_DOMAIN}: canary product identity changed` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const source = new URL(`https://${FARMLEND_DOMAIN}/search`);
    source.searchParams.set("keyword", brand);
    const result = await requestHtml(translatedUrl(FARMLEND_TRANSLATE_HOST, source), context, this.fetchImpl);
    assertUsable(FARMLEND_DOMAIN, result);
    const $ = load(result.html);
    const base = sourceBase($, FARMLEND_DOMAIN);
    if (base.pathname !== "/search" || base.searchParams.get("keyword") !== brand) {
      throw new ParserChangedError(`${FARMLEND_DOMAIN}: translated search does not prove the requested brand`);
    }
    const refs = new Map<string, ProductRef>();
    $("a[href]").each((_index, node) => {
      const parsed = farmlendProduct($(node).attr("href") ?? "");
      if (!parsed) return;
      const card = $(node).closest("article, li, [class*='product'], [class*='item']");
      const title = compactText($(node).text() || card.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!matchesBrand(title, brand)) return;
      refs.set(parsed.id, productRef(FARMLEND_DOMAIN, parsed.id, brand, parsed.url, title, "farmlend-search"));
    });
    appendPrevious(refs, FARMLEND_DOMAIN, brand, context, farmlendProduct);
    if (!refs.size) {
      const text = compactText($.root().text());
      if (/ничего не найдено|товары не найдены|no products found|nothing was found/i.test(text)) return [];
      throw new AdapterBlockedError(`${FARMLEND_DOMAIN}: поиск не доказал карточки или отсутствие результатов`);
    }
    return [...refs.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ru") || a.listingId.localeCompare(b.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsed = farmlendProduct(ref.url);
    if (!parsed || parsed.id !== ref.listingId) throw new ParserChangedError(`${FARMLEND_DOMAIN}: некорректный ID карточки ${ref.listingId}`);
    const source = new URL(parsed.url);
    const result = await requestHtml(translatedUrl(FARMLEND_TRANSLATE_HOST, source), context, this.fetchImpl);
    assertUsable(FARMLEND_DOMAIN, result);
    const $ = load(result.html);
    const base = farmlendProduct(sourceBase($, FARMLEND_DOMAIN).toString());
    const canonical = farmlendProduct($("link[rel='canonical']").first().attr("href") ?? "");
    if (!base || !canonical || base.id !== ref.listingId || canonical.id !== ref.listingId) {
      throw new ParserChangedError(`${FARMLEND_DOMAIN}:${ref.listingId}: страница не доказала identity карточки`);
    }
    const title = compactText($("h1").first().text());
    if (!title) throw new ParserChangedError(`${FARMLEND_DOMAIN}:${ref.listingId}: название не найдено`);
    const text = compactText($.root().text());
    const aggregate = text.match(/(?:Общий рейтинг|Overall rating)\s*([0-5](?:[.,]\d+)?)\s*(?:на основе|based on)\s*([\d\s\u00a0\u202f]+)\s*(?:отзыв[а-яё]* покупателей|customer reviews?)/iu);
    const explicitZero = /Пока еще никто не оставил отзыв|No one has left a review yet/i.test(text);
    const reviews = aggregate ? integer(aggregate[2]) : explicitZero ? 0 : undefined;
    const rawRating = aggregate ? rating(aggregate[1]) : undefined;
    if (reviews === undefined || reviews > 0 && rawRating === undefined) {
      throw new ParserChangedError(`${FARMLEND_DOMAIN}:${ref.listingId}: не найден подтверждённый счётчик текстовых отзывов`);
    }
    return evidenceObservation(this.evidence, {
      domain: FARMLEND_DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: canonical.url,
      title,
      reviews,
      rating: reviews === 0 ? null : rawRating!,
      ratingCount: reviews,
      capturedAt: new Date().toISOString(),
      html: result.html,
      status: result.status,
      requestedUrl: result.requestedUrl,
      source: "farmlend-visible-review-summary"
    });
  }
}

export function createPharmacyAdapters(evidence: EvidenceStore, fetchImpl?: typeof fetch): SiteAdapter[] {
  return [
    new FarmlendAdapter(evidence, fetchImpl),
    new OkaptekaAdapter(evidence, fetchImpl),
    new RiglaAdapter(evidence, fetchImpl),
    new ZdravcityAdapter(evidence, fetchImpl)
  ];
}
