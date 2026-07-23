import { createHash } from "node:crypto";
import { load } from "cheerio";
import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductEvidence,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "vitaexpress.ru";
const ORIGIN = `https://${DOMAIN}`;
const MAX_DOCUMENT_BYTES = 1_500_000;
const BLOCKED_STATUSES = new Set([401, 403, 429, 498]);
const BLOCK_MARKERS = /captcha|access denied|forbidden|cloudflare|qrator|temporarily unavailable|\u0434\u043e\u0441\u0442\u0443\u043f (?:\u043e\u0433\u0440\u0430\u043d\u0438\u0447\u0435\u043d|\u0437\u0430\u043f\u0440\u0435\u0449[\u0435\u0451]\u043d)|\u0441\u043b\u0438\u0448\u043a\u043e\u043c \u043c\u043d\u043e\u0433\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u043e\u0432|\u043f\u0440\u043e\u0432\u0435\u0440(?:\u043a\u0430|\u044c\u0442\u0435),? \u0447\u0442\u043e \u0432\u044b \u043d\u0435 \u0440\u043e\u0431\u043e\u0442|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435,? \u0447\u0442\u043e \u0432\u044b \u0447\u0435\u043b\u043e\u0432\u0435\u043a/iu;
const EMPTY_REVIEW_TEXT = "\u0432\u0430\u0448 \u043e\u0442\u0437\u044b\u0432 \u043e \u0442\u043e\u0432\u0430\u0440\u0435 \u0441\u0442\u0430\u043d\u0435\u0442 \u043f\u0435\u0440\u0432\u044b\u043c";

type ExactProduct = {
  id: string;
  brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442" | "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d" | "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442" | "\u0422\u0430\u0443\u0441\u0442\u0438\u043d" | "Бактоблис";
  url: string;
  requiredPhrases: readonly string[];
};

type ParsedPage = {
  canonicalUrl: string;
  title: string;
  productEvidence: ProductEvidence;
  reviews: number;
  writtenReviewCount: number;
  rating: number | null;
  ratingCount: number;
};

type FetchedPage = ParsedPage & {
  body: string;
  status: number;
};

const EXACT_PRODUCTS: readonly ExactProduct[] = [
  {
    id: "193139",
    brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442",
    url: `${ORIGIN}/product/biviart_komfort_r_r_uvlazhn__oftalmolog__0_18_10ml__1_fl_/`,
    requiredPhrases: ["\u0431\u0438\u0432\u0438\u0430\u0440\u0442 \u043a\u043e\u043c\u0444\u043e\u0440\u0442", "0 18", "10\u043c\u043b"]
  },
  {
    id: "193140",
    brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442",
    url: `${ORIGIN}/product/biviart_soft_r_r_uvlazhn__oftalmolog__0_1_10ml__1_fl_/`,
    requiredPhrases: ["\u0431\u0438\u0432\u0438\u0430\u0440\u0442 \u0441\u043e\u0444\u0442", "0 1", "10\u043c\u043b"]
  },
  {
    id: "193141",
    brand: "\u0411\u0438\u0432\u0438\u0430\u0440\u0442",
    url: `${ORIGIN}/product/biviart_ultra_r_r_uvlazhn__oftalmolog__0_3_10ml__1_fl_/`,
    requiredPhrases: ["\u0431\u0438\u0432\u0438\u0430\u0440\u0442 \u0443\u043b\u044c\u0442\u0440\u0430", "0 3", "10\u043c\u043b"]
  },
  {
    id: "178185",
    brand: "\u041e\u043a\u0443\u0441\u0430\u043b\u0438\u043d",
    url: `${ORIGIN}/product/okusalin_rastvor_dlya_promyvaniya_glaz_3_2ml_10/`,
    requiredPhrases: ["\u043e\u043a\u0443\u0441\u0430\u043b\u0438\u043d", "\u0440\u0430\u0441\u0442\u0432\u043e\u0440 \u0434\u043b\u044f \u043f\u0440\u043e\u043c\u044b\u0432\u0430\u043d\u0438\u044f \u0433\u043b\u0430\u0437", "3", "2\u043c\u043b", "no10"]
  },
  {
    id: "202806",
    brand: "\u041e\u0444\u0442\u0430\u0440\u0438\u043d\u0442",
    url: `${ORIGIN}/product/oftarint_kapli_glaznye_2mg_20mg_0_675mgml_10ml_fl_kap_/`,
    requiredPhrases: ["\u043e\u0444\u0442\u0430\u0440\u0438\u043d\u0442", "\u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435", "10\u043c\u043b"]
  },
  {
    id: "203245",
    brand: "\u0422\u0430\u0443\u0441\u0442\u0438\u043d",
    url: `${ORIGIN}/product/taurin__taustin__kapli_glaznye_4_10ml_solofarm/`,
    requiredPhrases: ["\u0442\u0430\u0443\u0441\u0442\u0438\u043d", "\u0441\u043e\u043b\u043e\u0444\u0430\u0440\u043c", "\u043a\u0430\u043f\u043b\u0438 \u0433\u043b\u0430\u0437\u043d\u044b\u0435", "4", "10\u043c\u043b"]
  },
  {
    id: "203657",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_plyus_tab__drassas___30_bsakhara_bad/`,
    requiredPhrases: ["бактоблис", "таблетки для рассасывания", "no30", "без сахара"]
  },
  {
    id: "197583",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_plyus_tab__drassas__950mg__90_bad/`,
    requiredPhrases: ["бактоблис плюс", "таблетки для рассасывания", "no90"]
  },
  {
    id: "190233",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_por__dpr__vnutr_1500mg__15_sashe_pak__bad/`,
    requiredPhrases: ["бактоблис", "порошок в саше пакетах", "no15"]
  },
  {
    id: "193661",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_por__dpr__vnutr_1500mg__30_sashe_pak__bad/`,
    requiredPhrases: ["бактоблис", "порошок в саше пакетах", "no30"]
  },
  {
    id: "175303",
    brand: "Бактоблис",
    url: `${ORIGIN}/product/baktoblis_tabletki_bad_30/`,
    requiredPhrases: ["бактоблис плюс", "таблетки для рассасывания", "no30"]
  }
] as const;

const PRODUCTS_BY_ID = new Map(EXACT_PRODUCTS.map((product) => [product.id, product]));
const PRODUCTS_BY_BRAND = new Map<string, ExactProduct[]>();
for (const product of EXACT_PRODUCTS) {
  const key = normalizeText(product.brand);
  PRODUCTS_BY_BRAND.set(key, [...(PRODUCTS_BY_BRAND.get(key) ?? []), product]);
}
const HEALTH_PRODUCT = PRODUCTS_BY_ID.get("178185")!;

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizedHost(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./u, "");
}

function isBlockedBody(body: string): boolean {
  const sample = body.slice(0, 250_000);
  return BLOCK_MARKERS.test(sample) || /<(?:iframe|input)\b[^>]*(?:captcha|challenge)/iu.test(sample);
}

function parseJsonAttribute(value: string | undefined, label: string, productId: string): unknown {
  if (!value || value.length > 100_000) {
    throw new ParserChangedError(`${DOMAIN}:${productId}: missing or oversized ${label} payload`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ParserChangedError(`${DOMAIN}:${productId}: invalid ${label} JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesExactTitle(title: string, product: ExactProduct): boolean {
  if (!matchesBrand(title, product.brand)) return false;
  const normalized = ` ${normalizeText(title)} `;
  return product.requiredPhrases.every((phrase) => normalized.includes(` ${normalizeText(phrase)} `));
}

function productEvidence(product: ExactProduct, title: string): ProductEvidence {
  return {
    scope: "listing",
    signals: [
      { source: "title", text: title },
      { source: "url", text: product.url }
    ],
    variants: [],
    identifiers: [{ type: "product_id", value: product.id }],
    imageUrls: [],
    instructionUrls: []
  };
}

function parseExactPage(body: string, product: ExactProduct): ParsedPage {
  const $ = load(body);
  const titleNodes = $("h1");
  const title = compactText(titleNodes.first().text());
  if (titleNodes.length !== 1 || !title || !matchesExactTitle(title, product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: exact product title changed`);
  }

  const canonicalNodes = $("link[rel='canonical'][href]");
  if (canonicalNodes.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: canonical URL is missing or duplicated`);
  }
  let canonical: URL;
  try { canonical = new URL(canonicalNodes.first().attr("href") ?? "", ORIGIN); }
  catch { throw new ParserChangedError(`${DOMAIN}:${product.id}: canonical URL is invalid`); }
  const expectedUrl = new URL(product.url);
  if (canonical.protocol !== "https:" || normalizedHost(canonical.hostname) !== DOMAIN ||
      canonical.pathname !== expectedUrl.pathname || canonical.search || canonical.hash) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: canonical URL belongs to another product`);
  }

  const pageRoots = $("#page-content[data-id]");
  const pageRoot = pageRoots.first();
  if (pageRoots.length !== 1 || pageRoot.attr("data-id") !== product.id ||
      pageRoot.attr("data-xml") !== product.id || pageRoot.attr("data-xml_id") !== product.id ||
      pageRoot.attr("data-url") !== expectedUrl.pathname ||
      !matchesExactTitle(pageRoot.attr("data-name") ?? "", product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: first-party product identity changed`);
  }

  const reviewComponents = $("product-reviews");
  const reviews = reviewComponents.first();
  if (reviewComponents.length !== 1 || reviews.attr(":id") !== product.id ||
      reviews.attr(":product-id") !== product.id ||
      !matchesExactTitle(reviews.attr("name") ?? "", product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: product-bound review component changed`);
  }

  const reviewPayload = parseJsonAttribute(reviews.attr(":reviews"), "reviews", product.id);
  if (!isRecord(reviewPayload) || String(reviewPayload.productId) !== product.id ||
      reviewPayload.reviewList !== null && !Array.isArray(reviewPayload.reviewList)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: written-review list is not source-bound`);
  }

  const ratingPayload = parseJsonAttribute(reviews.attr(":rating"), "rating", product.id);
  if (!Array.isArray(ratingPayload) || ratingPayload.length !== 1 || !isRecord(ratingPayload[0])) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: rating-count payload changed`);
  }
  const aggregate = ratingPayload[0];
  const reviewsCount = Number(aggregate.reviewsCount);
  const rawRating = Number(aggregate.rating);
  if (String(aggregate.productId) !== product.id || aggregate.status !== true ||
      !Number.isInteger(reviewsCount) || reviewsCount < 0 ||
      !Number.isFinite(rawRating) || rawRating < 0 || rawRating > 5 ||
      (reviewsCount === 0) !== (rawRating === 0)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: source-bound review aggregate is invalid`);
  }

  const reviewText = normalizeText(reviews.text());
  const headings = reviews.find("h2");
  const headingText = compactText(headings.first().text());
  if (headings.length !== 1 || !normalizeText(headingText).startsWith("отзывы о товаре ") ||
      !matchesExactTitle(headingText, product)) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: visible review heading is missing`);
  }
  const reviewList = reviewPayload.reviewList;
  if (reviewsCount === 0 && (reviewList !== null || !reviewText.includes(EMPTY_REVIEW_TEXT))) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: visible first-review empty state is missing`);
  }
  if (reviewsCount > 0 && (!Array.isArray(reviewList) || reviewList.length === 0 || reviewText.includes(EMPTY_REVIEW_TEXT))) {
    throw new ParserChangedError(`${DOMAIN}:${product.id}: positive written-review state is not proven`);
  }

  return {
    canonicalUrl: product.url,
    title,
    productEvidence: productEvidence(product, title),
    reviews: reviewsCount,
    writtenReviewCount: Array.isArray(reviewList) ? reviewList.length : 0,
    rating: reviewsCount === 0 ? null : rawRating,
    ratingCount: reviewsCount
  };
}

export class VitaExpressAdapter implements SiteAdapter {
  readonly id = DOMAIN;
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;
  private readonly pageCache = new Map<string, Promise<FetchedPage>>();

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await this.fetchExact(HEALTH_PRODUCT, context);
      return { ok: true, checkedAt, message: `${DOMAIN}: exact product identity and visible empty-review state are healthy` };
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
    const expected = PRODUCTS_BY_BRAND.get(normalizeText(brand));
    if (!expected) {
      throw new ParserChangedError(`${DOMAIN}: brand ${brand} is outside the bounded exact registry`);
    }

    const pages = await Promise.all(expected.map(async (product) => ({
      product,
      page: await this.fetchExact(product, context)
    })));
    return pages.map(({ product, page }): ProductRef => ({
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: product.id,
      brand,
      url: product.url,
      title: page.title,
      metadata: { discovery: "vitaexpress-bounded-exact-product-page" }
    }));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const product = PRODUCTS_BY_ID.get(ref.listingId);
    if (!product || normalizeText(product.brand) !== normalizeText(ref.brand) || ref.url !== product.url) {
      throw new ParserChangedError(`${DOMAIN}: product reference ${ref.listingId} is outside the bounded exact registry`);
    }

    const capturedAt = new Date().toISOString();
    const page = await this.fetchExact(product, context);
    const source = page.reviews === 0
      ? "vitaexpress-visible-first-review-empty-state"
      : "vitaexpress-source-bound-review-aggregate";
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: product.url,
      status: page.status,
      bodyDigest: createHash("sha256").update(page.body).digest("hex"),
      parsed: {
        listingId: product.id,
        title: page.title,
        canonicalUrl: page.canonicalUrl,
        reviews: page.reviews,
        writtenReviewCount: page.writtenReviewCount,
        rating: page.rating,
        ratingCount: page.ratingCount,
        countMeaning: "source-bound reviewsCount plus product-bound written-review component"
      },
      productEvidence: page.productEvidence,
      source
    });

    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: product.id,
      brand: ref.brand,
      canonicalUrl: page.canonicalUrl,
      product: page.title,
      reviews: page.reviews,
      writtenReviewCount: page.writtenReviewCount,
      rating: page.rating,
      ratingCount: page.ratingCount,
      status: page.reviews === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence: page.productEvidence,
      source
    };
  }

  private fetchExact(product: ExactProduct, context: AdapterContext): Promise<FetchedPage> {
    if (!context.runId) return this.loadExact(product, context);
    const key = `${context.runId}:${product.id}`;
    const cached = this.pageCache.get(key);
    if (cached) return cached;
    const pending = this.loadExact(product, context).catch((error) => {
      this.pageCache.delete(key);
      throw error;
    });
    this.pageCache.set(key, pending);
    return pending;
  }

  private async loadExact(product: ExactProduct, context: AdapterContext): Promise<FetchedPage> {
    let response: Response;
    try {
      response = await safeFetch(product.url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ru-RU,ru;q=0.9",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
        },
        signal: context.signal
      }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let body: string;
    try { body = await readTextBounded(response, MAX_DOCUMENT_BYTES); }
    catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (BLOCKED_STATUSES.has(response.status) || response.status >= 500 || isBlockedBody(body)) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: blocked response HTTP ${response.status}`);
    }
    if (response.status === 404 || response.status === 410) {
      throw new ParserChangedError(`${DOMAIN}:${product.id}: expected exact product page disappeared (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new AdapterBlockedError(`${DOMAIN}:${product.id}: unexpected HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      throw new ParserChangedError(`${DOMAIN}:${product.id}: product page returned non-HTML content`);
    }

    return { ...parseExactPage(body, product), body, status: response.status };
  }
}
