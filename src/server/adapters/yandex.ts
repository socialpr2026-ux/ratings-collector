import type {
  AdapterActivityEvent,
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { isKnownYandexIndexTombstoneSitemap } from "../../shared/yandex-sitemaps.js";
import { aliasesForBrand, matchesBrand, normalizeRating } from "../utils/normalize.js";
import { readTextBounded } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { extractPageProductEvidence, titleProvesProductVariant } from "../utils/product-evidence.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./errors.js";

const DEFAULT_SITEMAP_INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const REVIEWS_ORIGIN = "https://reviews.yandex.ru";
const MARKET_ORIGIN = "https://market.yandex.ru";
const TRANSLATE_ORIGIN = "https://reviews-yandex-ru.translate.goog";
const MARKET_TRANSLATE_ORIGIN = "https://market-yandex-ru.translate.goog";
const DIRECT_SOURCE = "yandex_reviews_json_ld";
const TRANSLATE_SOURCE = "yandex_reviews_json_ld_google_translate";
const MARKET_TRANSLATE_SOURCE = "yandex_market_json_ld_google_translate";
const MARKET_BROWSER_SOURCE = "yandex_market_json_ld_browser";
const MARKET_SEARCH_SOURCE = "yandex_market_json_ld_search";
const MODEL_SITEMAP_PATH = /^\/ugcpub\/sitemap_model_\d+-\d+-\d+\.xml$/i;
const SHOP_SITEMAP_PATH = /^\/ugcpub\/sitemap_shop_((?:[0-9a-z]|%[0-9a-f]{2})-(?:[0-9a-z]|%[0-9a-f]{2}))-\d+\.xml$/i;
const SHOP_SITEMAP_RANGES = new Set([
  "%25-%26",
  ...Array.from({ length: 10 }, (_value, index) => `${index}-${index === 9 ? "%3a" : index + 1}`),
  ...Array.from({ length: 26 }, (_value, index) => {
    const start = String.fromCharCode("a".charCodeAt(0) + index);
    const end = index === 25 ? "%7b" : String.fromCharCode("a".charCodeAt(0) + index + 1);
    return `${start}-${end}`;
  })
]);
const MODEL_ID_AT_END = /--(\d+)(?:[/?#]|$)/;
// The gateway has two shard workers and a 120-second platform ceiling. A
// two-shard package is one wave and stays below the Agent's transport deadline
// even when both exact 50-second shard attempts are needed. Two gateway calls
// still keep the proven production peak at four upstream shards.
const YANDEX_BATCH_CHUNK_SIZE = 2;
const YANDEX_BATCH_CONCURRENCY = 2;
const YANDEX_PROGRESS_SITEMAP_INTERVAL = 32;

type YandexCapableFetch = typeof globalThis.fetch & {
  yandexBatchEndpoint?: string;
  yandexMarketBrowserEndpoint?: string;
};

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

type CachedDiscoveryBatch = {
  brandKeys: Set<string>;
  attemptedBrandKeys: Set<string>;
  value: Promise<DiscoveryBatch>;
};

type YandexBatchProof = {
  processed: number;
  firstSitemap: string;
  lastSitemap: string;
  verifiedSitemaps: string[];
  tombstonedSitemaps?: string[];
  matches: Array<{ brand: string; url: string; sitemap: string }>;
};

type YandexMarketSearchProof = {
  query: string;
  page: number;
  hasNext: boolean;
  products: Array<{
    id: string;
    name: string;
    url: string;
    ratingCount?: number;
    rating?: number;
    familyId?: string;
  }>;
};

type ProductPage =
  | { kind: "missing"; requestUrl: string }
  | {
      kind: "html";
      html: string;
      responseUrl: string;
      translated: boolean;
    };

async function reportActivity(context: AdapterContext, event: AdapterActivityEvent): Promise<void> {
  try { await context.activity?.(event); }
  catch { /* progress telemetry must never change collector semantics */ }
}

async function fetchWithDeadline(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  const deadline = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline.signal])
    : deadline.signal;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  const timer = setTimeout(
    () => deadline.abort(new AdapterBlockedError(`${label} exceeded ${timeoutMs}ms`)),
    timeoutMs
  );
  timer.unref?.();
  try {
    // Edge runtimes do not all settle fetch() when its signal is aborted. The
    // explicit race guarantees that the adapter still returns control while
    // the same signal asks compliant transports to release their resources.
    return await Promise.race([fetcher(input, { ...init, signal }), interrupted]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

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
  batchRequestTimeoutMs?: number;
  productRequestTimeoutMs?: number;
  /** Maximum number of rendered Yandex Market search pages inspected. */
  maxMarketPages?: number;
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
  private readonly batchRequestTimeoutMs: number;
  private readonly productRequestTimeoutMs: number;
  private readonly maxMarketPages: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private indexCache?: Cached<string[]>;
  /**
   * One Yandex run asks for every brand concurrently. Coalesce those calls into
   * one exhaustive sitemap pass and keep only the small matched-ref index.
   * Raw multi-megabyte sitemap XML is deliberately never cached here.
   */
  private readonly discoveryBatches = new Map<string, CachedDiscoveryBatch>();

  constructor(options: YandexAdapterOptions = {}) {
    this.fallbackFetch = options.fetch ?? globalThis.fetch;
    this.sitemapIndexUrl = options.sitemapIndexUrl ?? DEFAULT_SITEMAP_INDEX;
    // The live index grows over time. The hard ceiling catches a structural
    // jump while the default still scans every currently declared model map.
    this.maxSitemaps = boundedInteger(options.maxSitemaps, 400, 1, 400);
    this.maxCandidates = boundedInteger(options.maxCandidates, 300, 1, 2_000);
    this.maxDocumentBytes = boundedInteger(options.maxDocumentBytes, 12_000_000, 10_000, 25_000_000);
    // Edge/cloud egress is throttled when many multi-MB sitemap shards arrive
    // together. Four workers preserve the complete scan without overloading the
    // fixed gateway or turning a transient shard failure into a false result.
    this.sitemapConcurrency = boundedInteger(options.sitemapConcurrency, 4, 1, 12);
    this.cacheTtlMs = boundedInteger(options.cacheTtlMs, 30 * 60_000, 0, 24 * 60 * 60_000);
    this.sitemapRetryAttempts = boundedInteger(options.sitemapRetryAttempts, 3, 1, 5);
    this.sitemapRetryBaseMs = boundedInteger(options.sitemapRetryBaseMs, 250, 0, 10_000);
    // The fixed EdgeOne route validates and compacts complete multi-megabyte
    // shards before handing them to the adapter. On a cold function the
    // verified transfer can legitimately take more than 20 seconds; keep the
    // safety deadline, but do not misclassify a healthy shard as blocked.
    this.sitemapReadTimeoutMs = boundedInteger(options.sitemapReadTimeoutMs, 60_000, 1, 120_000);
    // The Agent bounds one gateway transport beyond the Function's 120-second
    // ceiling and may then split one two-shard package into exact singletons.
    // Keep enough time for that recovery chain while the explicit race still
    // guarantees a finite outcome when an edge fetch ignores AbortSignal.
    this.batchRequestTimeoutMs = boundedInteger(options.batchRequestTimeoutMs, 330_000, 1, 360_000);
    // Product-page traffic can pass through the same fixed gateway as sitemap
    // traffic. Bound every direct/translated page request independently so a
    // lost upstream response cannot pin the collection stage forever.
    this.productRequestTimeoutMs = boundedInteger(options.productRequestTimeoutMs, 45_000, 1, 120_000);
    this.maxMarketPages = boundedInteger(options.maxMarketPages, 50, 1, 50);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = this.now().toISOString();
    const knownModelIds = previousModelIds(context.previousIds ?? []);
    if (knownModelIds.length > 0 && !context.refreshDiscovery) {
      return {
        ok: true,
        checkedAt,
        message: `Saved Yandex model registry is available (${knownModelIds.length} models)`
      };
    }
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
    const knownIds = previousModelIds(context.previousIds ?? []);
    const knownSet = new Set(knownIds);
    const previousRefs = new Map((context.previousRefs ?? []).flatMap((previous) => {
      const listingId = normalizeListingId(previous.listingId) ?? extractModelId(previous.url) ??
        extractMarketCardId(previous.url);
      return listingId ? [[listingId, previous] as const] : [];
    }));

    for (const listingId of knownIds) {
      refs.set(listingId, productRefFromPreviousId(listingId, brand, previousRefs.get(listingId)));
    }

    // Repeat collections validate the exact models retained after the previous
    // successful collection. The exhaustive sitemap scan is an explicit,
    // separate refresh so it never delays publication of known cards.
    if (refs.size > 0 && !context.refreshDiscovery) {
      return [...refs.values()].sort((a, b) => compareIds(a.listingId, b.listingId));
    }

    const fetcher = (context.fetch ?? this.fallbackFetch) as YandexCapableFetch;
    if (fetcher.yandexMarketBrowserEndpoint) {
      try {
        for (const ref of await this.discoverMarketCards(
          fetcher.yandexMarketBrowserEndpoint,
          brand,
          context
        )) {
          refs.set(ref.listingId, ref);
        }
        if (refs.size > this.maxCandidates) {
          throw new AdapterBlockedError(
            `Yandex Market discovery for ${brand} found more than ${this.maxCandidates} distinct cards`
          );
        }
        return [...refs.values()].sort((a, b) =>
          Number(knownSet.has(b.listingId)) - Number(knownSet.has(a.listingId)) ||
          (a.title ?? "").localeCompare(b.title ?? "", "ru") || compareIds(a.listingId, b.listingId)
        );
      } catch (error) {
        if (!(error instanceof AdapterBlockedError) && !(error instanceof AdapterQuotaError) &&
          !(error instanceof ParserChangedError)) throw error;
        if (context.signal?.aborted) throw error;
        await reportActivity(context, {
          operationId: "yandex:market-to-reviews-fallback",
          stage: "discovery",
          status: "warning",
          label: "Yandex: резервный полный индекс",
          channels: ["gateway"],
          detail: `Market proof недоступен; проверяем полный Reviews index: ${errorMessage(error)}`
        });
      }
    }

    const brands = uniqueDiscoveryBrands(brand, context.brands ?? []);
    const batchKey = discoveryBatchKey(context.runId, brands);
    const discoveredByBrand = batchKey
      ? await this.loadDiscoveryBatch(batchKey, brands, brand, context)
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
      .sort((a, b) => Number(knownSet.has(b.listingId)) - Number(knownSet.has(a.listingId)) ||
        (a.title ?? "").localeCompare(b.title ?? "", "ru") || compareIds(a.listingId, b.listingId));
  }

  private async discoverMarketCards(
    endpoint: string,
    brand: string,
    context: AdapterContext
  ): Promise<ProductRef[]> {
    const base = new URL(endpoint);
    if (base.protocol !== "https:" || base.origin !== MARKET_ORIGIN || base.pathname !== "/search" ||
      base.search || base.hash || base.username || base.password) {
      throw new ParserChangedError("Yandex Market browser endpoint is not the fixed search route");
    }
    const fetcher = context.fetch ?? this.fallbackFetch;
    const brands = context.brands?.length ? context.brands : [brand];
    const refs = new Map<string, ProductRef>();
    let exhaustionProven = false;

    for (let page = 1; page <= this.maxMarketPages; page += 1) {
      const url = new URL(base);
      url.searchParams.set("text", brand);
      if (page > 1) url.searchParams.set("page", String(page));
      let response: Response;
      try {
        response = await fetchWithDeadline(fetcher, url.toString(), {
          method: "GET",
          redirect: "error",
          signal: context.signal,
          headers: {
            accept: "application/json",
            "accept-language": "ru-RU,ru;q=0.9",
            "x-ratings-browser": "1",
            "x-ratings-browser-mode": "yandex-market-proof"
          }
        }, this.productRequestTimeoutMs, `Yandex Market search request for page ${page}`);
      } catch (error) {
        if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) throw error;
        if (context.signal?.aborted) throw error;
        throw new AdapterBlockedError(`Yandex Market search page ${page} is unavailable: ${errorMessage(error)}`);
      }
      assertUsableResponse(response, url.toString());
      let proof: YandexMarketSearchProof;
      try {
        proof = JSON.parse(await readBoundedBody(response, 1_000_000, url.toString(), 30_000)) as YandexMarketSearchProof;
      } catch (error) {
        throw new ParserChangedError(`Yandex Market search page ${page} proof is unreadable: ${errorMessage(error)}`);
      }
      if (!validYandexMarketSearchProof(proof, brand, page)) {
        throw new ParserChangedError(`Yandex Market search page ${page} proof is incomplete or source-unbound`);
      }
      for (const product of proof.products) {
        const matchedBrands = bestMatchingTextBrandKeys(product.name, brands);
        if (!matchedBrands.has(brandKey(brand))) continue;
        const reviewsUrl = marketCardReviewsUrl(product.url, product.id);
        if (!reviewsUrl) continue;
        refs.set(product.id, {
          domain: "market.yandex.ru",
          platform: this.id,
          listingId: product.id,
          brand,
          url: reviewsUrl,
          title: product.name,
          metadata: {
            discovery: "yandex-market-rendered-search",
            sourceSearch: url.toString(),
            ...(product.ratingCount !== undefined ? { searchRatingCount: product.ratingCount } : {}),
            ...(product.rating !== undefined ? { searchRating: product.rating } : {}),
            ...(product.familyId ? { searchFamilyId: product.familyId } : {})
          }
        });
        if (refs.size > this.maxCandidates) {
          throw new AdapterBlockedError(
            `Yandex Market discovery for ${brand} found more than ${this.maxCandidates} distinct cards`
          );
        }
      }
      await reportActivity(context, {
        operationId: `yandex:market-search:${page}`,
        stage: "discovery",
        status: proof.hasNext ? "active" : "complete",
        label: "Полный поиск карточек Yandex Market",
        channels: ["browser"],
        detail: `Проверена страница ${page}; точных карточек: ${refs.size}`
      });
      if (!proof.hasNext) {
        exhaustionProven = true;
        break;
      }
    }
    if (!exhaustionProven) {
      throw new AdapterBlockedError(
        `Yandex Market search for ${brand} reached the ${this.maxMarketPages}-page safety limit without proving exhaustion`
      );
    }
    return [...refs.values()];
  }

  private async loadDiscoveryBatch(
    key: string,
    brands: string[],
    requestedBrand: string,
    context: AdapterContext
  ): Promise<DiscoveryBatch> {
    let cached = this.discoveryBatches.get(key);
    if (!cached) {
      cached = {
        brandKeys: new Set(brands.map(brandKey)),
        attemptedBrandKeys: new Set(),
        value: this.scanDiscoveryBatch(brands, context)
      };
      this.discoveryBatches.set(key, cached);
    }
    cached.attemptedBrandKeys.add(brandKey(requestedBrand));
    // Agent isolates may occasionally be reused. A handful of tiny matched-ref
    // indexes is enough for overlapping requests; never grow an unbounded cache.
    while (this.discoveryBatches.size > 4) {
      const oldest = this.discoveryBatches.keys().next().value as string | undefined;
      if (!oldest || oldest === key) break;
      this.discoveryBatches.delete(oldest);
    }
    try {
      return await cached.value;
    } catch (error) {
      // A failed exhaustive pass is shared by every brand in this run. Keep
      // that exact outcome until each brand has observed it, so a sequential
      // orchestrator cannot download the same 329 shards again. Once all
      // brands have consumed the failure, a later selective retry may rescan.
      if (cached.attemptedBrandKeys.size >= cached.brandKeys.size && this.discoveryBatches.get(key) === cached) {
        this.discoveryBatches.delete(key);
      }
      throw error;
    }
  }

  private async scanDiscoveryBatch(
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
    const batchEndpoint = ((context.fetch ?? this.fallbackFetch) as YandexCapableFetch).yandexBatchEndpoint;
    if (batchEndpoint) return this.scanDiscoveryBatchViaGateway(batchEndpoint, selected, brands, context);
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
          const matched = [...discoveries.values()]
            .map((discovery) => ({ discovery, score: yandexBrandMatchScore(url, discovery.brand) }))
            .filter(({ score }) => score >= 0);
          const bestScore = Math.max(-1, ...matched.map(({ score }) => score));
          for (const { discovery, score } of matched) {
            // When requested brands overlap (for example, "Видора" and
            // "Видора Микро"), assign the model to the most specific exact
            // brand only instead of duplicating it under the shorter prefix.
            if (score !== bestScore) continue;
            if (discovery.error) continue;
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

  private async scanDiscoveryBatchViaGateway(
    endpoint: string,
    sitemapUrls: string[],
    brands: string[],
    context: AdapterContext
  ): Promise<DiscoveryBatch> {
    const fetcher = context.fetch ?? this.fallbackFetch;
    const chunks = chunked(sitemapUrls, YANDEX_BATCH_CHUNK_SIZE);
    const discoveries = new Map<string, BrandDiscovery>(brands.map((brand) => [
      brandKey(brand),
      { brand, refs: new Map() }
    ]));
    // A failed chunk stops workers from taking new chunks, but an already
    // running sibling must settle normally before the failure is returned.
    // Aborting that sibling makes the same error appear against two packages
    // and can leave fixed-function egress overlapping the next retry.
    const batchAbort = new AbortController();
    let callerAborted = false;
    const relayAbort = () => {
      callerAborted = true;
      batchAbort.abort(context.signal?.reason);
    };
    if (context.signal?.aborted) relayAbort();
    else context.signal?.addEventListener("abort", relayAbort, { once: true });
    let cursor = 0;
    let completedSitemaps = 0;
    let reportedSitemaps = 0;
    let failure: unknown;
    const tombstonedSitemaps = new Set<string>();

    const processChunk = async (sitemaps: string[]): Promise<void> => {
      let response: Response | undefined;
      let lastRequestError: unknown;
      for (let attempt = 1; attempt <= this.sitemapRetryAttempts; attempt += 1) {
        try {
          response = await fetchWithDeadline(fetcher, endpoint, {
            method: "POST",
            redirect: "error",
            signal: batchAbort.signal,
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              sitemaps,
              brands: brands.map((brand) => ({ brand, tokens: yandexBrandTokens(brand) }))
            })
          }, this.batchRequestTimeoutMs, "Yandex batch proof request");
          if (!response.ok && [500, 502, 503, 504].includes(response.status) && attempt < this.sitemapRetryAttempts) {
            const status = response.status;
            await response.body?.cancel().catch(() => undefined);
            response = undefined;
            lastRequestError = new Error(`Yandex batch proof returned transient HTTP ${status}`);
            await this.waitBeforeSitemapRetry(attempt, context);
            continue;
          }
          break;
        } catch (error) {
          if (callerAborted || batchAbort.signal.aborted) throw error;
          lastRequestError = error;
          if (attempt < this.sitemapRetryAttempts) {
            await this.waitBeforeSitemapRetry(attempt, context);
          }
        }
      }
      if (!response) {
        throw new AdapterBlockedError(`Yandex batch proof request failed: ${errorMessage(lastRequestError)}`);
      }
      if (!response.ok) {
        let detail = "";
        try {
          const body = JSON.parse(await readBoundedBody(response, 10_000, endpoint, 5_000)) as { error?: unknown };
          if (typeof body.error === "string" && body.error.trim()) detail = `: ${body.error.trim().slice(0, 600)}`;
        } catch { /* status remains sufficient when the gateway body is unreadable */ }
        throw new AdapterBlockedError(`Yandex batch proof failed with HTTP ${response.status}${detail}`);
      }
      let proof: YandexBatchProof;
      try {
        proof = JSON.parse(await readBoundedBody(response, 500_000, endpoint, 60_000)) as YandexBatchProof;
      } catch (error) {
        throw new AdapterBlockedError(`Yandex batch proof is unreadable: ${errorMessage(error)}`);
      }
      if (!validYandexBatchProof(proof, sitemaps, brands)) {
        throw new AdapterBlockedError("Yandex batch proof is incomplete or source-unbound");
      }
      for (const sitemap of proof.tombstonedSitemaps ?? []) tombstonedSitemaps.add(sitemap);
      for (const match of proof.matches) {
        const discovery = discoveries.get(brandKey(match.brand))!;
        const listingId = extractModelId(match.url)!;
        discovery.refs.set(listingId, productRefFromSitemap(listingId, match.url, discovery.brand, match.sitemap));
        if (discovery.refs.size > this.maxCandidates) {
          discovery.error = new AdapterBlockedError(
            `Yandex discovery for ${discovery.brand} found more than ${this.maxCandidates} distinct models`
          );
          discovery.refs.clear();
        }
      }
    };

    const worker = async (): Promise<void> => {
      while (failure === undefined && !batchAbort.signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= chunks.length) return;
        const sitemaps = chunks[index]!;
        try {
          await processChunk(sitemaps);
          completedSitemaps += sitemaps.length;
          if (
            completedSitemaps === sitemapUrls.length ||
            completedSitemaps - reportedSitemaps >= YANDEX_PROGRESS_SITEMAP_INTERVAL
          ) {
            reportedSitemaps = completedSitemaps;
            await reportActivity(context, {
              operationId: "yandex:gateway-progress",
              stage: "discovery",
              status: completedSitemaps === sitemapUrls.length ? "complete" : "active",
              label: "Полный поиск карточек Yandex",
              channels: ["gateway"],
              detail: `Проверено карт индекса: ${completedSitemaps} из ${sitemapUrls.length}`
            });
          }
        } catch (error) {
          if (batchAbort.signal.aborted && failure !== undefined) return;
          await reportActivity(context, {
            operationId: `yandex:gateway-failure:${index}`,
            stage: "discovery",
            status: "warning",
            label: "Полный поиск карточек Yandex",
            channels: ["gateway"],
            detail: `Пакет ${index + 1} не подтверждён: ${errorMessage(error)}`
          });
          failure ??= error;
          // A complete scan cannot succeed after one package exhausted its
          // bounded retries. Interrupt the sibling worker immediately instead
          // of waiting for another long gateway recovery chain to finish.
          batchAbort.abort(failure);
          return;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(YANDEX_BATCH_CONCURRENCY, chunks.length) }, worker));
      if (failure !== undefined) throw failure;
      if (callerAborted) throw context.signal?.reason ?? new DOMException("aborted", "AbortError");
      if (tombstonedSitemaps.size > 0) {
        await reportActivity(context, {
          operationId: "yandex:gateway-tombstones",
          stage: "discovery",
          status: "complete",
          label: "Yandex: проверка карт индекса",
          channels: ["gateway"],
          detail: `Индекс проверен: ${tombstonedSitemaps.size} неиспользуемых пустых диапазонов`
        });
      }
    } finally {
      context.signal?.removeEventListener("abort", relayAbort);
    }
    return new Map([...discoveries].map(([key, discovery]) => [
      key,
      discovery.error ?? [...discovery.refs.values()].sort((a, b) =>
        (a.title ?? "").localeCompare(b.title ?? "", "ru") || compareIds(a.listingId, b.listingId)
      )
    ]));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = normalizeListingId(ref.listingId) ?? extractModelId(ref.url) ?? extractMarketCardId(ref.url);
    if (!listingId) throw new ParserChangedError(`Invalid Yandex modelId: ${ref.listingId}`);
    if (isAllowedMarketCardReviewsUrl(ref.url, listingId)) {
      const searchProof = this.collectMarketSearchProof(ref, listingId, context);
      if (searchProof) return searchProof;
      return this.collectMarketCard(ref, listingId, context);
    }

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

  private collectMarketSearchProof(
    ref: ProductRef,
    listingId: string,
    context: AdapterContext
  ): Observation | undefined {
    if (!Object.hasOwn(ref.metadata, "searchRatingCount") && !Object.hasOwn(ref.metadata, "searchRating")) {
      return undefined;
    }
    const ratingCount = parseNonNegativeInteger(ref.metadata.searchRatingCount);
    const rating = parseFiniteNumber(ref.metadata.searchRating);
    const sourceSearch = nonEmptyString(ref.metadata.sourceSearch);
    const title = nonEmptyString(ref.title);
    if (ratingCount === undefined || rating === undefined || rating < 0 || rating > 5 ||
      (ratingCount > 0 && rating === 0) || !sourceSearch || !title) {
      throw new ParserChangedError(`Yandex Market search metrics for card ${listingId} are incomplete`);
    }
    let sourceUrl: URL;
    try { sourceUrl = new URL(sourceSearch); }
    catch { throw new ParserChangedError(`Yandex Market search proof for card ${listingId} has an invalid URL`); }
    const sourcePage = sourceUrl.searchParams.get("page") ?? "1";
    if (sourceUrl.origin !== MARKET_ORIGIN || sourceUrl.pathname !== "/search" ||
      brandKey(sourceUrl.searchParams.get("text") ?? "") !== brandKey(ref.brand) ||
      !/^\d+$/.test(sourcePage) || Number(sourcePage) < 1 || Number(sourcePage) > this.maxMarketPages ||
      [...sourceUrl.searchParams.keys()].some((key) => key !== "text" && key !== "page")) {
      throw new ParserChangedError(`Yandex Market search proof for card ${listingId} is source-unbound`);
    }
    const brands = context.brands?.length ? context.brands : [ref.brand];
    const brandMatches = bestMatchingTextBrandKeys(title, brands).has(brandKey(ref.brand));
    const canonicalUrl = canonicalizeUrl(ref.url);
    const familyId = nonEmptyString(ref.metadata.searchFamilyId);
    if (familyId && !/^\d{1,40}$/.test(familyId)) {
      throw new ParserChangedError(`Yandex Market search family for card ${listingId} is invalid`);
    }
    return {
      domain: "market.yandex.ru",
      platform: this.id,
      listingId,
      brand: ref.brand,
      canonicalUrl,
      product: title,
      reviews: ratingCount,
      rating: ratingCount === 0 ? null : rating,
      rawRating: ratingCount === 0 ? null : rating,
      rawRatingScale: 5,
      ratingCount,
      status: brandMatches ? (ratingCount === 0 ? "no_reviews" : "ok") : "needs_review",
      capturedAt: this.now().toISOString(),
      ...(familyId ? { aggregateGroupId: `yandex:sku:${familyId}` } : {}),
      evidenceRef: `${sourceUrl.toString()}#json-ld`,
      productEvidence: {
        scope: "listing",
        signals: [
          { source: "title", text: title },
          { source: "url", text: canonicalUrl }
        ],
        variants: [],
        identifiers: [
          { type: "model_id", value: listingId },
          ...(familyId ? [{ type: "sku" as const, value: familyId }] : [])
        ],
        imageUrls: [],
        instructionUrls: []
      },
      source: MARKET_SEARCH_SOURCE
    };
  }

  private async collectMarketCard(
    ref: ProductRef,
    listingId: string,
    context: AdapterContext
  ): Promise<Observation> {
    let response: Response;
    try {
      response = await this.requestMarketCard(ref.url, context);
    } catch (error) {
      if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) throw error;
      if (context.signal?.aborted) throw error;
      throw new AdapterBlockedError(`Yandex Market card ${listingId} is unavailable: ${errorMessage(error)}`);
    }
    if (response.status === 404 || response.status === 410) {
      return this.emptyObservation(ref, listingId, ref.url, "not_found", "yandex_market_missing_candidate");
    }
    assertUsableResponse(response, ref.url);
    const finalUrl = response.headers.get("x-ratings-final-url") || response.url || ref.url;
    if (!isAllowedMarketCardReviewsUrl(finalUrl, listingId)) {
      throw new ParserChangedError(`Yandex Market card ${listingId} escaped its exact reviews route`);
    }
    const html = await readBoundedBody(response, this.maxDocumentBytes, finalUrl);
    if (looksBlocked(html)) throw new AdapterBlockedError(`Yandex blocked Market card ${listingId}`);
    const metrics = extractMarketCardMetrics(html, listingId, ref.title, ref.brand);
    const brands = context.brands?.length ? context.brands : [ref.brand];
    const brandMatches = bestMatchingTextBrandKeys(metrics.title, brands).has(brandKey(ref.brand));
    const canonicalUrl = canonicalizeUrl(finalUrl);
    return {
      domain: "market.yandex.ru",
      platform: this.id,
      listingId,
      brand: ref.brand,
      canonicalUrl,
      product: metrics.title,
      reviews: metrics.ratingCount,
      writtenReviewCount: metrics.reviewCount,
      rating: metrics.ratingCount === 0 ? null : metrics.rating,
      rawRating: metrics.ratingCount === 0 ? null : metrics.rating,
      rawRatingScale: 5,
      ratingCount: metrics.ratingCount,
      status: brandMatches ? (metrics.ratingCount === 0 ? "no_reviews" : "ok") : "needs_review",
      capturedAt: this.now().toISOString(),
      evidenceRef: `${canonicalUrl}#json-ld`,
      productEvidence: {
        scope: "listing",
        signals: [
          { source: "title", text: metrics.title },
          { source: "url", text: canonicalUrl }
        ],
        variants: [],
        identifiers: [{ type: "model_id", value: listingId }],
        imageUrls: [],
        instructionUrls: []
      },
      source: response.headers.get("x-ratings-proof-route") === "yandex-market-browser"
        ? MARKET_BROWSER_SOURCE
        : MARKET_TRANSLATE_SOURCE
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
      if (triedNumericRoute) throw error;
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
    if (response.status === 404 || response.status === 410) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "missing", requestUrl: sourceUrl };
    }
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

    const locations = parseXmlLocs(xml);
    const declared = xml.match(/<sitemap\b/gi)?.length ?? 0;
    const modelLocations = locations.filter(isAllowedModelSitemap);
    if (declared === 0 || locations.length !== declared || modelLocations.length === 0 ||
      locations.some((location) => !isAllowedModelSitemap(location) && !isAllowedShopSitemap(location)) ||
      new Set(locations).size !== locations.length) {
      throw new ParserChangedError("Yandex sitemap index is incomplete or contains an unknown map shape");
    }
    // The root index also advertises shop-review maps. They are part of the
    // index completeness proof, but cannot contain exact Market product model
    // cards and must not consume the product discovery scan budget.
    return modelLocations;
  }

  private async fetchModelSitemap(url: string, context: AdapterContext): Promise<string> {
    if (!isAllowedModelSitemap(url)) throw new ParserChangedError("Unsafe model sitemap URL in Yandex index");
    const xml = await this.fetchSitemapDocument(url, context, "model");
    if (looksBlocked(xml)) throw new AdapterBlockedError(`Yandex blocked model sitemap ${url}`);
    if (!/<urlset\b/i.test(xml)) throw new ParserChangedError(`Yandex model sitemap XML shape changed: ${url}`);
    assertCompleteModelSitemap(xml, url);
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
        if (isKnownYandexIndexTombstoneSitemap(url)) {
          return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"></urlset>";
        }
        throw new AdapterBlockedError(`Yandex indexed model sitemap disappeared: ${url}`);
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
      return await fetchWithDeadline(fetcher, url, {
        method: "GET",
        redirect: "follow",
        signal: context.signal,
        headers: {
          accept,
          "accept-language": "ru-RU,ru;q=0.9",
          "user-agent": "RatingsCollector/1.0 (+https://reviews.yandex.ru/robots.txt)"
        }
      }, this.productRequestTimeoutMs, `Yandex product request for ${url}`);
    } catch (error) {
      if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) throw error;
      if (context.signal?.aborted) throw error;
      throw new AdapterBlockedError(`Yandex request failed for ${url}: ${errorMessage(error)}`);
    }
  }

  private async requestMarketCard(url: string, context: AdapterContext): Promise<Response> {
    const fetcher = context.fetch ?? this.fallbackFetch;
    if (typeof fetcher !== "function") throw new AdapterBlockedError("No fetch implementation is available");
    const source = new URL(url);
    if ((fetcher as YandexCapableFetch).yandexMarketBrowserEndpoint) {
      try {
        return await fetchWithDeadline(fetcher, source.toString(), {
          method: "GET",
          redirect: "error",
          signal: context.signal,
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "ru-RU,ru;q=0.9",
            "user-agent": "RatingsCollector/1.0 (+public aggregate metrics)",
            "x-ratings-browser": "1",
            "x-ratings-browser-mode": "yandex-market-proof"
          }
        }, this.productRequestTimeoutMs, `Yandex Market browser product request for ${url}`);
      } catch (error) {
        if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) throw error;
        if (context.signal?.aborted) throw error;
        throw new AdapterBlockedError(`Yandex Market browser request failed for ${url}: ${errorMessage(error)}`);
      }
    }
    const translated = new URL(source.pathname, MARKET_TRANSLATE_ORIGIN);
    translated.searchParams.set("_x_tr_sl", "ru");
    translated.searchParams.set("_x_tr_tl", "en");
    translated.searchParams.set("_x_tr_hl", "en");
    try {
      return await fetchWithDeadline(fetcher, translated.toString(), {
        method: "GET",
        redirect: "follow",
        signal: context.signal,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ru-RU,ru;q=0.9",
          "user-agent": "RatingsCollector/1.0 (+public aggregate metrics)"
        }
      }, this.productRequestTimeoutMs, `Yandex Market translated product request for ${url}`);
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
    return isAllowedYandexSitemapUrl(url) && MODEL_SITEMAP_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function isAllowedShopSitemap(input: string): boolean {
  try {
    const url = new URL(input);
    const range = url.pathname.match(SHOP_SITEMAP_PATH)?.[1]?.toLowerCase();
    return isAllowedYandexSitemapUrl(url) && Boolean(range && SHOP_SITEMAP_RANGES.has(range));
  } catch {
    return false;
  }
}

function isAllowedYandexSitemapUrl(url: URL): boolean {
  return url.protocol === "https:" && url.hostname === "reviews.yandex.ru" && !url.port &&
    !url.username && !url.password && !url.search && !url.hash;
}

function assertCompleteModelSitemap(xml: string, sitemap: string): void {
  const requested = new URL(sitemap);
  const range = requested.pathname.match(/sitemap_model_(\d+)-(\d+)-\d+\.xml/i);
  const locations = parseXmlLocs(xml);
  const declared = xml.match(/<url\b/gi)?.length ?? 0;
  if (!range || locations.length !== declared) {
    throw new ParserChangedError(`Yandex model sitemap is incomplete: ${sitemap}`);
  }
  const minimumId = BigInt(range[1]!);
  const maximumId = BigInt(range[2]!);
  for (const location of locations) {
    let product: URL;
    try { product = new URL(location); }
    catch { throw new ParserChangedError(`Yandex model sitemap contains an invalid URL: ${sitemap}`); }
    const modelId = product.pathname.match(/^\/product\/(?:[a-z0-9][a-z0-9_-]*)?--(\d+)$/i)?.[1];
    if (product.protocol !== "https:" || product.hostname !== "reviews.yandex.ru" || product.port ||
      product.username || product.password || product.search || product.hash || !modelId) {
      throw new ParserChangedError(`Yandex model sitemap contains an unknown product route: ${sitemap}`);
    }
    const numericId = BigInt(modelId);
    if (numericId < minimumId || numericId > maximumId) {
      throw new ParserChangedError(`Yandex model sitemap contains a cross-range product: ${sitemap}`);
    }
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

function extractMarketCardId(input: string): string | undefined {
  try {
    const url = new URL(input);
    return url.pathname.match(/^\/card\/[a-z0-9][a-z0-9-]*\/(\d+)\/reviews\/?$/i)?.[1];
  } catch {
    return undefined;
  }
}

function isAllowedMarketCardReviewsUrl(input: string, listingId: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.hostname === "market.yandex.ru" && !url.port &&
      !url.username && !url.password && !url.search && !url.hash && extractMarketCardId(input) === listingId;
  } catch {
    return false;
  }
}

function isAllowedMarketSearchCardUrl(input: string, listingId: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && url.hostname === "market.yandex.ru" && !url.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.match(/^\/card\/[a-z0-9][a-z0-9-]*\/(\d+)\/?$/i)?.[1] === listingId;
  } catch {
    return false;
  }
}

function marketCardReviewsUrl(input: string, listingId: string): string | undefined {
  if (!isAllowedMarketSearchCardUrl(input, listingId)) return undefined;
  const url = new URL(input);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/reviews`;
  return canonicalizeUrl(url.toString());
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

function productRefFromPreviousId(
  listingId: string,
  brand: string,
  previous?: { url: string; title?: string }
): ProductRef {
  const retainedUrl = previous?.url && (
    isAllowedProductUrl(previous.url) && extractModelId(previous.url) === listingId ||
    isAllowedMarketCardReviewsUrl(previous.url, listingId)
  ) ? canonicalizeUrl(previous.url) : undefined;
  return {
    domain: "market.yandex.ru",
    platform: "yandex",
    listingId,
    brand,
    url: retainedUrl ?? `${REVIEWS_ORIGIN}/product/model--${listingId}`,
    ...(previous?.title ? { title: previous.title } : {}),
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
  return yandexBrandMatchScore(input, brand) >= 0;
}

function yandexBrandMatchScore(input: string, brand: string): number {
  const slug = normalizedSlug(input);
  if (!slug) return -1;

  const scores = aliasesForBrand(brand).flatMap((alias) => {
    const normalizedAlias = normalizeForSlug(alias);
    const transliteratedAlias = normalizeForSlug(transliterateForYandex(alias));
    return [normalizedAlias, transliteratedAlias]
      .filter(Boolean)
      .filter((candidate) => ` ${slug} `.includes(` ${candidate} `))
      .map((candidate) => candidate.replace(/\s+/g, "").length);
  });
  return scores.length > 0 ? Math.max(...scores) : -1;
}

function bestMatchingBrandKeys(input: string, brands: readonly string[]): Set<string> {
  const matches = brands
    .map((brand) => ({ key: brandKey(brand), score: yandexBrandMatchScore(input, brand) }))
    .filter(({ score }) => score >= 0);
  const bestScore = Math.max(-1, ...matches.map(({ score }) => score));
  return new Set(matches.filter(({ score }) => score === bestScore).map(({ key }) => key));
}

function textBrandMatchScore(input: string, brand: string): number {
  const normalized = ` ${normalizeForSlug(input)} `;
  const scores = aliasesForBrand(brand)
    .map(normalizeForSlug)
    .filter(Boolean)
    .filter((candidate) => normalized.includes(` ${candidate} `))
    .map((candidate) => candidate.replace(/\s+/g, "").length);
  return scores.length > 0 ? Math.max(...scores) : -1;
}

function bestMatchingTextBrandKeys(input: string, brands: readonly string[]): Set<string> {
  const matches = brands
    .map((brand) => ({ key: brandKey(brand), score: textBrandMatchScore(input, brand) }))
    .filter(({ score }) => score >= 0);
  const bestScore = Math.max(-1, ...matches.map(({ score }) => score));
  return new Set(matches.filter(({ score }) => score === bestScore).map(({ key }) => key));
}

function yandexBrandTokens(brand: string): string[] {
  const tokens = aliasesForBrand(brand).flatMap((alias) => [
    normalizeForSlug(alias),
    normalizeForSlug(transliterateForYandex(alias))
  ]).filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

function validYandexBatchProof(proof: unknown, sitemaps: string[], brands: string[]): proof is YandexBatchProof {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const value = proof as Partial<YandexBatchProof>;
  if (value.processed !== sitemaps.length || value.firstSitemap !== sitemaps[0] ||
    value.lastSitemap !== sitemaps.at(-1) || !Array.isArray(value.verifiedSitemaps) ||
    value.verifiedSitemaps.length !== sitemaps.length ||
    value.verifiedSitemaps.some((sitemap, index) => sitemap !== sitemaps[index]) ||
    !Array.isArray(value.matches)) return false;
  const tombstonedSitemaps = value.tombstonedSitemaps ?? [];
  if (!Array.isArray(tombstonedSitemaps) || new Set(tombstonedSitemaps).size !== tombstonedSitemaps.length ||
    tombstonedSitemaps.some((sitemap) => typeof sitemap !== "string" ||
      !sitemaps.includes(sitemap) || !isKnownYandexIndexTombstoneSitemap(sitemap))) return false;
  const brandKeys = new Set(brands.map(brandKey));
  const sitemapSet = new Set(sitemaps);
  return value.matches.every((match) => Boolean(match) && typeof match === "object" &&
    typeof match.brand === "string" && brandKeys.has(brandKey(match.brand)) &&
    typeof match.url === "string" && isAllowedProductUrl(match.url) &&
    bestMatchingBrandKeys(match.url, brands).has(brandKey(match.brand)) &&
    typeof match.sitemap === "string" && sitemapSet.has(match.sitemap));
}

function validYandexMarketSearchProof(
  proof: unknown,
  brand: string,
  page: number
): proof is YandexMarketSearchProof {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const value = proof as Partial<YandexMarketSearchProof>;
  if (typeof value.query !== "string" || brandKey(value.query) !== brandKey(brand) ||
    value.page !== page || typeof value.hasNext !== "boolean" || !Array.isArray(value.products)) return false;
  if (value.products.length === 0 && (page !== 1 || value.hasNext)) return false;
  const ids = new Set<string>();
  for (const product of value.products) {
    if (!product || typeof product !== "object" || Array.isArray(product)) return false;
    if (typeof product.id !== "string" || !/^\d+$/.test(product.id) || ids.has(product.id) ||
      typeof product.name !== "string" || !product.name.trim() ||
      typeof product.url !== "string" || !isAllowedMarketSearchCardUrl(product.url, product.id)) return false;
    const hasRatingCount = product.ratingCount !== undefined;
    const hasRating = product.rating !== undefined;
    if (hasRatingCount !== hasRating || hasRatingCount && (
      !Number.isSafeInteger(product.ratingCount) || product.ratingCount! < 0 ||
      typeof product.rating !== "number" || !Number.isFinite(product.rating) || product.rating < 0 || product.rating > 5 ||
      product.ratingCount! > 0 && product.rating === 0
    )) return false;
    if (product.familyId !== undefined && !/^\d{1,40}$/.test(product.familyId)) return false;
    ids.add(product.id);
  }
  return true;
}

function chunked<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
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
    if (extractMarketCardId(value) === listingId) return true;
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

function visibleMarketText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)\s*>/giu, " ")
    .replace(/<[^>]+>/g, " "))
    .normalize("NFKC")
    .replace(/[\s\u00a0\u202f]+/g, " ")
    .trim();
}

function extractMarketCardMetrics(html: string, listingId: string, retainedTitle?: string, brand?: string): {
  title: string;
  rating: number;
  ratingCount: number;
  reviewCount?: number;
} {
  const products = extractJsonLdProducts(html);
  if (products.length > 0) {
    const product = selectJsonLdProduct(products, listingId);
    const sourceTitle = nonEmptyString(product.name);
    const currentTitle = sourceTitle && normalizeForSlug(sourceTitle) && (!brand || matchesBrand(sourceTitle, brand))
      ? sourceTitle
      : undefined;
    const title = currentTitle ?? nonEmptyString(retainedTitle);
    if (!title) throw new ParserChangedError(`Yandex Market card ${listingId} has no usable product title`);
    const aggregate = isObject(product.aggregateRating) ? product.aggregateRating : undefined;
    if (!aggregate) throw new ParserChangedError(`Yandex Market card ${listingId} has no source-bound AggregateRating`);
    const ratingCount = parseNonNegativeInteger(aggregate.ratingCount);
    const reviewCount = parseNonNegativeInteger(aggregate.reviewCount);
    if (ratingCount === undefined) {
      throw new ParserChangedError(`Yandex Market card ${listingId} has no valid ratingCount`);
    }
    if (ratingCount === 0) return { title, rating: 0, ratingCount, reviewCount };
    const rawRating = parseFiniteNumber(aggregate.ratingValue);
    const rawScale = parseFiniteNumber(aggregate.bestRating) ?? 5;
    if (rawRating === undefined || rawScale <= 0 || rawRating < 0 || rawRating > rawScale) {
      throw new ParserChangedError(`Yandex Market card ${listingId} has invalid JSON-LD rating metrics`);
    }
    return {
      title,
      rating: normalizeRating(rawRating, rawScale),
      ratingCount,
      ...(reviewCount === undefined ? {} : { reviewCount })
    };
  }
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/iu.exec(html);
  const title = heading ? visibleMarketText(heading[1]) : "";
  if (!title) throw new ParserChangedError(`Yandex Market card ${listingId} has no product heading`);
  const afterHeading = html.slice((heading?.index ?? 0) + (heading?.[0].length ?? 0), (heading?.index ?? 0) + 250_000);
  let rawRating: number | undefined;
  let rawScale: number | undefined;
  let ratingCount: number | undefined;
  for (const match of afterHeading.matchAll(/<[^>]+\baria-label\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/giu)) {
    const aria = htmlAttribute(match[0], "aria-label");
    const rating = aria?.match(/Рейтинг\s+товара\s*:\s*([\d.,]+)\s+из\s+([\d.,]+)/iu);
    if (!rating) continue;
    rawRating = parseFiniteNumber(rating[1]);
    rawScale = parseFiniteNumber(rating[2]);
    const snippet = visibleMarketText(afterHeading.slice(match.index, match.index + 4_000));
    ratingCount = parseNonNegativeInteger(snippet.match(/\(([\d\s\u00a0\u202f]+)\)/u)?.[1]);
    break;
  }
  const visible = visibleMarketText(afterHeading);
  ratingCount ??= parseNonNegativeInteger(visible.match(
    /(?<![\p{L}\p{N}])([\d\s\u00a0\u202f]+)\s+оцен(?:ка|ки|ок)(?![\p{L}\p{N}])/iu
  )?.[1]);
  const reviewCount = parseNonNegativeInteger(visible.match(
    /(?<![\p{L}\p{N}])([\d\s\u00a0\u202f]+)\s+отзыв(?:а|ов)?(?![\p{L}\p{N}])/iu
  )?.[1]);
  if (ratingCount === undefined) {
    const explicitEmpty = /(?:0\s+оцен|оценок\s+(?:пока\s+)?нет)/iu.test(visible) &&
      /(?:0\s+отзыв|отзывов\s+(?:пока\s+)?нет)/iu.test(visible);
    if (explicitEmpty) return { title, rating: 0, ratingCount: 0, reviewCount: 0 };
    throw new ParserChangedError(`Yandex Market card ${listingId} has no source-bound rating count`);
  }
  if (ratingCount === 0) return { title, rating: 0, ratingCount, reviewCount };
  if (rawRating === undefined || rawScale === undefined || rawScale <= 0 || rawRating < 0 || rawRating > rawScale) {
    throw new ParserChangedError(`Yandex Market card ${listingId} has invalid visible rating metrics`);
  }
  return {
    title,
    rating: normalizeRating(rawRating, rawScale),
    ratingCount,
    ...(reviewCount === undefined ? {} : { reviewCount })
  };
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
