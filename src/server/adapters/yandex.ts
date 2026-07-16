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
import { extractPageProductEvidence, titleProvesProductVariant } from "../utils/product-evidence.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DEFAULT_SITEMAP_INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const REVIEWS_ORIGIN = "https://reviews.yandex.ru";
const TRANSLATE_ORIGIN = "https://reviews-yandex-ru.translate.goog";
const DIRECT_SOURCE = "yandex_reviews_json_ld";
const TRANSLATE_SOURCE = "yandex_reviews_json_ld_google_translate";
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
  error?: AdapterBlockedError;
};

type DiscoveryBatch = Map<string, ProductRef[] | AdapterBlockedError>;

type ProductPage =
  | { kind: "missing"; requestUrl: string }
  | {
      kind: "html";
      html: string;
      responseUrl: string;
      translated: boolean;
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
  /** Whole discovery deadline. A partial sitemap scan is rejected, never returned as no results. */
  discoveryTimeoutMs?: number;
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
  private readonly discoveryTimeoutMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private indexCache?: Cached<string[]>;
  /**
   * One Yandex run asks for every brand concurrently. Coalesce those calls into
   * one exhaustive sitemap pass and keep only the small matched-ref index.
   * Raw multi-megabyte sitemap XML is deliberately never cached here.
   */
  private readonly discoveryBatches = new Map<string, Promise<DiscoveryBatch>>();

  constructor(options: YandexAdapterOptions = {}) {
    this.fallbackFetch = options.fetch ?? globalThis.fetch;
    this.sitemapIndexUrl = options.sitemapIndexUrl ?? DEFAULT_SITEMAP_INDEX;
    // The live index currently contains 319 model maps. The hard ceiling keeps
    // drift bounded while the default still scans the complete current index.
    this.maxSitemaps = boundedInteger(options.maxSitemaps, 400, 1, 400);
    this.maxCandidates = boundedInteger(options.maxCandidates, 300, 1, 2_000);
    this.maxDocumentBytes = boundedInteger(options.maxDocumentBytes, 12_000_000, 10_000, 25_000_000);
    // The live index contains hundreds of independent shards. Twelve bounded
    // workers finish the exhaustive pass within the run deadline without ever
    // treating an unfinished pass as an empty result.
    this.sitemapConcurrency = boundedInteger(options.sitemapConcurrency, 12, 1, 12);
    this.cacheTtlMs = boundedInteger(options.cacheTtlMs, 30 * 60_000, 0, 24 * 60 * 60_000);
    this.sitemapRetryAttempts = boundedInteger(options.sitemapRetryAttempts, 3, 1, 5);
    this.sitemapRetryBaseMs = boundedInteger(options.sitemapRetryBaseMs, 250, 0, 10_000);
    // The fixed EdgeOne route validates and compacts complete multi-megabyte
    // shards before handing them to the adapter. On a cold function the
    // verified transfer can legitimately take more than 20 seconds; keep the
    // safety deadline, but do not misclassify a healthy shard as blocked.
    this.sitemapReadTimeoutMs = boundedInteger(options.sitemapReadTimeoutMs, 60_000, 1, 120_000);
    this.discoveryTimeoutMs = boundedInteger(options.discoveryTimeoutMs, 90_000, 1, 300_000);
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
    const discovered = discoveredByBrand.get(brandKey(brand));
    if (discovered instanceof AdapterBlockedError) throw discovered;
    for (const ref of discovered ?? []) {
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
  ): Promise<DiscoveryBatch> {
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
  ): Promise<DiscoveryBatch> {
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.discoveryTimeoutMs);
    const relayAbort = () => deadline.abort(context.signal?.reason);
    if (context.signal?.aborted) relayAbort();
    else context.signal?.addEventListener("abort", relayAbort, { once: true });
    const boundedContext = { ...context, signal: deadline.signal };
    try {
      return await this.scanDiscoveryBatchWithinDeadline(brands, boundedContext);
    } catch (error) {
      if (timedOut) {
        throw new AdapterBlockedError(
          `Yandex discovery exceeded ${this.discoveryTimeoutMs}ms; partial sitemap matches were discarded`
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", relayAbort);
    }
  }

  private async scanDiscoveryBatchWithinDeadline(
    brands: string[],
    context: AdapterContext
  ): Promise<DiscoveryBatch> {
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
            if (discovery.error) continue;
            if (!urlMatchesBrand(url, discovery.brand)) continue;
            discovery.refs.set(listingId, productRefFromSitemap(listingId, url, discovery.brand, sitemapUrl));
            if (discovery.refs.size > this.maxCandidates) {
              discovery.error = new AdapterBlockedError(
                `Yandex discovery for ${discovery.brand} found more than ${this.maxCandidates} distinct models`
              );
              discovery.refs.clear();
            }
          }
        }
      }
    );

    return new Map([...discoveries].map(([key, discovery]) => [
      key,
      discovery.error ?? [...discovery.refs.values()].sort((a, b) =>
        (a.title ?? "").localeCompare(b.title ?? "", "ru") || compareIds(a.listingId, b.listingId)
      )
    ]));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = normalizeListingId(ref.listingId) ?? extractModelId(ref.url);
    if (!listingId) throw new ParserChangedError(`Invalid Yandex modelId: ${ref.listingId}`);

    let page: ProductPage;
    try {
      page = await this.loadDirectProductPage(ref, listingId, context);
    } catch (error) {
      if (!(error instanceof AdapterBlockedError)) throw error;
      try {
        // The fixed Google Translate renderer returns the source page's SSR
        // HTML without running a browser and is reachable from cloud egress
        // ranges that Yandex sometimes challenges. The source is accepted
        // only after exact numeric-route, canonical and modelId checks below.
        page = await this.loadTranslatedProductPage(listingId, context);
      } catch (translatedError) {
        if (!(translatedError instanceof AdapterBlockedError)) throw translatedError;
        throw new AdapterBlockedError(
          `Yandex product ${listingId} is unavailable through direct and translated collectors: ` +
          `${errorMessage(error)}; ${errorMessage(translatedError)}`
        );
      }
    }

    if (page.kind === "missing") {
      return this.emptyObservation(
        ref,
        listingId,
        page.requestUrl,
        "not_found",
        "yandex_reviews_missing_candidate"
      );
    }

    const { html } = page;
    if (looksMissingProduct(html)) {
      return this.emptyObservation(
        ref,
        listingId,
        page.responseUrl,
        "not_found",
        "yandex_reviews_missing_candidate"
      );
    }

    const products = extractJsonLdProducts(html);
    if (products.length === 0) {
      throw new ParserChangedError(`Yandex model ${listingId} has no JSON-LD Product`);
    }
    const canonicalUrl = extractAndValidateCanonical(html, page.responseUrl, listingId);
    if (!canonicalUrl) {
      // A removed/redirected sitemap candidate may still render an aggregate,
      // but without a canonical URL that binds it to the requested model those
      // numbers are not publishable. Reuse the proven missing-candidate path so
      // one stale model does not block every other current Yandex card.
      return this.emptyObservation(
        ref,
        listingId,
        page.responseUrl,
        "not_found",
        "yandex_reviews_missing_candidate"
      );
    }
    const product = selectJsonLdProduct(products, listingId);
    const title = nonEmptyString(product.name);
    if (!title) throw new ParserChangedError(`Yandex model ${listingId} JSON-LD Product has no name`);

    const description = nonEmptyString(product.description);
    const reviewedProductTitles = extractReviewedProductTitles(html, ref.brand)
      .filter((reviewedTitle) => reviewedVariantMatchesModelForm(title, reviewedTitle));
    // When no individual review exposes its bought variant, the canonical
    // JSON-LD Product name is still first-party evidence for the model-level
    // aggregate. If that name does not prove a complete sellable variant,
    // represent it honestly as the model family instead of asking an employee
    // to invent a dosage or pack.
    const modelTitleIsFamily = matchesBrand(title, ref.brand) && !titleProvesProductVariant(title, ref.brand);
    const expandedModelTitle = expandYandexProductTitle(title);
    const sourceBoundFamilyTitles = reviewedProductTitles.length > 0
      ? reviewedProductTitles
      : modelTitleIsFamily
        ? [expandedModelTitle]
        : [];
    const productEvidence = extractPageProductEvidence(html, canonicalUrl, ref.brand, {
      // Yandex's page-level Product name is sometimes abbreviated to the
      // dosage form (for example, "Хондрофен мазь д/нар.прим.").  The
      // source-bound `reasonToTrust` field identifies the exact item bought by
      // each reviewer and is not review prose.  It belongs to the model's
      // variant set, though: two slightly different pharmacy spellings must
      // not become two unrelated products, while genuinely different packs
      // must remain visible under the one model-level aggregate rating.
      forceFamily: sourceBoundFamilyTitles.length > 0,
      extraVariants: sourceBoundFamilyTitles,
      structuredSignals: [title, description]
        .filter((value): value is string => Boolean(value))
    });
    if (modelTitleIsFamily && reviewedProductTitles.length === 0 && !productEvidence.variants.includes(expandedModelTitle)) {
      // `extractPageProductEvidence` deliberately accepts only common retail
      // spellings as variants. Yandex also abbreviates dosage forms (for
      // example "р-р д/вн. приема"). The source-bound JSON-LD name is safe to
      // retain even when that generic filter does not recognize the spelling.
      productEvidence.variants.unshift(expandedModelTitle);
    }
    productEvidence.identifiers.push({ type: "model_id", value: listingId });
    const aggregate = isObject(product.aggregateRating) ? product.aggregateRating : undefined;
    const structuredBrandNames = extractBrandNames(product);
    const brandMatches =
      structuredBrandNames.some((candidate) => matchesBrand(candidate, ref.brand)) || matchesBrand(title, ref.brand);

    if (!aggregate) {
      if (page.translated && !hasExplicitZeroReviewProof(html, product)) {
        throw new ParserChangedError(
          `Yandex translated model ${listingId} has no AggregateRating or explicit zero-review proof`
        );
      }
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
        source: page.translated ? TRANSLATE_SOURCE : DIRECT_SOURCE
      };
    }

    const reviews = parseNonNegativeInteger(aggregate.reviewCount);
    const ratingCount = optionalNonNegativeInteger(aggregate.ratingCount, listingId, "ratingCount");
    const feedbackCount = Math.max(...[reviews, ratingCount].filter((value): value is number => value !== undefined));
    if (!Number.isFinite(feedbackCount)) {
      throw new ParserChangedError(
        `Yandex model ${listingId} AggregateRating has no valid reviewCount or ratingCount`
      );
    }
    const rawRating = optionalFiniteNumber(aggregate.ratingValue, listingId, "ratingValue");
    const rawScale = optionalFiniteNumber(aggregate.bestRating, listingId, "bestRating") ?? 5;
    if (rawScale <= 0) throw new ParserChangedError(`Yandex model ${listingId} has an invalid bestRating`);
    if (feedbackCount > 0 && rawRating === undefined) {
      throw new ParserChangedError(`Yandex model ${listingId} has feedback but no valid ratingValue`);
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
      reviews: reviews ?? null,
      rating: feedbackCount === 0 || rawRating === undefined ? null : normalizeRating(rawRating, rawScale),
      rawRating: rawRating ?? null,
      rawRatingScale: rawScale,
      ratingCount,
      status: brandMatches ? (feedbackCount === 0 ? "no_reviews" : "ok") : "needs_review",
      capturedAt: this.now().toISOString(),
      evidenceRef: `${canonicalUrl}#json-ld`,
      productEvidence,
      source: page.translated ? TRANSLATE_SOURCE : DIRECT_SOURCE
    };
  }

  private async loadDirectProductPage(
    ref: ProductRef,
    listingId: string,
    context: AdapterContext
  ): Promise<ProductPage> {
    let requestUrl = reviewsUrlForRef(ref.url, listingId);
    const numericUrl = `${REVIEWS_ORIGIN}/product/${listingId}`;
    let triedNumericRoute = requestUrl === numericUrl;
    const requestNumericRoute = async (): Promise<Response> => {
      requestUrl = numericUrl;
      triedNumericRoute = true;
      return this.request(requestUrl, context, "text/html,application/xhtml+xml");
    };

    let response: Response;
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
      if (!triedNumericRoute) response = await requestNumericRoute();
      if (response.status === 404 || response.status === 410) {
        return { kind: "missing", requestUrl };
      }
    }
    assertUsableResponse(response, requestUrl);
    const html = await readBoundedBody(response, this.maxDocumentBytes, requestUrl);
    if (looksBlocked(html)) throw new AdapterBlockedError(`Yandex blocked product request for model ${listingId}`);
    return {
      kind: "html",
      html,
      responseUrl: response.url || requestUrl,
      translated: false
    };
  }

  private async loadTranslatedProductPage(
    listingId: string,
    context: AdapterContext
  ): Promise<ProductPage> {
    const sourceUrl = `${REVIEWS_ORIGIN}/product/${listingId}`;
    const endpoint = new URL(`/product/${listingId}`, TRANSLATE_ORIGIN);
    endpoint.searchParams.set("_x_tr_sl", "ru");
    endpoint.searchParams.set("_x_tr_tl", "en");
    endpoint.searchParams.set("_x_tr_hl", "en");
    const response = await this.request(endpoint.toString(), context, "text/html,application/xhtml+xml");
    assertUsableResponse(response, endpoint.toString());
    const actualUrl = new URL(response.url || endpoint.toString());
    if (actualUrl.protocol !== "https:" || actualUrl.hostname !== "reviews-yandex-ru.translate.goog" ||
      actualUrl.pathname !== `/product/${listingId}`) {
      throw new ParserChangedError(`Yandex translated model ${listingId} escaped its fixed product route`);
    }
    const html = await readBoundedBody(response, this.maxDocumentBytes, endpoint.toString());
    if (looksBlocked(html)) throw new AdapterBlockedError(`Yandex blocked translated product request for model ${listingId}`);
    if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html)) {
      throw new ParserChangedError(`Yandex translated model ${listingId} returned incomplete HTML`);
    }
    assertTranslatedSource(html, sourceUrl, listingId);
    return {
      kind: "html",
      html,
      responseUrl: sourceUrl,
      translated: true
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
      if ([408, 425, 429].includes(response.status) || response.status >= 500 && response.status <= 599) {
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

function selectJsonLdProduct(products: JsonObject[], listingId: string): JsonObject {
  const identified = products.filter((product) => productIdentifiesModel(product, listingId));
  if (identified.length === 1) return identified[0];
  if (identified.length > 1) {
    throw new ParserChangedError(`Yandex model ${listingId} has multiple identifying JSON-LD Products`);
  }
  // A page-level canonical binds one sole Product to the requested model. If
  // several Products are present, aggregateRating alone is not sufficient:
  // it may belong to a recommendation or another item embedded in the page.
  if (products.length === 1) return products[0];
  throw new ParserChangedError(`Yandex model ${listingId} has ambiguous JSON-LD Products`);
}

function productIdentifiesModel(product: JsonObject, listingId: string): boolean {
  for (const value of [product.productID, product.sku, product.mpn]) {
    if ((typeof value === "string" || typeof value === "number") && String(value).trim() === listingId) return true;
  }
  for (const value of [product.url, product["@id"]]) {
    if (typeof value !== "string") continue;
    if (extractModelId(value) === listingId) return true;
    try {
      const url = new URL(value, REVIEWS_ORIGIN);
      if (url.hostname === "reviews.yandex.ru" && url.pathname === `/product/${listingId}`) return true;
    } catch {
      // Non-URL identifiers are checked by the scalar fields above.
    }
  }
  return false;
}

function hasExplicitZeroReviewProof(html: string, product: JsonObject): boolean {
  const signals: string[] = [];
  const description = nonEmptyString(product.description);
  if (description) signals.push(description);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) signals.push(decodeHtmlEntities(title.replace(/<[^>]+>/g, " ")));
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (htmlAttribute(tag, "name") ?? htmlAttribute(tag, "property") ?? "").toLowerCase();
    if (name !== "description" && name !== "og:description") continue;
    const content = htmlAttribute(tag, "content");
    if (content) signals.push(content);
  }
  return signals.some((signal) =>
    /(?:^|\s)0\s*(?:текстов(?:ых|ые)?\s+)?отзыв(?:ов|а|ы)?\b/iu.test(signal) ||
    /(?:^|\s)0\s+(?:written\s+)?reviews?\b/iu.test(signal)
  );
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

function expandYandexProductTitle(value: string): string {
  // Yandex's Product.name frequently abbreviates dosage forms. Expand only
  // literal pharmaceutical abbreviations already present in the source; this
  // makes the shared product parser understand the same meaning without
  // adding a dosage, volume or pack that the page did not prove.
  return value
    .replace(/(?<![\p{L}\p{N}])р[.\s-]*р(?=\s|$)/giu, "раствор")
    .replace(/(?<![\p{L}\p{N}])д\s*\/\s*вн\.?\s*при[её]ма(?![\p{L}\p{N}])/giu, "для приема внутрь")
    .replace(/(?<![\p{L}\p{N}])капс\.?(?![\p{L}\p{N}])/giu, "капсулы")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReviewedProductTitles(html: string, brand: string): string[] {
  const result = new Set<string>();
  const accept = (value: string | undefined): void => {
    if (!value) return;
    const compact = decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
      .normalize("NFKC")
      .replace(/[\s\u00a0\u202f]+/g, " ")
      .trim();
    const title = compact.match(/^(?:Товар|Product)\s*[—-]\s*(.+)$/iu)?.[1]?.trim();
    if (!title || title.length > 500 || !matchesBrand(title, brand)) return;
    result.add(title);
  };

  // Direct and translated SSR pages both retain this source-bound visible
  // field.  Review text is deliberately outside the selector and is never
  // considered product evidence.
  for (const match of html.matchAll(
    /<[^>]+class\s*=\s*(?:"[^"]*\bReview-ReasonToTrustText\b[^"]*"|'[^']*\bReview-ReasonToTrustText\b[^']*')[^>]*>([\s\S]*?)<\/[^>]+>/giu
  )) accept(match[1]);

  // Hydration state is a second deterministic representation of the same
  // Yandex-owned field.  Decode only the JSON string assigned to the exact
  // `reasonToTrust.text` property; arbitrary review bodies are not scanned.
  for (const match of html.matchAll(
    /"reasonToTrust"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/gu
  )) {
    try {
      accept(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // A malformed hydration fragment is ignored; the page-level Product and
      // visible source-bound fields still decide whether collection is usable.
    }
  }
  return [...result].slice(0, 30);
}

function reviewedVariantMatchesModelForm(modelTitle: string, reviewedTitle: string): boolean {
  const modelIsSachet = /(?:^|[^\p{L}])(?:саше|порошок)(?:$|[^\p{L}])/iu.test(modelTitle);
  const reviewedIsTablet = /(?:^|[^\p{L}])(?:таб(?:л(?:етки?)?)?\.?|таблетки?)(?:$|[^\p{L}])/iu.test(reviewedTitle);
  if (modelIsSachet && reviewedIsTablet) return false;

  const modelIsTablet = /(?:^|[^\p{L}])(?:таб(?:л(?:етки?)?)?\.?|таблетки?)(?:$|[^\p{L}])/iu.test(modelTitle);
  const reviewedIsSachet = /(?:^|[^\p{L}])(?:саше|порошок)(?:$|[^\p{L}])/iu.test(reviewedTitle);
  return !(modelIsTablet && reviewedIsSachet);
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

function extractAndValidateCanonical(html: string, responseUrl: string, listingId: string): string | undefined {
  let candidate: string | undefined;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = htmlAttribute(tag, "rel");
    if (rel?.split(/\s+/).some((token) => token.toLowerCase() === "canonical")) {
      candidate = htmlAttribute(tag, "href");
      if (candidate) break;
    }
  }
  candidate ??= responseUrl;

  // A small set of retired Yandex models currently returns this exact broken
  // first-party canonical shape: the requested numeric ID is concatenated to
  // the host. It proves neither a different product nor the requested model,
  // so exclude the single candidate fail-closed instead of treating the whole
  // adapter as structurally changed.
  const concatenatedModel = candidate.match(/^https:\/\/reviews\.yandex\.ru(\d+)\/?(?:[?#].*)?$/i)?.[1];
  if (concatenatedModel === listingId) return undefined;

  let url: URL;
  try {
    url = new URL(candidate, REVIEWS_ORIGIN);
  } catch {
    throw new ParserChangedError(`Yandex model ${listingId} has an invalid canonical URL`);
  }
  if (url.protocol !== "https:" || url.hostname !== "reviews.yandex.ru") {
    throw new ParserChangedError(`Yandex model ${listingId} canonical URL does not identify the requested model`);
  }
  const canonicalModelId = extractModelId(url.toString());
  // A valid same-origin canonical for another model is an explicit redirect
  // away from this discovery candidate. Never collect the replacement model
  // under the stale ID, and do not block unrelated current cards.
  if (canonicalModelId && canonicalModelId !== listingId) return undefined;
  if (canonicalModelId !== listingId) {
    throw new ParserChangedError(`Yandex model ${listingId} canonical URL does not identify the requested model`);
  }
  return canonicalizeUrl(url.toString());
}

function assertTranslatedSource(html: string, expectedSourceUrl: string, listingId: string): void {
  const baseTag = html.match(/<base\b[^>]*>/i)?.[0];
  const sourceValue = baseTag ? htmlAttribute(baseTag, "href") : undefined;
  if (!sourceValue) {
    throw new ParserChangedError(`Yandex translated model ${listingId} has no source URL proof`);
  }
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceValue);
  } catch {
    throw new ParserChangedError(`Yandex translated model ${listingId} has an invalid source URL proof`);
  }
  const expected = new URL(expectedSourceUrl);
  if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "reviews.yandex.ru" ||
    sourceUrl.pathname !== expected.pathname || sourceUrl.search || sourceUrl.hash) {
    throw new ParserChangedError(`Yandex translated model ${listingId} returned a different source page`);
  }
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
