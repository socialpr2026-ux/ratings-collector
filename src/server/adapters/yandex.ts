import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { aliasesForBrand, matchesBrand, normalizeRating } from "../utils/normalize.js";
import { readTextBounded } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { extractPageProductEvidence } from "../utils/product-evidence.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DEFAULT_SITEMAP_INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const REVIEWS_ORIGIN = "https://reviews.yandex.ru";
const MODEL_SITEMAP_PATH = /^\/ugcpub\/sitemap_model_\d+-\d+-\d+\.xml$/i;
const MODEL_ID_AT_END = /--(\d+)(?:[/?#]|$)/;

type JsonObject = Record<string, unknown>;

type Cached<T> = {
  expiresAt: number;
  value: Promise<T>;
};

type BrandDiscovery = {
  brand: string;
  refs: Map<string, ProductRef>;
};

export type YandexAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  sitemapIndexUrl?: string;
  /** Maximum number of model sitemap documents inspected during one discovery. */
  maxSitemaps?: number;
  /** Maximum number of matched cards returned for one brand. */
  maxCandidates?: number;
  /** Maximum accepted uncompressed size of one sitemap or product page. */
  maxDocumentBytes?: number;
  sitemapConcurrency?: number;
  cacheTtlMs?: number;
  sitemapRetryAttempts?: number;
  sitemapRetryBaseMs?: number;
  sitemapReadTimeoutMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

const CYRILLIC_TO_YANDEX_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "iu",
  я: "ia"
};

/**
 * Adapter for Yandex Reviews product pages. Yandex Market seller offers are not
 * used as row identities: one Reviews modelId is one collected product card.
 */
export class YandexAdapter implements SiteAdapter {
  readonly id = "yandex";
  readonly supportedDomains = ["market.yandex.ru", "reviews.yandex.ru"] as const;

  private readonly fallbackFetch: typeof globalThis.fetch;
  private readonly sitemapIndexUrl: string;
  private readonly maxSitemaps: number;
  private readonly maxCandidates: number;
  private readonly maxDocumentBytes: number;
  private readonly sitemapConcurrency: number;
  private readonly cacheTtlMs: number;
  private readonly sitemapRetryAttempts: number;
  private readonly sitemapRetryBaseMs: number;
  private readonly sitemapReadTimeoutMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private indexCache?: Cached<string[]>;
  /**
   * One Yandex run asks for every brand concurrently. Coalesce those calls into
   * one exhaustive sitemap pass and keep only the small matched-ref index.
   * Raw multi-megabyte sitemap XML is deliberately never cached here.
   */
  private readonly discoveryBatches = new Map<string, Promise<Map<string, ProductRef[]>>>();

  constructor(options: YandexAdapterOptions = {}) {
    this.fallbackFetch = options.fetch ?? globalThis.fetch;
    this.sitemapIndexUrl = options.sitemapIndexUrl ?? DEFAULT_SITEMAP_INDEX;
    // The live index currently contains 319 model maps. The hard ceiling keeps
    // drift bounded while the default still scans the complete current index.
    this.maxSitemaps = boundedInteger(options.maxSitemaps, 400, 1, 400);
    this.maxCandidates = boundedInteger(options.maxCandidates, 300, 1, 2_000);
    this.maxDocumentBytes = boundedInteger(options.maxDocumentBytes, 12_000_000, 10_000, 25_000_000);
    this.sitemapConcurrency = boundedInteger(options.sitemapConcurrency, 6, 1, 12);
    this.cacheTtlMs = boundedInteger(options.cacheTtlMs, 30 * 60_000, 0, 24 * 60 * 60_000);
    this.sitemapRetryAttempts = boundedInteger(options.sitemapRetryAttempts, 3, 1, 5);
    this.sitemapRetryBaseMs = boundedInteger(options.sitemapRetryBaseMs, 250, 0, 10_000);
    this.sitemapReadTimeoutMs = boundedInteger(options.sitemapReadTimeoutMs, 20_000, 1, 120_000);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = this.now().toISOString();
    try {
      const sitemaps = await this.loadSitemapIndex(context);
      if (sitemaps.length === 0) {
        return { ok: false, checkedAt, message: "Yandex sitemap index contains no model sitemaps" };
      }
      return {
        ok: true,
        checkedAt,
        message: `Yandex Reviews sitemap index is available (${sitemaps.length} model maps)`
      };
    } catch (error) {
      return {
        ok: false,
        checkedAt,
        message: errorMessage(error)
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map<string, ProductRef>();

    for (const listingId of previousModelIds(context.previousIds ?? [])) {
      refs.set(listingId, productRefFromPreviousId(listingId, brand));
    }

    const brands = uniqueDiscoveryBrands(brand, context.brands ?? []);
    const batchKey = discoveryBatchKey(context.runId, brands);
    const discoveredByBrand = batchKey
      ? await this.loadDiscoveryBatch(batchKey, brands, context)
      : await this.scanDiscoveryBatch(brands, context);
    for (const ref of discoveredByBrand.get(brandKey(brand)) ?? []) {
      refs.set(ref.listingId, ref);
    }

    if (refs.size > this.maxCandidates) {
      throw new AdapterBlockedError(
        `Yandex discovery for ${brand} found more than ${this.maxCandidates} distinct models`
      );
    }

    return [...refs.values()]
      .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ru") || compareIds(a.listingId, b.listingId));
  }

  private async loadDiscoveryBatch(
    key: string,
    brands: string[],
    context: AdapterContext
  ): Promise<Map<string, ProductRef[]>> {
    const cached = this.discoveryBatches.get(key);
    if (cached) return cached;

    const value = this.scanDiscoveryBatch(brands, context);
    this.discoveryBatches.set(key, value);
    // Agent isolates may occasionally be reused. A handful of tiny matched-ref
    // indexes is enough for overlapping requests; never grow an unbounded cache.
    while (this.discoveryBatches.size > 4) {
      const oldest = this.discoveryBatches.keys().next().value as string | undefined;
      if (!oldest || oldest === key) break;
      this.discoveryBatches.delete(oldest);
    }
    value.catch(() => {
      // An unreadable shard invalidates exhaustiveness. Do not make that
      // transient failure sticky: a selective retry must perform a fresh pass.
      if (this.discoveryBatches.get(key) === value) this.discoveryBatches.delete(key);
    });
    return value;
  }

  private async scanDiscoveryBatch(
    brands: string[],
    context: AdapterContext
  ): Promise<Map<string, ProductRef[]>> {
    const sitemapUrls = await this.loadSitemapIndex(context);
    if (sitemapUrls.length > this.maxSitemaps) {
      throw new AdapterBlockedError(
        `Yandex sitemap index contains ${sitemapUrls.length} model maps, above the complete-scan limit ${this.maxSitemaps}`
      );
    }
    const selected = prioritizeSitemaps(sitemapUrls, context.previousIds ?? []);
    const discoveries = new Map<string, BrandDiscovery>(brands.map((candidate) => [
      brandKey(candidate),
      { brand: candidate, refs: new Map() }
    ]));
    await mapWithConcurrency(
      selected,
      this.sitemapConcurrency,
      async (sitemapUrl) => {
        const xml = await this.fetchModelSitemap(sitemapUrl, context);
        // Parse each large document once for the complete run brand set. `xml`
        // and its loc array become unreachable when this worker iteration ends.
        for (const url of parseXmlLocs(xml)) {
          if (!isAllowedProductUrl(url)) continue;
          const listingId = extractModelId(url);
          if (!listingId) continue;
          for (const discovery of discoveries.values()) {
            if (!urlMatchesBrand(url, discovery.brand)) continue;
            discovery.refs.set(listingId, productRefFromSitemap(listingId, url, discovery.brand, sitemapUrl));
            if (discovery.refs.size > this.maxCandidates) {
              throw new AdapterBlockedError(
                `Yandex discovery for ${discovery.brand} found more than ${this.maxCandidates} distinct models`
              );
            }
          }
        }
      }
    );

    return new Map([...discoveries].map(([key, discovery]) => [
      key,
      [...discovery.refs.values()].sort((a, b) =>
        (a.title ?? "").localeCompare(b.title ?? "", "ru") || compareIds(a.listingId, b.listingId)
      )
    ]));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = normalizeListingId(ref.listingId) ?? extractModelId(ref.url);
    if (!listingId) throw new ParserChangedError(`Invalid Yandex modelId: ${ref.listingId}`);

    let requestUrl = reviewsUrlForRef(ref.url, listingId);
    const numericUrl = `${REVIEWS_ORIGIN}/product/${listingId}`;
    let triedNumericRoute = requestUrl === numericUrl;
    let response: Response;
    const requestNumericRoute = async (): Promise<Response> => {
      requestUrl = numericUrl;
      triedNumericRoute = true;
      return this.request(requestUrl, context, "text/html,application/xhtml+xml");
    };
    try {
      response = await this.request(requestUrl, context, "text/html,application/xhtml+xml");
    } catch (error) {
      if (!(error instanceof AdapterBlockedError)) throw error;
      // Some model--ID routes reset connections for removed products. The
      // same-origin numeric route either redirects to the canonical product
      // or renders Yandex's explicit missing-page screen.
      response = await requestNumericRoute();
    }
    if (response.status === 404 || response.status === 410) {
      // A model--ID route can disappear while the fixed numeric route still
      // resolves a live model. Only the second independent route may prove a
      // newly discovered actor candidate stale.
      if (!triedNumericRoute) response = await requestNumericRoute();
      if (response.status === 404 || response.status === 410) {
        return this.emptyObservation(
          ref,
          listingId,
          requestUrl,
          "not_found",
          "yandex_reviews_missing_candidate"
        );
      }
    }
    assertUsableResponse(response, requestUrl);
    const html = await readBoundedBody(response, this.maxDocumentBytes, requestUrl);
    if (looksBlocked(html)) throw new AdapterBlockedError(`Yandex blocked product request for model ${listingId}`);
    if (looksMissingProduct(html)) {
      return this.emptyObservation(
        ref,
        listingId,
        requestUrl,
        "not_found",
        "yandex_reviews_missing_candidate"
      );
    }

    const products = extractJsonLdProducts(html);
    if (products.length === 0) {
      throw new ParserChangedError(`Yandex model ${listingId} has no JSON-LD Product`);
    }
    const product = products.find((candidate) => isObject(candidate.aggregateRating)) ?? products[0];
    const title = nonEmptyString(product.name);
    if (!title) throw new ParserChangedError(`Yandex model ${listingId} JSON-LD Product has no name`);

    const canonicalUrl = extractAndValidateCanonical(html, response.url || requestUrl, listingId);
    const description = nonEmptyString(product.description);
    const productEvidence = extractPageProductEvidence(html, canonicalUrl, ref.brand, {
      structuredSignals: [title, description].filter((value): value is string => Boolean(value))
    });
    productEvidence.identifiers.push({ type: "model_id", value: listingId });
    const aggregate = isObject(product.aggregateRating) ? product.aggregateRating : undefined;
    const structuredBrandNames = extractBrandNames(product);
    const brandMatches =
      structuredBrandNames.some((candidate) => matchesBrand(candidate, ref.brand)) || matchesBrand(title, ref.brand);

    if (!aggregate) {
      return {
        domain: "market.yandex.ru",
        platform: this.id,
        listingId,
        brand: ref.brand,
        canonicalUrl,
        product: title,
        reviews: 0,
        rating: null,
        ratingCount: null,
        status: brandMatches ? "no_reviews" : "needs_review",
        capturedAt: this.now().toISOString(),
        evidenceRef: `${canonicalUrl}#json-ld`,
        productEvidence,
        source: "yandex_reviews_json_ld"
      };
    }

    const reviews = parseNonNegativeInteger(aggregate.reviewCount);
    if (reviews === undefined) {
      throw new ParserChangedError(
        `Yandex model ${listingId} AggregateRating has no valid reviewCount; ratingCount is not a substitute`
      );
    }
    const ratingCount = optionalNonNegativeInteger(aggregate.ratingCount, listingId, "ratingCount");
    const rawRating = optionalFiniteNumber(aggregate.ratingValue, listingId, "ratingValue");
    const rawScale = optionalFiniteNumber(aggregate.bestRating, listingId, "bestRating") ?? 5;
    if (rawScale <= 0) throw new ParserChangedError(`Yandex model ${listingId} has an invalid bestRating`);
    if (reviews > 0 && rawRating === undefined) {
      throw new ParserChangedError(`Yandex model ${listingId} has reviews but no valid ratingValue`);
    }
    if (rawRating !== undefined && (rawRating < 0 || rawRating > rawScale)) {
      throw new ParserChangedError(`Yandex model ${listingId} ratingValue is outside its declared scale`);
    }

    return {
      domain: "market.yandex.ru",
      platform: this.id,
      listingId,
      brand: ref.brand,
      canonicalUrl,
      product: title,
      reviews,
      // Yandex may expose a default ratingValue on a card with no written
      // reviews. It is useful as raw evidence, but is not a product rating and
      // must remain empty in the sheet-facing metric contract.
      rating: reviews === 0 || rawRating === undefined ? null : normalizeRating(rawRating, rawScale),
      rawRating: rawRating ?? null,
      rawRatingScale: rawScale,
      ratingCount,
      status: brandMatches ? (reviews === 0 ? "no_reviews" : "ok") : "needs_review",
      capturedAt: this.now().toISOString(),
      evidenceRef: `${canonicalUrl}#json-ld`,
      productEvidence,
      source: "yandex_reviews_json_ld"
    };
  }

  private emptyObservation(
    ref: ProductRef,
    listingId: string,
    canonicalUrl: string,
    status: "not_found",
    source = "yandex_reviews"
  ): Observation {
    return {
      domain: "market.yandex.ru",
      platform: this.id,
      listingId,
      brand: ref.brand,
      canonicalUrl: canonicalizeUrl(canonicalUrl),
      product: ref.title?.trim() || ref.brand,
      reviews: null,
      rating: null,
      status,
      capturedAt: this.now().toISOString(),
      source
    };
  }

  private async loadSitemapIndex(context: AdapterContext): Promise<string[]> {
    if (this.indexCache && this.indexCache.expiresAt >= Date.now()) return this.indexCache.value;

    const value = this.fetchSitemapIndex(context);
    this.indexCache = { expiresAt: Date.now() + this.cacheTtlMs, value };
    value.catch(() => {
      if (this.indexCache?.value === value) this.indexCache = undefined;
    });
    return value;
  }

  private async fetchSitemapIndex(context: AdapterContext): Promise<string[]> {
    const xml = await this.fetchSitemapDocument(this.sitemapIndexUrl, context, "index");
    if (looksBlocked(xml)) throw new AdapterBlockedError("Yandex blocked sitemap index access");
    if (!/<sitemapindex\b/i.test(xml)) throw new ParserChangedError("Yandex sitemap index XML shape changed");

    const modelMaps = parseXmlLocs(xml).filter(isAllowedModelSitemap);
    if (modelMaps.length === 0) throw new ParserChangedError("Yandex sitemap index contains no valid model maps");
    return [...new Set(modelMaps)];
  }

  private async fetchModelSitemap(url: string, context: AdapterContext): Promise<string> {
    if (!isAllowedModelSitemap(url)) throw new ParserChangedError("Unsafe model sitemap URL in Yandex index");
    const xml = await this.fetchSitemapDocument(url, context, "model");
    if (looksBlocked(xml)) throw new AdapterBlockedError(`Yandex blocked model sitemap ${url}`);
    if (!/<urlset\b/i.test(xml)) throw new ParserChangedError(`Yandex model sitemap XML shape changed: ${url}`);
    return xml;
  }

  private async fetchSitemapDocument(
    url: string,
    context: AdapterContext,
    kind: "index" | "model"
  ): Promise<string> {
    let lastTransient: unknown;
    for (let attempt = 1; attempt <= this.sitemapRetryAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.request(url, context, "application/xml,text/xml");
      } catch (error) {
        if (context.signal?.aborted) throw error;
        lastTransient = error;
        if (attempt < this.sitemapRetryAttempts) {
          await this.waitBeforeSitemapRetry(attempt, context);
          continue;
        }
        throw error;
      }

      if (kind === "model" && response.status === 404) {
        void response.body?.cancel().catch(() => undefined);
        return "<?xml version=\"1.0\"?><urlset></urlset>";
      }
      if (response.status >= 500 && response.status <= 599) {
        lastTransient = new AdapterBlockedError(`Yandex is unavailable for ${url}: HTTP ${response.status}`);
        void response.body?.cancel().catch(() => undefined);
        if (attempt < this.sitemapRetryAttempts) {
          await this.waitBeforeSitemapRetry(attempt, context);
          continue;
        }
        throw lastTransient;
      }

      // A successful but malformed sitemap is structural drift. It must not
      // be hidden by retries or converted into an empty discovery result.
      assertUsableResponse(response, url);
      try {
        const xml = await readBoundedBody(
          response,
          this.maxDocumentBytes,
          url,
          this.sitemapReadTimeoutMs
        );
        if (looksBlocked(xml)) {
          throw new AdapterBlockedError(`Yandex blocked ${kind === "index" ? "sitemap index access" : `model sitemap ${url}`}`);
        }
        const expectedRoot = kind === "index" ? /<sitemapindex\b/i : /<urlset\b/i;
        const expectedClose = kind === "index" ? /<\/sitemapindex\s*>/i : /<\/urlset\s*>/i;
        if (!expectedRoot.test(xml) || !expectedClose.test(xml)) {
          throw new ParserChangedError(
            kind === "index"
              ? "Yandex sitemap index XML shape changed"
              : `Yandex model sitemap XML shape changed: ${url}`
          );
        }
        return xml;
      } catch (error) {
        if (error instanceof ParserChangedError || context.signal?.aborted) throw error;
        lastTransient = error;
        if (attempt < this.sitemapRetryAttempts) {
          await this.waitBeforeSitemapRetry(attempt, context);
          continue;
        }
      }
    }
    throw new AdapterBlockedError(
      `Yandex sitemap remained unreadable after ${this.sitemapRetryAttempts} attempts for ${url}: ${errorMessage(lastTransient)}`
    );
  }

  private async waitBeforeSitemapRetry(attempt: number, context: AdapterContext): Promise<void> {
    if (this.sitemapRetryBaseMs > 0) {
      await this.sleep(Math.min(10_000, this.sitemapRetryBaseMs * 3 ** (attempt - 1)));
    }
    context.signal?.throwIfAborted();
  }

  private async request(url: string, context: AdapterContext, accept: string): Promise<Response> {
    const fetcher = context.fetch ?? this.fallbackFetch;
    if (typeof fetcher !== "function") throw new AdapterBlockedError("No fetch implementation is available");
    try {
      return await fetcher(url, {
        method: "GET",
        redirect: "follow",
        signal: context.signal,
        headers: {
          accept,
          "accept-language": "ru-RU,ru;q=0.9",
          "user-agent": "RatingsCollector/1.0 (+https://reviews.yandex.ru/robots.txt)"
        }
      });
    } catch (error) {
      if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) throw error;
      if (context.signal?.aborted) throw error;
      throw new AdapterBlockedError(`Yandex request failed for ${url}: ${errorMessage(error)}`);
    }
  }
}

export default YandexAdapter;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Expected an integer between ${min} and ${max}`);
  }
  return value;
}

function assertUsableResponse(response: Response, url: string): void {
  if ([401, 403, 407, 423, 429, 451, 503].includes(response.status)) {
    throw new AdapterBlockedError(`Yandex blocked ${url} with HTTP ${response.status}`);
  }
  if (!response.ok) {
    if (response.status >= 500) throw new AdapterBlockedError(`Yandex is unavailable for ${url}: HTTP ${response.status}`);
    throw new ParserChangedError(`Unexpected HTTP ${response.status} from ${url}`);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  url: string,
  timeoutMs?: number
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ParserChangedError(`Yandex response exceeds the ${maxBytes}-byte safety limit: ${url}`);
  }
  try {
    return await readTextBounded(response, maxBytes, timeoutMs);
  } catch (error) {
    if ((error as Error).message.includes("превышает лимит")) {
      throw new ParserChangedError(`Yandex response exceeds the ${maxBytes}-byte safety limit: ${url}`);
    }
    throw error;
  }
}

function looksBlocked(body: string): boolean {
  return (
    /<title[^>]*>\s*(?:ой[!.]?|access denied|доступ (?:ограничен|запрещен)|вы робот)/i.test(body) ||
    /(?:smart-captcha|checkboxcaptcha|showcaptcha|captcha-container)/i.test(body)
  );
}

function looksMissingProduct(body: string): boolean {
  return /(?:такой страницы нет|страница не найдена|page not found)/i.test(body);
}

function parseXmlLocs(xml: string): string[] {
  const locs: string[] = [];
  const pattern = /<loc\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/gi;
  for (const match of xml.matchAll(pattern)) {
    const value = decodeXmlEntities((match[1] ?? match[2] ?? "").trim());
    if (value) locs.push(value);
  }
  return locs;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function isAllowedModelSitemap(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.hostname === "reviews.yandex.ru" && MODEL_SITEMAP_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function isAllowedProductUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      url.hostname === "reviews.yandex.ru" &&
      url.pathname.startsWith("/product/") &&
      extractModelId(input) !== undefined
    );
  } catch {
    return false;
  }
}

function extractModelId(input: string): string | undefined {
  return input.match(MODEL_ID_AT_END)?.[1];
}

function normalizeListingId(input: string): string | undefined {
  return input.match(/^(?:yandex:)?(\d+)$/i)?.[1];
}

function previousModelIds(previousIds: string[]): string[] {
  const result: string[] = [];
  for (const value of previousIds) {
    const id = normalizeListingId(value) ?? extractModelId(value);
    if (id) result.push(id);
  }
  return [...new Set(result)];
}

function productRefFromPreviousId(listingId: string, brand: string): ProductRef {
  return {
    domain: "market.yandex.ru",
    platform: "yandex",
    listingId,
    brand,
    url: `${REVIEWS_ORIGIN}/product/model--${listingId}`,
    metadata: { discovery: "previous_registry" }
  };
}

function productRefFromSitemap(
  listingId: string,
  url: string,
  brand: string,
  sitemapUrl: string
): ProductRef {
  return {
    domain: "market.yandex.ru",
    platform: "yandex",
    listingId,
    brand,
    url: canonicalizeUrl(url),
    title: titleFromProductUrl(url),
    metadata: {
      discovery: "reviews_sitemap",
      sourceSitemap: sitemapUrl
    }
  };
}

function brandKey(brand: string): string {
  return brand
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueDiscoveryBrands(requested: string, all: readonly string[]): string[] {
  const result = new Map<string, string>();
  for (const brand of [requested, ...all]) {
    const key = brandKey(brand);
    if (key && !result.has(key)) result.set(key, brand.trim());
  }
  return [...result.values()];
}

function discoveryBatchKey(runId: string | undefined, brands: readonly string[]): string | undefined {
  const scope = runId?.trim();
  if (!scope) return undefined;
  return `${scope}\u001e${brands.map(brandKey).sort().join("\u001f")}`;
}

function prioritizeSitemaps(sitemaps: string[], previousIds: string[]): string[] {
  const ids = previousModelIds(previousIds).map(Number).filter(Number.isSafeInteger);
  if (ids.length === 0) return sitemaps;

  return sitemaps
    .map((url, index) => ({ url, index, priority: sitemapContainsAnyId(url, ids) ? 0 : 1 }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ url }) => url);
}

function sitemapContainsAnyId(url: string, ids: number[]): boolean {
  const range = url.match(/sitemap_model_(\d+)-(\d+)-\d+\.xml/i);
  if (!range) return false;
  const min = Number(range[1]);
  const max = Number(range[2]);
  return ids.some((id) => id >= min && id <= max);
}

function urlMatchesBrand(input: string, brand: string): boolean {
  const slug = normalizedSlug(input);
  if (!slug) return false;

  return aliasesForBrand(brand).some((alias) => {
    const normalizedAlias = normalizeForSlug(alias);
    const transliteratedAlias = normalizeForSlug(transliterateForYandex(alias));
    return [normalizedAlias, transliteratedAlias]
      .filter(Boolean)
      .some((candidate) => ` ${slug} `.includes(` ${candidate} `));
  });
}

function normalizedSlug(input: string): string {
  try {
    const part = decodeURIComponent(new URL(input).pathname.split("/").filter(Boolean).at(-1) ?? "");
    return normalizeForSlug(part.replace(MODEL_ID_AT_END, ""));
  } catch {
    return "";
  }
}

function normalizeForSlug(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transliterateForYandex(value: string): string {
  return [...value.toLocaleLowerCase("ru-RU")]
    .map((character) => CYRILLIC_TO_YANDEX_LATIN[character] ?? character)
    .join("");
}

function titleFromProductUrl(input: string): string | undefined {
  try {
    const slug = decodeURIComponent(new URL(input).pathname.split("/").filter(Boolean).at(-1) ?? "").replace(
      MODEL_ID_AT_END,
      ""
    );
    return slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

function reviewsUrlForRef(input: string, listingId: string): string {
  try {
    const url = new URL(input);
    if (url.protocol === "https:" && url.hostname === "reviews.yandex.ru" && extractModelId(input) === listingId) {
      return canonicalizeUrl(input);
    }
  } catch {
    // A fixed Reviews URL is used below; arbitrary ref URLs are never fetched.
  }
  return `${REVIEWS_ORIGIN}/product/model--${listingId}`;
}

function extractJsonLdProducts(html: string): JsonObject[] {
  const products: JsonObject[] = [];
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of scripts) {
    try {
      const root: unknown = JSON.parse(match[1].trim());
      visitJson(root, (candidate) => {
        if (hasType(candidate, "Product")) products.push(candidate);
      });
    } catch {
      // A page may include unrelated malformed JSON-LD. A valid Product is still accepted.
    }
  }
  return products;
}

function visitJson(root: unknown, visitor: (value: JsonObject) => void): void {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < 20_000) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
    } else if (isObject(value)) {
      visitor(value);
      queue.push(...Object.values(value));
    }
  }
}

function hasType(value: JsonObject, expected: string): boolean {
  const type = value["@type"];
  return Array.isArray(type)
    ? type.some((item) => typeof item === "string" && item.toLowerCase() === expected.toLowerCase())
    : typeof type === "string" && type.toLowerCase() === expected.toLowerCase();
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractBrandNames(product: JsonObject): string[] {
  const names: string[] = [];
  for (const value of [product.brand, product.manufacturer]) collectNames(value, names);
  return [...new Set(names)];
}

function collectNames(value: unknown, names: string[]): void {
  if (typeof value === "string" && value.trim()) names.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => collectNames(item, names));
  else if (isObject(value)) {
    const name = nonEmptyString(value.name);
    if (name) names.push(name);
  }
}

function extractAndValidateCanonical(html: string, responseUrl: string, listingId: string): string {
  let candidate: string | undefined;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = htmlAttribute(tag, "rel");
    if (rel?.split(/\s+/).some((token) => token.toLowerCase() === "canonical")) {
      candidate = htmlAttribute(tag, "href");
      if (candidate) break;
    }
  }
  candidate ??= responseUrl;

  let url: URL;
  try {
    url = new URL(candidate, REVIEWS_ORIGIN);
  } catch {
    throw new ParserChangedError(`Yandex model ${listingId} has an invalid canonical URL`);
  }
  if (url.protocol !== "https:" || url.hostname !== "reviews.yandex.ru" || extractModelId(url.toString()) !== listingId) {
    throw new ParserChangedError(`Yandex model ${listingId} canonical URL does not identify the requested model`);
  }
  return canonicalizeUrl(url.toString());
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "") || undefined;
}

function decodeHtmlEntities(value: string): string {
  return decodeXmlEntities(value).replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)));
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u00a0\u202f\s]/g, "").replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalNonNegativeInteger(value: unknown, listingId: string, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = parseNonNegativeInteger(value);
  if (parsed === undefined) throw new ParserChangedError(`Yandex model ${listingId} has an invalid ${field}`);
  return parsed;
}

function optionalFiniteNumber(value: unknown, listingId: string, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = parseFiniteNumber(value);
  if (parsed === undefined) throw new ParserChangedError(`Yandex model ${listingId} has an invalid ${field}`);
  return parsed;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length && failure === undefined) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(values[index]);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
