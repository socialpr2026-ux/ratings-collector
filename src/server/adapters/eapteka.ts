import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { extractPageProductEvidence, titleProductEvidence } from "../utils/product-evidence.js";
import { readerProxyUrl } from "../utils/reader-proxy.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "eapteka.ru";
const ORIGIN = "https://www.eapteka.ru";
const TRANSLATE_ORIGIN = "https://www-eapteka-ru.translate.goog";
const HEALTH_URL = `${ORIGIN}/search/?q=${encodeURIComponent("Кагоцел")}`;
const MAX_DOCUMENT_BYTES = 8_000_000;
const PRODUCT_PATH = /^\/goods\/id(\d+)(?:\/|$)/i;
const BLOCK_MARKERS = /captcha|access denied|forbidden|доступ (?:ограничен|запрещен)|проверка браузера|слишком много запросов/i;

function normalizeHost(hostname: string): string {
  return hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
}

function listingIdFromUrl(value: string | URL): string | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || normalizeHost(url.hostname) !== DOMAIN) return undefined;
    return url.pathname.match(PRODUCT_PATH)?.[1];
  } catch {
    return undefined;
  }
}

function canonicalProductUrl(value: string, listingId: string): string | undefined {
  try {
    const url = new URL(value, ORIGIN);
    if (listingIdFromUrl(url) !== listingId) return undefined;
    return canonicalizeUrl(url.toString());
  } catch {
    return undefined;
  }
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!/^\d+(?:\.0+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseRating(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/[\s\u00a0]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dataLayerValue(html: string, key: "item_rating" | "item_reviews_count"): string | undefined {
  // eapteka currently renders these flat product values in its server-side
  // dataLayer. Supporting both quoted JSON and JS object keys keeps the
  // collector deterministic without executing any page script.
  const decoded = html.replace(/&quot;/gi, '"').replace(/&#34;/gi, '"');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = decoded.match(new RegExp(`["']?${escapedKey}["']?\\s*:\\s*(?:["']([^"']*)["']|(-?\\d+(?:[.,]\\d+)?))`, "i"));
  return match?.[1] ?? match?.[2];
}

function productPageMetrics(
  $: ReturnType<typeof load>,
  html: string,
  listingId: string,
  title: string
): { reviews: number; rating: number | null; ratingCount: number; orphanedStructured: boolean } {
  const hiddenReviews = parseNonNegativeInteger(dataLayerValue(html, "item_reviews_count"));
  const hiddenRating = parseRating(dataLayerValue(html, "item_rating"));
  let exactSection: ReturnType<typeof $> | undefined;
  let offerCount: number | undefined;
  let offerRating: number | undefined;

  $("section[data-entity-reviews][data-offer], .sec-item__reviews[data-offer]").each((_index, node) => {
    const entityId = $(node).attr("data-entity-reviews");
    if (entityId !== undefined && entityId !== listingId) return;
    let offer: Record<string, unknown>;
    try { offer = JSON.parse($(node).attr("data-offer") ?? ""); }
    catch { return; }
    if (String(offer.itemId ?? "") !== listingId) return;
    if (exactSection) throw new ParserChangedError(`${DOMAIN}:${listingId}: duplicate visible review sections`);
    exactSection = $(node);
    offerCount = parseNonNegativeInteger(String(offer.itemCount ?? ""));
    offerRating = parseRating(String(offer.itemRating ?? ""));
  });

  // Some Eapteka product pages keep a stale rating/dataLayer even though the
  // product has no review section. The employee-visible page is authoritative.
  if (!exactSection) {
    if (hiddenReviews === undefined) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: product page proved neither reviews nor their absence`);
    }
    const emptySections = $(`
      .sec-item__reviews-empty[data-entity-reviews='${listingId}'],
      [data-empty-reviews][data-entity-reviews='${listingId}']
    `);
    const explicitEmpty = emptySections.length === 1 &&
      /(?:отзывов\s+(?:пока\s+)?нет|нет\s+отзывов)/iu.test(compactText(emptySections.first().text()));
    if (hiddenReviews > 0 && !explicitEmpty) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: stale structured rating has no source-bound empty review proof`);
    }
    return { reviews: 0, rating: null, ratingCount: 0, orphanedStructured: (hiddenReviews ?? 0) > 0 };
  }
  const section = exactSection as ReturnType<typeof $>;
  const header = compactText(section.find(".sec-item__reviews-header").first().text());
  const headerMatch = header.match(/^(.*?):\s*([\d\s\u00a0]+)\s+отзыв/iu);
  const visibleCount = parseNonNegativeInteger(headerMatch?.[2]);
  const visibleRating = parseRating(section.find(".sec-item__rating-value").first().text());
  const hasReviewApplication = section.find(".reviews-application-container").length === 1;
  const hiddenRatingMatches = hiddenRating === undefined || offerRating !== undefined &&
    Math.round(hiddenRating * 10) === Math.round(offerRating * 10);
  if (normalizeText(headerMatch?.[1] ?? "") !== normalizeText(title) ||
      offerCount === undefined || visibleCount !== offerCount || hiddenReviews !== undefined && hiddenReviews !== offerCount ||
      offerCount > 0 && (offerRating === undefined || offerRating <= 0 || offerRating > 5 || visibleRating !== offerRating ||
        !hiddenRatingMatches) ||
      offerCount > 0 && !hasReviewApplication) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: visible product reviews do not match structured metrics`);
  }
  return { reviews: offerCount, rating: offerCount === 0 ? null : offerRating!, ratingCount: offerCount, orphanedStructured: false };
}

function parsedProductPage(html: string, listingId: string, requestUrl: string) {
  const $ = load(html);
  const title = compactText($("h1").first().text());
  if (!title) throw new ParserChangedError(`${DOMAIN}:${listingId}: не найдено название товара`);
  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  const canonicalUrl = canonicalHref
    ? canonicalProductUrl(canonicalHref, listingId) ?? requestUrl
    : requestUrl;
  return { $, title, canonicalUrl, metrics: productPageMetrics($, html, listingId, title) };
}

function isBlockedPage(html: string): boolean {
  const $ = load(html);
  const title = compactText($("title").first().text());
  return BLOCK_MARKERS.test(title) || /<(?:iframe|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 150_000));
}

function translatedUrl(source: URL): URL {
  const result = new URL(`${source.pathname}${source.search}`, TRANSLATE_ORIGIN);
  result.searchParams.set("_x_tr_sl", "ru");
  result.searchParams.set("_x_tr_tl", "en");
  result.searchParams.set("_x_tr_hl", "en");
  return result;
}

function sameSource(left: URL, right: URL): boolean {
  if (left.protocol !== "https:" || right.protocol !== "https:") return false;
  if (normalizeHost(left.hostname) !== normalizeHost(right.hostname) || left.pathname !== right.pathname) return false;
  return JSON.stringify([...left.searchParams.entries()].sort()) === JSON.stringify([...right.searchParams.entries()].sort());
}

function translatedSource(html: string, source: URL): ReturnType<typeof load> {
  const $ = load(html);
  try {
    const base = new URL($("base[href]").first().attr("href") ?? "");
    const proof = new URL($("[data-source-url]").first().attr("data-source-url") ?? "");
    if (!sameSource(base, source) || !sameSource(proof, source)) throw new Error("source mismatch");
  } catch {
    throw new ParserChangedError(`${DOMAIN}: translated page returned a different source URL`);
  }
  return $;
}

function readerMetrics(
  markdown: string,
  source: URL,
  listingId: string,
  allowSourceBoundEmpty = false
): { title: string; reviews: number; rating: number | null; ratingCount: number } {
  const titleLine = markdown.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const sourceLine = markdown.match(/^URL Source:\s*(\S+)\s*$/m)?.[1];
  if (!titleLine || !sourceLine) throw new ParserChangedError(`${DOMAIN}: reader response has no title or source proof`);
  let returnedSource: URL;
  try { returnedSource = new URL(sourceLine); }
  catch { throw new ParserChangedError(`${DOMAIN}: reader response has an invalid source proof`); }
  if (!sameSource(returnedSource, source)) throw new ParserChangedError(`${DOMAIN}: reader returned a different product page`);
  if (/доступ к сервису запрещ[её]н|requiring captcha|проверяет, что вы не бот/i.test(markdown)) {
    throw new AdapterBlockedError(`${DOMAIN}: product reader is blocked`);
  }
  const title = titleLine.replace(/\s+-\s+(?:купить|цена|отзывы).*$/iu, "").trim();
  const metric = markdown.match(/####\s*([^\r\n]{1,320}?):\s*([\d\s\u00a0]+)\s+[^\d\r\n][^\r\n]*\r?\n\r?\n([0-5](?:[.,]\d+)?)\r?\n\r?\n[^\r\n]*?([\d\s\u00a0]+)\s+[^\d\r\n][^\r\n]*/);
  const reviews = parseNonNegativeInteger(metric?.[2]);
  const rating = parseRating(metric?.[3]);
  const ratingCount = parseNonNegativeInteger(metric?.[4]);
  if (reviews === undefined || ratingCount === undefined) {
    const exactProductProof = new RegExp(`(?:^|\\n)\\s*Арт\\.\\s*${listingId}\\s*(?:\\n|$)`, "iu").test(markdown);
    const visibleReviewSection = /^#{1,6}\s+(?:Отзывы|Написать отзыв)\b/imu.test(markdown) ||
      /(?:^|\n)\s*Написать отзыв\s*(?:\n|$)/iu.test(markdown);
    if (allowSourceBoundEmpty && exactProductProof && !visibleReviewSection) {
      return { title, reviews: 0, rating: null, ratingCount: 0 };
    }
    throw new ParserChangedError(`${DOMAIN}: reader did not prove a written-review and rating total`);
  }
  const metricTail = markdown.slice((metric?.index ?? markdown.length) + (metric?.[0].length ?? 0), (metric?.index ?? markdown.length) + 3_000);
  if (normalizeText(metric?.[1] ?? "") !== normalizeText(title) || reviews > 0 && !/Написать отзыв[\s\S]*^#####\s+/imu.test(metricTail)) {
    throw new ParserChangedError(`${DOMAIN}: reader metrics are not bound to visible reviews of the requested product`);
  }
  const feedbackCount = Math.max(reviews, ratingCount);
  if (feedbackCount > 0 && (rating === undefined || rating <= 0 || rating > 5)) {
    throw new ParserChangedError(`${DOMAIN}: reader returned feedback without a valid rating`);
  }
  return { title, reviews, rating: feedbackCount === 0 ? null : rating!, ratingCount };
}

function hasExactListingCanary(html: string): boolean {
  const $ = load(html);
  let proved = false;
  $(".listing-card[itemscope]").each((_index, node) => {
    if (proved) return;
    const root = $(node);
    const link = root.find("link[itemprop='url']").first().attr("content") ?? root.find("link[itemprop='url']").first().attr("href");
    let listingId: string | undefined;
    try { listingId = link ? listingIdFromUrl(new URL(link, ORIGIN)) : undefined; }
    catch { listingId = undefined; }
    const aggregate = root.find("[itemprop='aggregateRating']").first();
    const metricScope = aggregate.length ? aggregate : root;
    const reviews = parseNonNegativeInteger(metricScope.find("meta[itemprop='reviewCount']").first().attr("content"));
    const rating = parseRating(metricScope.find("meta[itemprop='ratingValue']").first().attr("content"));
    if (listingId && reviews !== undefined && (reviews === 0 || rating !== undefined && rating > 0 && rating <= 5)) proved = true;
  });
  return proved;
}

function previousRefs(brand: string, context: AdapterContext): ProductRef[] {
  const refs = new Map<string, ProductRef>();
  for (const previous of context.previousRefs ?? []) {
    const listingId = listingIdFromUrl(previous.url) ?? (/^\d+$/.test(previous.listingId) ? previous.listingId : undefined);
    if (!listingId) continue;
    const url = canonicalProductUrl(previous.url, listingId) ?? `${ORIGIN}/goods/id${listingId}/`;
    refs.set(listingId, { domain: DOMAIN, platform: DOMAIN, listingId, brand, url, metadata: { discovery: "registry" } });
  }
  for (const rawId of context.previousIds ?? []) {
    const listingId = rawId.match(/^\d+$/)?.[0];
    if (!listingId || refs.has(listingId)) continue;
    refs.set(listingId, {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId,
      brand,
      url: `${ORIGIN}/goods/id${listingId}/`,
      metadata: { discovery: "registry" }
    });
  }
  return [...refs.values()];
}

export class EaptekaAdapter implements SiteAdapter {
  readonly id = DOMAIN;
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const direct = await this.request(HEALTH_URL, context);
      if (direct.response.ok && !isBlockedPage(direct.html)) {
        if (!hasExactListingCanary(direct.html)) {
          return { ok: false, checkedAt, message: `parser_changed: ${DOMAIN} direct canary has no exact aggregate listing card` };
        }
        return { ok: true, checkedAt, message: `${DOMAIN}: direct search is healthy` };
      }
      const { html } = await this.requestTranslated(HEALTH_URL, context);
      translatedSource(html, new URL(HEALTH_URL));
      if (!hasExactListingCanary(html)) {
        return { ok: false, checkedAt, message: `parser_changed: ${DOMAIN} translated canary has no exact listing cards` };
      }
      return { ok: true, checkedAt, message: `${DOMAIN}: fixed translated search is healthy` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        checkedAt,
        message: error instanceof ParserChangedError ? `parser_changed: ${message}` : `blocked_free_mode: ${message}`
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map(previousRefs(brand, context).map((ref) => [ref.listingId, ref]));
    const searchUrl = `${ORIGIN}/search/?q=${encodeURIComponent(brand)}`;
    let { response, html } = await this.request(searchUrl, context);
    let translated = false;
    if (!response.ok || isBlockedPage(html)) {
      ({ response, html } = await this.requestTranslated(searchUrl, context));
      translatedSource(html, new URL(searchUrl));
      translated = true;
    } else {
      this.assertUsable(response, html, searchUrl);
    }

    const $ = load(html);
    const roots = translated ? $(".listing-card[itemscope]") : $("a[href]");
    roots.each((_index, node) => {
      const root = $(node);
      const href = translated
        ? root.find("link[itemprop='url']").first().attr("content") ?? root.find("link[itemprop='url']").first().attr("href")
        : root.attr("href");
      if (!href) return;
      let url: URL;
      try { url = new URL(href, searchUrl); }
      catch { return; }
      const listingId = listingIdFromUrl(url);
      if (!listingId) return;
      const title = translated
        ? brand
        : compactText(`${root.text()} ${root.closest("article, li, [class*='card'], [class*='product']").text()}`);
      if (!translated && !matchesBrand(title, brand)) return;
      const canonicalUrl = canonicalProductUrl(url.toString(), listingId);
      if (!canonicalUrl) return;
      refs.set(listingId, {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId,
        brand,
        url: canonicalUrl,
        title,
        metadata: { discovery: translated ? "eapteka-search-google-translate" : "eapteka-search", searchUrl }
      });
    });

    return [...refs.values()].sort((left, right) =>
      (left.title ?? "").localeCompare(right.title ?? "", "ru") || Number(left.listingId) - Number(right.listingId)
    );
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = /^\d+$/.test(ref.listingId) ? ref.listingId : listingIdFromUrl(ref.url);
    if (!listingId) throw new ParserChangedError(`${DOMAIN}: некорректный ID карточки ${ref.listingId}`);
    const requestUrl = canonicalProductUrl(ref.url, listingId) ?? `${ORIGIN}/goods/id${listingId}/`;
    const capturedAt = new Date().toISOString();
    let { response, html } = await this.request(requestUrl, context);
    let source = "eapteka-data-layer";

    if (response.status === 404 || response.status === 410) {
      return {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId,
        brand: ref.brand,
        canonicalUrl: requestUrl,
        product: ref.title?.trim() || ref.brand,
        reviews: null,
        rating: null,
        status: "not_found",
        capturedAt,
        source: "eapteka-data-layer"
      };
    }
    if (!response.ok || isBlockedPage(html)) {
      try {
        ({ response, html } = await this.requestTranslated(requestUrl, context));
        translatedSource(html, new URL(requestUrl));
        source = "eapteka-visible-product-reviews:google-translate";
      } catch (error) {
        if (!(error instanceof AdapterBlockedError || error instanceof ParserChangedError)) throw error;
        return this.collectFromReader(ref, listingId, requestUrl, capturedAt, context);
      }
    }
    this.assertUsable(response, html, requestUrl);

    let page: ReturnType<typeof parsedProductPage>;
    try {
      page = parsedProductPage(html, listingId, requestUrl);
    } catch (error) {
      if (error instanceof ParserChangedError && /stale structured rating/i.test(error.message)) {
        return this.collectFromReader(ref, listingId, requestUrl, capturedAt, context, true);
      }
      throw error;
    }
    if (source === "eapteka-data-layer" && page.metrics.orphanedStructured) {
      try {
        ({ response, html } = await this.requestTranslated(requestUrl, context));
        translatedSource(html, new URL(requestUrl));
        source = "eapteka-visible-product-reviews:google-translate";
        page = parsedProductPage(html, listingId, requestUrl);
      } catch (error) {
        if (!(error instanceof AdapterBlockedError || error instanceof ParserChangedError)) throw error;
        return this.collectFromReader(ref, listingId, requestUrl, capturedAt, context);
      }
    }
    const { $, title, canonicalUrl, metrics } = page;

    const productEvidence = extractPageProductEvidence(html, canonicalUrl, ref.brand, {
      structuredSignals: [title]
    });
    if (!productEvidence.identifiers.some((item) => item.type === "product_id" && item.value === listingId)) {
      productEvidence.identifiers.push({ type: "product_id", value: listingId });
    }
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: requestUrl,
      status: response.status,
      bodyDigest: createHash("sha256").update(html).digest("hex"),
      parsed: { listingId, title, canonicalUrl, reviews: metrics.reviews, rating: metrics.rating, ratingCount: metrics.ratingCount },
      productEvidence,
      source
    });
    const brandMatches = matchesBrand(title, ref.brand);
    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId,
      brand: ref.brand,
      canonicalUrl,
      product: title,
      reviews: metrics.reviews,
      rating: metrics.rating,
      rawRating: metrics.rating,
      rawRatingScale: 5,
      ratingCount: metrics.ratingCount,
      status: brandMatches ? (metrics.reviews === 0 ? "no_reviews" : "ok") : "needs_review",
      capturedAt,
      evidenceRef,
      productEvidence,
      source
    };
  }

  private async request(url: string, context: AdapterContext): Promise<{ response: Response; html: string }> {
    let response: Response;
    try {
      response = await safeFetch(url, {
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: context.signal
      }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: HTTP-запрос не выполнен: ${error instanceof Error ? error.message : String(error)}`);
    }
    let html: string;
    try { html = await readTextBounded(response, MAX_DOCUMENT_BYTES); }
    catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: ответ не прочитан: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { response, html };
  }

  private async requestTranslated(url: string, context: AdapterContext): Promise<{ response: Response; html: string }> {
    const source = new URL(url);
    const endpoint = translatedUrl(source);
    let response: Response;
    try {
      response = await safeFetch(endpoint.toString(), {
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: context.signal
      }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: translated request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const html = await readTextBounded(response, MAX_DOCUMENT_BYTES);
    if (!response.ok || isBlockedPage(html)) {
      throw new AdapterBlockedError(`${DOMAIN}: translated page is blocked (HTTP ${response.status})`);
    }
    return { response, html };
  }

  private async collectFromReader(
    ref: ProductRef,
    listingId: string,
    requestUrl: string,
    capturedAt: string,
    context: AdapterContext,
    allowSourceBoundEmpty = false
  ): Promise<Observation> {
    const source = new URL(requestUrl);
    const endpoint = readerProxyUrl(source);
    let response: Response;
    try {
      response = await safeFetch(endpoint.toString(), { signal: context.signal, headers: { accept: "text/plain,text/markdown" } }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: product reader failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const markdown = await readTextBounded(response, 2_000_000);
    if (!response.ok) throw new AdapterBlockedError(`${DOMAIN}: product reader returned HTTP ${response.status}`);
    const parsed = readerMetrics(markdown, source, listingId, allowSourceBoundEmpty);
    if (!matchesBrand(parsed.title, ref.brand)) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: reader returned another brand or product`);
    }
    const productEvidence = titleProductEvidence(parsed.title, { type: "product_id", value: listingId }, requestUrl);
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: requestUrl,
      status: response.status,
      bodyDigest: createHash("sha256").update(markdown).digest("hex"),
      parsed: { listingId, title: parsed.title, canonicalUrl: requestUrl, reviews: parsed.reviews, rating: parsed.rating, ratingCount: parsed.ratingCount },
      productEvidence,
      source: "eapteka-reader-product"
    });
    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId,
      brand: ref.brand,
      canonicalUrl: requestUrl,
      product: parsed.title,
      reviews: parsed.reviews,
      rating: parsed.rating,
      rawRating: parsed.rating,
      rawRatingScale: 5,
      ratingCount: parsed.ratingCount,
      status: parsed.reviews === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence,
      source: "eapteka-reader-product"
    };
  }

  private assertUsable(response: Response, html: string, url: string): void {
    if (!response.ok || isBlockedPage(html)) {
      throw new AdapterBlockedError(`${DOMAIN} не отдал страницу ${url}: HTTP ${response.status}`);
    }
  }
}
