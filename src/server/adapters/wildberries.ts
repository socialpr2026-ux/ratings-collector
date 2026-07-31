import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { matchesBrand } from "../utils/normalize.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

// The buyer v18 route currently rate-limits ordinary cloud/static egress even
// when the same bounded query succeeds through v14 with an identical product
// schema. Keep the free JSON route first so a run does not need Sandbox or the
// paid Apify fallback merely because one endpoint generation is throttled.
const SEARCH_ENDPOINTS = [
  "https://search.wb.ru/exactmatch/ru/common/v14/search",
  "https://search.wb.ru/exactmatch/ru/common/v18/search"
] as const;
const CARD_ENDPOINT = "https://card.wb.ru/cards/v4/detail";
const FEEDBACK_ENDPOINT = "https://feedbacks1.wb.ru/feedbacks/v2";
const MOSCOW_DESTINATION = "-1257786";
const PLATFORM_ID = "wildberries";
const PLATFORM_DOMAIN = "wildberries.ru";
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_DIRECT_APP_TYPES = [1, 32, 64] as const;
const DEFAULT_BROWSER_APP_TYPE = 32;
const DEFAULT_BLOCKED_RETRY_BASE_MS = 100;
const DEFAULT_BLOCKED_COOLDOWN_MS = 30_000;
const MAX_BLOCKED_RETRY_DELAY_MS = 150;
const MAX_BLOCKED_RETRY_TOTAL_MS = 1_200;
const MAX_CARD_INFO_BYTES = 256_000;
const MAX_CARD_BATCH_SIZE = 100;
const TRANSIENT_BLOCK_STATUSES = new Set([403, 407, 423, 429, 498, 502, 503, 504]);

// Wildberries stores the nm-specific product description on its public basket
// CDN. The buyer APIs intentionally shorten long names with an ellipsis, which
// can remove the package count even though it is explicit on the product page.
// These are the current storefront volume boundaries; after basket 36 the
// allocation continues in 312-volume blocks.
const BASKET_VOLUME_LIMITS = [
  143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919,
  2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485, 3701, 3917, 4133, 4349,
  4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997
] as const;

const EXPLICIT_PACKAGE_COUNT = /(?:№|#|\bN(?:o)?\.?)\s*(\d{1,4})(?!\d)|(?<!\d)(\d{1,4})\s*(?:шт(?:\.|ук[аи]?)?|таблет(?:ок|ки|ка)?|капсул(?:а|ы)?|ампул(?:а|ы)?|флакон(?:а|ов|ы)?|саше|пакет(?:а|ов|ы)?|доз(?:а|ы)?)(?![\p{L}\p{N}])/iu;
const TRUNCATED_TITLE = /(?:…|\.\.\.)\s*$/u;

type JsonObject = Record<string, unknown>;

type ProductPage = {
  products: JsonObject[];
  total?: number;
};

type SearchProductPage = ProductPage & { evidenceUrl: string };

type DiscoveryBatchPlan = {
  refs: ProductRef[];
  promise?: Promise<void>;
};

type DistributionMetrics = {
  ratingCount: number;
  rating: number;
};

export type WildberriesAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  /** Test/embedding override. `false` disables optional title enrichment. */
  productInfoFetch?: typeof globalThis.fetch | false;
  maxPages?: number;
  requestIntervalMs?: number;
  searchEndpoint?: string;
  cardEndpoint?: string;
  destination?: string;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  directAppTypes?: readonly number[];
  browserFallbackAppType?: number | false;
  blockedRetryBaseMs?: number;
  blockedCooldownMs?: number;
};

type RequestRoute = {
  appType: string;
  browser: boolean;
  searchEndpoint?: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const id = String(value).trim();
  return /^\d+$/.test(id) && id !== "0" ? id : undefined;
}

function asNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function firstDefinedNumber(record: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstDefinedInteger(record: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asNonnegativeInteger(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstDefinedId(record: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asId(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function exactFirstPartyIdentity(product: JsonObject, title: string, brand: string): {
  matches: boolean;
  sourceBrand?: string;
} {
  const sourceBrand = asNonemptyString(product.brand);
  return {
    matches: matchesBrand(title, brand) || Boolean(sourceBrand && matchesBrand(sourceBrand, brand)),
    ...(sourceBrand ? { sourceBrand } : {})
  };
}

function distributionMetrics(value: unknown): DistributionMetrics | undefined {
  if (!isObject(value)) return undefined;
  let ratingCount = 0;
  let weightedTotal = 0;
  for (let score = 1; score <= 5; score += 1) {
    const count = asNonnegativeInteger(value[String(score)]);
    if (count === undefined) return undefined;
    ratingCount += count;
    weightedTotal += count * score;
  }
  if (ratingCount === 0) return undefined;
  return {
    ratingCount,
    rating: Math.round((weightedTotal / ratingCount) * 10) / 10
  };
}

function parseProductPage(payload: unknown): ProductPage {
  if (!isObject(payload)) {
    throw new ParserChangedError("Wildberries returned a non-object payload");
  }

  const data = isObject(payload.data) ? payload.data : undefined;
  const productsValue = payload.products ?? data?.products;
  if (!Array.isArray(productsValue)) {
    throw new ParserChangedError("Wildberries response no longer contains a products array");
  }

  const products = productsValue.filter(isObject);
  if (products.length !== productsValue.length) {
    throw new ParserChangedError("Wildberries products array contains an unexpected value");
  }

  const metadata = isObject(payload.metadata) ? payload.metadata : undefined;
  const dataMetadata = data && isObject(data.metadata) ? data.metadata : undefined;
  const total =
    asNonnegativeInteger(payload.total) ??
    (data ? asNonnegativeInteger(data.total) : undefined) ??
    (metadata ? asNonnegativeInteger(metadata.total) : undefined) ??
    (dataMetadata ? asNonnegativeInteger(dataMetadata.total) : undefined);

  return { products, total };
}

function isAntiBotPayload(body: string): boolean {
  return /captcha|proof[\s_-]*of[\s_-]*work|wb[\s_-]*(?:antibot|challenge)|["'](?:pow|challenge)["']\s*:/i.test(
    body
  );
}

function canonicalProductUrl(listingId: string): string {
  return `https://www.wildberries.ru/catalog/${listingId}/detail.aspx`;
}

function basketNumber(listingId: string): number | undefined {
  const numericId = Number(listingId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return undefined;
  const volume = Math.floor(numericId / 100_000);
  const boundedIndex = BASKET_VOLUME_LIMITS.findIndex((limit) => volume <= limit);
  if (boundedIndex >= 0) return boundedIndex + 1;
  return 37 + Math.floor((volume - 7_998) / 312);
}

function cardInfoUrls(listingId: string): URL[] {
  const basket = basketNumber(listingId);
  if (basket === undefined || basket < 1 || basket > 99) return [];
  const numericId = Number(listingId);
  const volume = Math.floor(numericId / 100_000);
  const part = Math.floor(numericId / 1_000);
  // Adjacent baskets are a bounded compatibility fallback at a volume
  // boundary. A response is accepted only when its nm_id equals listingId.
  const candidates = [basket, basket - 1, basket + 1]
    .filter((value, index, values) => value >= 1 && value <= 99 && values.indexOf(value) === index);
  return candidates.map((value) => new URL(
    `https://basket-${String(value).padStart(2, "0")}.wbbasket.ru/vol${volume}/part${part}/${listingId}/info/ru/card.json`
  ));
}

function hasExplicitPackageCount(value: string): boolean {
  const match = value.match(EXPLICIT_PACKAGE_COUNT);
  return Boolean(match && Number(match[1] ?? match[2]) > 1);
}

function strictOptionPackageCount(payload: JsonObject): number | undefined {
  if (!Array.isArray(payload.options)) return undefined;
  for (const item of payload.options) {
    if (!isObject(item)) continue;
    const name = asNonemptyString(item.name);
    const value = asNonemptyString(item.value);
    if (!name || !value) continue;
    if (!/(?:количество|фасовка)/iu.test(name) ||
      !/(?:капсул|таблет|предмет|штук|ампул|флакон|саше|пакет|доз|упаков)/iu.test(name)) continue;
    const match = value.match(/^\s*(\d{1,4})\s*(?:шт(?:\.|ук[аи]?)?|таблет(?:ок|ки|ка)?|капсул(?:а|ы)?|ампул(?:а|ы)?|флакон(?:а|ов|ы)?|саше|пакет(?:а|ов|ы)?|доз(?:а|ы)?)?\s*$/iu);
    if (!match) continue;
    const count = Number(match[1]);
    if (Number.isInteger(count) && count > 1) return count;
  }
  return undefined;
}

function exactCardInfoTitle(payload: unknown, listingId: string, brand: string): string | undefined {
  if (!isObject(payload) || firstDefinedId(payload, ["nm_id", "nmId", "id"]) !== listingId) return undefined;
  let title = asNonemptyString(payload.imt_name) ?? asNonemptyString(payload.name);
  if (!title || TRUNCATED_TITLE.test(title) || !matchesBrand(title, brand)) return undefined;
  if (!hasExplicitPackageCount(title)) {
    const count = strictOptionPackageCount(payload);
    if (count !== undefined) title = `${title} №${count}`;
  }
  return title;
}

function preferProductTitle(primary: string, alternative: string | undefined): string {
  if (!alternative) return primary;
  const primaryCount = hasExplicitPackageCount(primary);
  const alternativeCount = hasExplicitPackageCount(alternative);
  if (alternativeCount && !primaryCount) return alternative;
  if (primaryCount && !alternativeCount) return primary;
  if (TRUNCATED_TITLE.test(primary) && !TRUNCATED_TITLE.test(alternative)) return alternative;
  return primary;
}

function previousListingId(value: string): string | undefined {
  const match = value.trim().match(/^(?:(?:wildberries|wildberries\.ru):)?(\d+)$/i);
  return match ? asId(match[1]) : undefined;
}

function metadataNumber(metadata: ProductRef["metadata"], key: string): number | undefined {
  return asFiniteNumber(metadata[key]);
}

function metadataInteger(metadata: ProductRef["metadata"], key: string): number | undefined {
  return asNonnegativeInteger(metadata[key]);
}

function metadataId(metadata: ProductRef["metadata"], key: string): string | undefined {
  return asId(metadata[key]);
}

function metadataString(metadata: ProductRef["metadata"], key: string): string | undefined {
  return asNonemptyString(metadata[key]);
}

function exactSearchFallbackCard(ref: ProductRef): JsonObject | undefined {
  const evidenceUrl = metadataString(ref.metadata, "searchEvidenceUrl");
  const title = asNonemptyString(ref.title);
  if (!evidenceUrl || !title || TRUNCATED_TITLE.test(title) || !matchesBrand(title, ref.brand)) return undefined;
  let url: URL;
  try { url = new URL(evidenceUrl); }
  catch { return undefined; }
  const normalizedQuery = url.searchParams.get("query")?.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
  if (url.protocol !== "https:" || url.hostname !== "search.wb.ru" || ![
    "/exactmatch/ru/common/v14/search",
    "/exactmatch/ru/common/v18/search"
  ].includes(url.pathname) || normalizedQuery !== ref.brand.normalize("NFKC").trim().toLocaleLowerCase("ru-RU")) {
    return undefined;
  }
  const rootId = metadataId(ref.metadata, "rootId");
  const nmFeedbacks = metadataInteger(ref.metadata, "nmFeedbacks");
  const nmReviewRating = metadataNumber(ref.metadata, "nmReviewRating");
  const hasNmMetrics = nmFeedbacks !== undefined && nmReviewRating !== undefined &&
    nmReviewRating >= 0 && nmReviewRating <= 5 && (nmFeedbacks === 0 || nmReviewRating > 0);
  if (!hasNmMetrics && !rootId) return undefined;
  const sourceBrand = metadataString(ref.metadata, "sourceBrand");
  return {
    id: ref.listingId,
    name: title,
    ...(sourceBrand ? { brand: sourceBrand } : {}),
    ...(rootId ? { root: rootId } : {}),
    ...(hasNmMetrics ? { nmFeedbacks, nmReviewRating } : {}),
    ...(metadataInteger(ref.metadata, "groupFeedbacks") !== undefined
      ? { feedbacks: metadataInteger(ref.metadata, "groupFeedbacks") }
      : {}),
    ...(metadataNumber(ref.metadata, "groupReviewRating") !== undefined
      ? { reviewRating: metadataNumber(ref.metadata, "groupReviewRating") }
      : {}),
    searchFallback: true
  };
}

function observationFromSearchMetadata(
  ref: ProductRef,
  listingId: string,
  capturedAt: string
): Observation | undefined {
  const source = metadataString(ref.metadata, "source");
  if (!source?.startsWith("wildberries-")) return undefined;

  const title = asNonemptyString(ref.title);
  const reviews = metadataInteger(ref.metadata, "resolvedFeedbackCount") ??
    metadataInteger(ref.metadata, "nmFeedbacks");
  const rawRating = metadataNumber(ref.metadata, "resolvedRating") ??
    metadataNumber(ref.metadata, "nmReviewRating");
  const ratingCount = metadataInteger(ref.metadata, "ratingCount");
  const writtenReviewCount = metadataInteger(ref.metadata, "writtenReviewCount");
  const aggregateGroupId = metadataString(ref.metadata, "aggregateGroupId");
  const ratingIsValid = rawRating !== undefined && rawRating >= 0 && rawRating <= 5;
  if (!title || reviews === undefined || !ratingIsValid || (reviews > 0 && rawRating === 0)) {
    return undefined;
  }

  const sourceBrand = metadataString(ref.metadata, "sourceBrand");
  const brandMatches = matchesBrand(title, ref.brand) || Boolean(sourceBrand && matchesBrand(sourceBrand, ref.brand));
  const rating = reviews === 0 ? null : rawRating;
  return {
    domain: PLATFORM_DOMAIN,
    platform: PLATFORM_ID,
    listingId,
    brand: ref.brand,
    canonicalUrl: canonicalProductUrl(listingId),
    product: title,
    reviews,
    ...(writtenReviewCount !== undefined ? { writtenReviewCount } : {}),
    rating,
    ...(ratingCount !== undefined ? { ratingCount } : {}),
    ...(rating !== null ? { rawRating: rating, rawRatingScale: 5 } : {}),
    status: brandMatches ? (reviews === 0 ? "no_reviews" : "ok") : "needs_review",
    capturedAt,
    ...(metadataId(ref.metadata, "rootId") ? { groupId: metadataId(ref.metadata, "rootId") } : {}),
    ...(aggregateGroupId ? { aggregateGroupId } : {}),
    ...(metadataString(ref.metadata, "evidenceRef") ? { evidenceRef: metadataString(ref.metadata, "evidenceRef") } : {}),
    source
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WildberriesAdapter implements SiteAdapter {
  readonly id = PLATFORM_ID;
  readonly supportedDomains = [PLATFORM_DOMAIN, "www.wildberries.ru"] as const;

  private readonly injectedFetch?: typeof globalThis.fetch;
  private readonly productInfoFetchOverride?: typeof globalThis.fetch | false;
  private readonly maxPages: number;
  private readonly requestIntervalMs: number;
  private readonly searchEndpoints: readonly string[];
  private readonly cardEndpoint: string;
  private readonly destination: string;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly directAppTypes: readonly string[];
  private readonly browserFallbackAppType?: string;
  private readonly blockedRetryBaseMs: number;
  private readonly blockedCooldownMs: number;
  private preferredRoute: RequestRoute;
  private blockedUntil = 0;
  private blockedMessage?: string;
  private requestTail: Promise<void> = Promise.resolve();
  private hasMadeRequest = false;
  private readonly discoveryCache = new Map<string, Promise<ProductRef[]>>();
  private readonly discoveryBatchPlans = new Map<string, DiscoveryBatchPlan>();
  private nextDiscoveryBatchId = 0;

  constructor(options: WildberriesAdapterOptions = {}) {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error("Wildberries maxPages must be a positive integer");
    }
    if ((options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS) < 0) {
      throw new Error("Wildberries requestIntervalMs cannot be negative");
    }
    const directAppTypes = options.directAppTypes ?? DEFAULT_DIRECT_APP_TYPES;
    if (
      directAppTypes.length === 0 ||
      directAppTypes.some((value) => !Number.isInteger(value) || value < 1 || value > 10_000)
    ) {
      throw new Error("Wildberries directAppTypes must contain positive integer application IDs");
    }
    const browserFallbackAppType = options.browserFallbackAppType ?? DEFAULT_BROWSER_APP_TYPE;
    if (
      browserFallbackAppType !== false &&
      (!Number.isInteger(browserFallbackAppType) || browserFallbackAppType < 1 || browserFallbackAppType > 10_000)
    ) {
      throw new Error("Wildberries browserFallbackAppType must be false or a positive integer");
    }
    const blockedRetryBaseMs = options.blockedRetryBaseMs ?? DEFAULT_BLOCKED_RETRY_BASE_MS;
    if (!Number.isFinite(blockedRetryBaseMs) || blockedRetryBaseMs < 0 || blockedRetryBaseMs > 10_000) {
      throw new Error("Wildberries blockedRetryBaseMs must be between 0 and 10000");
    }
    const blockedCooldownMs = options.blockedCooldownMs ?? DEFAULT_BLOCKED_COOLDOWN_MS;
    if (!Number.isFinite(blockedCooldownMs) || blockedCooldownMs < 0 || blockedCooldownMs > 300_000) {
      throw new Error("Wildberries blockedCooldownMs must be between 0 and 300000");
    }

    this.injectedFetch = options.fetch;
    this.productInfoFetchOverride = options.productInfoFetch;
    this.maxPages = maxPages;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    // An explicitly injected endpoint keeps fixtures/local overrides isolated.
    // Production exhausts both currently supported buyer API generations: WB
    // can rate-limit v14 and v18 independently for the same bounded query.
    this.searchEndpoints = options.searchEndpoint ? [options.searchEndpoint] : SEARCH_ENDPOINTS;
    this.cardEndpoint = options.cardEndpoint ?? CARD_ENDPOINT;
    this.destination = options.destination ?? MOSCOW_DESTINATION;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.directAppTypes = [...new Set(directAppTypes.map(String))];
    this.browserFallbackAppType = browserFallbackAppType === false ? undefined : String(browserFallbackAppType);
    this.blockedRetryBaseMs = blockedRetryBaseMs;
    this.blockedCooldownMs = blockedCooldownMs;
    this.preferredRoute = { appType: this.directAppTypes[0], browser: false };
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    try {
      await this.fetchSearchPage("Арбидол", 1, context);
      return {
        ok: true,
        checkedAt: this.now().toISOString(),
        message: "Wildberries search schema is valid"
      };
    } catch (error) {
      return {
        ok: false,
        checkedAt: this.now().toISOString(),
        message: errorMessage(error)
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const cacheKey = this.discoveryCacheKey(brand, context);
    const cached = cacheKey ? this.discoveryCache.get(cacheKey) : undefined;
    if (cached) return cached;

    const discovery = this.discoverUncached(brand, context);
    if (cacheKey) {
      this.discoveryCache.set(cacheKey, discovery);
      while (this.discoveryCache.size > 64) {
        const oldest = this.discoveryCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.discoveryCache.delete(oldest);
      }
    }

    try {
      return await discovery;
    } catch (error) {
      // A blocked or malformed response must remain retryable. Only a proven,
      // successful discovery is reusable within the same run.
      if (cacheKey && this.discoveryCache.get(cacheKey) === discovery) {
        this.discoveryCache.delete(cacheKey);
      }
      throw error;
    }
  }

  private async discoverUncached(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const byListingId = new Map<string, ProductRef>();
    let rawProductsSeen = 0;
    let previousPageIds: string | undefined;
    let exhaustionProven = false;

    for (let page = 1; page <= this.maxPages; page += 1) {
      const result = await this.fetchSearchPage(brand, page, context);
      if (result.products.length === 0) {
        if (rawProductsSeen === 0 && result.total === undefined) {
          throw new AdapterBlockedError(
            `Wildberries returned an empty first page without an explicit total for ${brand}; zero results are not proven`
          );
        }
        if (result.total !== undefined && rawProductsSeen < result.total) {
          throw new AdapterBlockedError(
            `Wildberries returned an empty page after ${rawProductsSeen} of ${result.total} advertised products for ${brand}`
          );
        }
        exhaustionProven = true;
        break;
      }

      rawProductsSeen += result.products.length;
      const pageIds = result.products
        .map((product) => firstDefinedId(product, ["id", "nmId", "nmID"]) ?? "?")
        .join(",");

      // Some anti-bot fallbacks repeat page 1 forever while still returning HTTP 200.
      if (previousPageIds !== undefined && pageIds === previousPageIds) {
        throw new AdapterBlockedError(
          `Wildberries repeated an identical search page for ${brand}; result exhaustion is not proven`
        );
      }
      previousPageIds = pageIds;

      for (const product of result.products) {
        const listingId = firstDefinedId(product, ["id", "nmId", "nmID"]);
        const title = asNonemptyString(product.name) ?? asNonemptyString(product.title);
        if (!listingId || !title) continue;
        const identity = exactFirstPartyIdentity(product, title, brand);
        if (!identity.matches) continue;
        if (byListingId.has(listingId)) continue;

        const groupId = firstDefinedId(product, ["root", "rootId", "imtId", "imtID"]);
        const nmReviewRating = firstDefinedNumber(product, ["nmReviewRating"]);
        const nmFeedbacks = firstDefinedInteger(product, ["nmFeedbacks"]);
        const groupReviewRating = firstDefinedNumber(product, ["reviewRating", "rating"]);
        const groupFeedbacks = firstDefinedInteger(product, ["feedbacks"]);

        byListingId.set(listingId, {
          domain: PLATFORM_DOMAIN,
          platform: PLATFORM_ID,
          listingId,
          brand,
          url: canonicalProductUrl(listingId),
          title,
          metadata: {
            source: "wildberries-search-v18",
            ...(identity.sourceBrand ? { sourceBrand: identity.sourceBrand } : {}),
            ...(groupId ? { rootId: groupId } : {}),
            ...(nmReviewRating !== undefined ? { nmReviewRating } : {}),
            ...(nmFeedbacks !== undefined ? { nmFeedbacks } : {}),
            ...(groupReviewRating !== undefined ? { groupReviewRating } : {}),
            ...(groupFeedbacks !== undefined ? { groupFeedbacks } : {}),
            searchEvidenceUrl: result.evidenceUrl
          }
        });
      }

      if (result.total !== undefined && rawProductsSeen >= result.total) {
        exhaustionProven = true;
        break;
      }
    }

    if (!exhaustionProven) {
      throw new AdapterBlockedError(
        `Wildberries search for ${brand} reached the ${this.maxPages}-page safety limit without proving exhaustion`
      );
    }

    this.registerDiscoveryBatch([...byListingId.values()], brand, context);

    for (const previousId of context.previousIds ?? []) {
      const listingId = previousListingId(previousId);
      if (!listingId || byListingId.has(listingId)) continue;
      byListingId.set(listingId, {
        domain: PLATFORM_DOMAIN,
        platform: PLATFORM_ID,
        listingId,
        brand,
        url: canonicalProductUrl(listingId),
        metadata: { source: "previous-registry" }
      });
    }

    return [...byListingId.values()];
  }

  private registerDiscoveryBatch(refs: ProductRef[], brand: string, context: AdapterContext): void {
    if (refs.length === 0) return;
    if (this.discoveryBatchPlans.size >= 64) {
      throw new AdapterBlockedError("Wildberries has too many pending card-verification batches");
    }
    const runScope = context.runId?.trim() || "adhoc";
    const normalizedBrand = brand.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
    const batchKey = `${runScope}\u001e${normalizedBrand}\u001e${++this.nextDiscoveryBatchId}`;
    for (const ref of refs) ref.metadata.discoveryBatchKey = batchKey;
    this.discoveryBatchPlans.set(batchKey, { refs });
  }

  private async ensureDiscoveryBatch(ref: ProductRef, context: AdapterContext): Promise<void> {
    const batchKey = metadataString(ref.metadata, "discoveryBatchKey");
    if (!batchKey || ref.metadata.cardBatchVerified === true) return;
    const plan = this.discoveryBatchPlans.get(batchKey);
    if (!plan) {
      throw new ParserChangedError(`Wildberries card-verification batch ${batchKey} is unavailable`);
    }
    const verification = plan.promise ?? this.verifyDiscoveredCards(plan.refs, context);
    plan.promise = verification;
    try {
      await verification;
      // Product refs can cross a repository/checkpoint boundary between
      // discovery and collection. Rehydrate the verified source-bound fields
      // from the retained batch instead of assuming object identity.
      const verified = plan.refs.find((item) => item.listingId === ref.listingId);
      if (!verified || verified.metadata.cardBatchVerified !== true) {
        throw new ParserChangedError(`Wildberries card-verification batch ${batchKey} did not verify ${ref.listingId}`);
      }
      ref.title = verified.title;
      ref.url = verified.url;
      ref.metadata = { ...ref.metadata, ...verified.metadata };
    } catch (error) {
      if (plan.promise === verification) plan.promise = undefined;
      throw error;
    }
  }

  private async verifyDiscoveredCards(refs: ProductRef[], context: AdapterContext): Promise<void> {
    const cards = new Map<string, { product: JsonObject; evidenceRef: string }>();
    for (let offset = 0; offset < refs.length; offset += MAX_CARD_BATCH_SIZE) {
      const chunk = refs.slice(offset, offset + MAX_CARD_BATCH_SIZE);
      const expected = new Set(chunk.map((ref) => ref.listingId));
      const { page, evidenceUrl } = await this.fetchCardBatch([...expected], context);
      for (const product of page.products) {
        const listingId = firstDefinedId(product, ["id", "nmId", "nmID"]);
        if (!listingId || !expected.has(listingId)) {
          throw new ParserChangedError("Wildberries card batch returned an unexpected nmId");
        }
        if (cards.has(listingId)) {
          throw new ParserChangedError(`Wildberries card batch returned duplicate nmId ${listingId}`);
        }
        cards.set(listingId, { product, evidenceRef: evidenceUrl });
      }
      const missing = [...expected].filter((listingId) => !cards.has(listingId));
      for (const listingId of missing) {
        const { page: singleton, evidenceUrl: singletonEvidenceUrl } = await this.fetchCard(listingId, context);
        for (const product of singleton.products) {
          const returnedId = firstDefinedId(product, ["id", "nmId", "nmID"]);
          if (returnedId !== listingId || cards.has(returnedId)) {
            throw new ParserChangedError(`Wildberries singleton card request returned unexpected nmId ${returnedId ?? "unknown"}`);
          }
          cards.set(listingId, { product, evidenceRef: singletonEvidenceUrl });
        }
      }
      const stillMissing = missing.filter((listingId) => !cards.has(listingId));
      for (const listingId of stillMissing) {
        const ref = chunk.find((candidate) => candidate.listingId === listingId);
        const fallback = ref ? exactSearchFallbackCard(ref) : undefined;
        if (!fallback) continue;
        cards.set(listingId, {
          product: fallback,
          evidenceRef: metadataString(ref!.metadata, "searchEvidenceUrl")!
        });
      }
      const unproven = stillMissing.filter((listingId) => !cards.has(listingId));
      if (unproven.length > 0) {
        throw new AdapterBlockedError(
          `Wildberries card batch, singleton retry and exact search fallback omitted ${unproven.length} requested nmIds: ${unproven.join(",")}`
        );
      }
    }

    const refsByRoot = new Map<string, ProductRef[]>();
    const missingNmMetricsByRoot = new Map<string, ProductRef[]>();
    for (const ref of refs) {
      const card = cards.get(ref.listingId);
      if (!card) throw new AdapterBlockedError(`Wildberries card batch omitted requested nmId ${ref.listingId}`);
      const title = asNonemptyString(card.product.name) ?? asNonemptyString(card.product.title);
      if (!title) throw new ParserChangedError(`Wildberries card ${ref.listingId} has no first-party title`);
      const identity = exactFirstPartyIdentity(card.product, title, ref.brand);
      if (!identity.matches) {
        throw new ParserChangedError(`Wildberries card ${ref.listingId} no longer proves brand ${ref.brand}`);
      }
      const rootId = firstDefinedId(card.product, ["root", "rootId", "imtId", "imtID"]);
      const feedbackCount = firstDefinedInteger(card.product, ["nmFeedbacks"]);
      const rating = firstDefinedNumber(card.product, ["nmReviewRating"]);
      const hasValidNmMetrics = feedbackCount !== undefined && rating !== undefined && rating >= 0 && rating <= 5 &&
        (feedbackCount === 0 || rating > 0);
      if (!hasValidNmMetrics && !rootId) {
        throw new ParserChangedError(
          `Wildberries card ${ref.listingId} has invalid nm-specific metrics and no root proof route`
        );
      }

      ref.title = title;
      ref.metadata = {
        ...ref.metadata,
        source: card.product.searchFallback === true
          ? "wildberries-search-exact-fallback"
          : "wildberries-card-v4-batch",
        ...(identity.sourceBrand ? { sourceBrand: identity.sourceBrand } : {}),
        ...(rootId ? { rootId } : {}),
        evidenceRef: card.evidenceRef
      };
      delete ref.metadata.nmFeedbacks;
      delete ref.metadata.nmReviewRating;
      delete ref.metadata.cardNmFeedbacks;
      delete ref.metadata.cardNmReviewRating;
      delete ref.metadata.resolvedFeedbackCount;
      delete ref.metadata.resolvedRating;
      delete ref.metadata.ratingCount;
      delete ref.metadata.writtenReviewCount;
      delete ref.metadata.aggregateGroupId;
      if (hasValidNmMetrics) {
        ref.metadata.nmFeedbacks = feedbackCount;
        ref.metadata.nmReviewRating = rating;
        ref.metadata.cardNmFeedbacks = feedbackCount;
        ref.metadata.cardNmReviewRating = rating;
      } else {
        const missing = missingNmMetricsByRoot.get(rootId!) ?? [];
        missing.push(ref);
        missingNmMetricsByRoot.set(rootId!, missing);
      }

      if (rootId) {
        const members = refsByRoot.get(rootId) ?? [];
        members.push(ref);
        refsByRoot.set(rootId, members);
      }
    }

    for (const [rootId, members] of refsByRoot) {
      const missingNmMetrics = missingNmMetricsByRoot.get(rootId);
      if (missingNmMetrics?.length) {
        await this.resolveRequiredRootNmMetrics(rootId, missingNmMetrics, context);
      }
      const byFingerprint = new Map<string, ProductRef[]>();
      for (const member of members) {
        const feedbackCount = metadataInteger(member.metadata, "nmFeedbacks");
        const rating = metadataNumber(member.metadata, "nmReviewRating");
        if (feedbackCount === undefined || feedbackCount === 0 || rating === undefined) continue;
        const fingerprint = `${feedbackCount}:${rating}`;
        const duplicates = byFingerprint.get(fingerprint) ?? [];
        duplicates.push(member);
        byFingerprint.set(fingerprint, duplicates);
      }
      const duplicatedMembers = [...new Set(
        [...byFingerprint.values()].filter((items) => items.length > 1).flat()
      )];
      if (duplicatedMembers.length > 1) {
        await this.resolveRootMetrics(rootId, members, duplicatedMembers, context);
      }
    }

    for (const ref of refs) ref.metadata.cardBatchVerified = true;
  }

  private async resolveRequiredRootNmMetrics(
    rootId: string,
    requiredMembers: ProductRef[],
    context: AdapterContext
  ): Promise<void> {
    const { payload, evidenceUrl } = await this.fetchRootFeedback(rootId, context);
    if (!isObject(payload) || !Array.isArray(payload.nmValuationDistribution) ||
      payload.nmValuationDistribution.length === 0) {
      throw new ParserChangedError(`Wildberries root ${rootId} has no exact nm distribution`);
    }
    const byListingId = new Map<string, DistributionMetrics>();
    for (const item of payload.nmValuationDistribution) {
      if (!isObject(item)) throw new ParserChangedError(`Wildberries root ${rootId} has malformed nm distribution`);
      const listingId = firstDefinedId(item, ["nm", "nmId", "nmID"]);
      const metrics = distributionMetrics(item.valuationDistribution);
      if (!listingId || !metrics || byListingId.has(listingId)) {
        throw new ParserChangedError(`Wildberries root ${rootId} has invalid nm distribution`);
      }
      byListingId.set(listingId, metrics);
    }
    const missing = requiredMembers.filter((member) => !byListingId.has(member.listingId));
    if (missing.length > 0) {
      throw new ParserChangedError(
        `Wildberries root ${rootId} does not contain exact nm distribution for ${missing.map(({ listingId }) => listingId).join(",")}`
      );
    }
    for (const member of requiredMembers) {
      const metrics = byListingId.get(member.listingId)!;
      member.metadata.resolvedFeedbackCount = metrics.ratingCount;
      member.metadata.ratingCount = metrics.ratingCount;
      member.metadata.resolvedRating = metrics.rating;
      member.metadata.source = "wildberries-root-nm-distribution";
      member.metadata.evidenceRef = evidenceUrl;
      delete member.metadata.aggregateGroupId;
    }
  }

  private async resolveRootMetrics(
    rootId: string,
    members: ProductRef[],
    duplicatedMembers: ProductRef[],
    context: AdapterContext
  ): Promise<void> {
    const { payload, evidenceUrl } = await this.fetchRootFeedback(rootId, context);
    if (!isObject(payload)) throw new ParserChangedError(`Wildberries root ${rootId} returned a non-object payload`);

    const applySharedAggregate = () => {
      const feedbackCount = asNonnegativeInteger(payload.feedbackCount);
      const rating = asFiniteNumber(payload.valuation);
      if (feedbackCount === undefined || rating === undefined || rating < 0 || rating > 5 ||
        (feedbackCount > 0 && rating === 0)) {
        throw new ParserChangedError(`Wildberries root ${rootId} has no valid shared aggregate`);
      }
      const rootDistribution = distributionMetrics(payload.valuationDistribution);
      for (const member of members) {
        member.metadata.resolvedFeedbackCount = feedbackCount;
        member.metadata.writtenReviewCount = feedbackCount;
        if (rootDistribution) member.metadata.ratingCount = rootDistribution.ratingCount;
        member.metadata.resolvedRating = feedbackCount === 0 ? 0 : rating;
        member.metadata.aggregateGroupId = `wildberries:root:${rootId}`;
        member.metadata.source = "wildberries-root-family-aggregate";
        member.metadata.evidenceRef = evidenceUrl;
      }
    };

    const distributions = payload.nmValuationDistribution;
    if (Array.isArray(distributions) && distributions.length > 0) {
      const byListingId = new Map<string, DistributionMetrics>();
      for (const item of distributions) {
        if (!isObject(item)) throw new ParserChangedError(`Wildberries root ${rootId} has malformed nm distribution`);
        const listingId = firstDefinedId(item, ["nm", "nmId", "nmID"]);
        const metrics = distributionMetrics(item.valuationDistribution);
        if (!listingId || !metrics || byListingId.has(listingId)) {
          throw new ParserChangedError(`Wildberries root ${rootId} has invalid nm distribution`);
        }
        byListingId.set(listingId, metrics);
      }
      const missing = duplicatedMembers.filter((member) => !byListingId.has(member.listingId));
      if (missing.length > 0) {
        // A root can expose a valid family aggregate while omitting the
        // per-nm distribution for one of its variants. Publish that source-
        // bound aggregate once instead of duplicating or inventing SKU data.
        applySharedAggregate();
        return;
      }
      for (const member of members) {
        const metrics = byListingId.get(member.listingId);
        if (!metrics) continue;
        member.metadata.resolvedFeedbackCount = metrics.ratingCount;
        member.metadata.ratingCount = metrics.ratingCount;
        member.metadata.resolvedRating = metrics.rating;
        member.metadata.source = "wildberries-root-nm-distribution";
        member.metadata.evidenceRef = evidenceUrl;
        delete member.metadata.aggregateGroupId;
      }
      return;
    }

    applySharedAggregate();
  }

  private discoveryCacheKey(brand: string, context: AdapterContext): string | undefined {
    const runId = context.runId?.trim();
    if (!runId) return undefined;
    const normalizedBrand = brand.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
    const previousIds = [...(context.previousIds ?? [])].sort().join("\u001f");
    return `${runId}\u001e${normalizedBrand}\u001e${previousIds}`;
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = asId(ref.listingId);
    if (!listingId) throw new ParserChangedError("Wildberries listingId must be a positive numeric nmId");
    await this.ensureDiscoveryBatch(ref, context);

    const currentSearchTitle = asNonemptyString(ref.title);
    const enrichedSearchTitle = currentSearchTitle
      ? await this.enrichProductTitle(listingId, ref.brand, currentSearchTitle, context)
      : undefined;
    const searchObservation = observationFromSearchMetadata(
      enrichedSearchTitle && enrichedSearchTitle !== currentSearchTitle
        ? { ...ref, title: enrichedSearchTitle }
        : ref,
      listingId,
      this.now().toISOString()
    );
    if (searchObservation) return searchObservation;

    const { page, evidenceUrl } = await this.fetchCard(listingId, context);
    const product = page.products.find(
      (candidate) => firstDefinedId(candidate, ["id", "nmId", "nmID"]) === listingId
    );

    if (!product) {
      return {
        domain: PLATFORM_DOMAIN,
        platform: PLATFORM_ID,
        listingId,
        brand: ref.brand,
        canonicalUrl: canonicalProductUrl(listingId),
        product: ref.title ?? ref.brand,
        reviews: null,
        rating: null,
        status: "not_found",
        capturedAt: this.now().toISOString(),
        evidenceRef: evidenceUrl,
        groupId: metadataId(ref.metadata, "rootId"),
        source: "wildberries-card-v4"
      };
    }

    const apiTitle = asNonemptyString(product.name) ?? asNonemptyString(product.title) ?? ref.title;
    if (!apiTitle) throw new ParserChangedError(`Wildberries card ${listingId} has no product title`);
    const sourceBrand = asNonemptyString(product.brand) ?? metadataString(ref.metadata, "sourceBrand");
    const bestKnownTitle = preferProductTitle(apiTitle, asNonemptyString(ref.title));
    const title = await this.enrichProductTitle(listingId, ref.brand, bestKnownTitle, context);

    const groupId =
      firstDefinedId(product, ["root", "rootId", "imtId", "imtID"]) ?? metadataId(ref.metadata, "rootId");
    // Generic `feedbacks` / `reviewRating` can describe the entire imt/root
    // group. They are useful for diagnostics only and must never be published
    // as metrics of a concrete nmId.
    const reviews =
      firstDefinedInteger(product, ["nmFeedbacks"]) ??
      metadataInteger(ref.metadata, "nmFeedbacks");
    const rawRating =
      firstDefinedNumber(product, ["nmReviewRating"]) ??
      metadataNumber(ref.metadata, "nmReviewRating");

    if (reviews === undefined) {
      throw new ParserChangedError(
        `Wildberries card ${listingId} has no nm-specific review-count field; group aggregates are not a substitute`
      );
    }

    const ratingIsValid = rawRating !== undefined && rawRating >= 0 && rawRating <= 5;
    const hasStrictBrandMatch = matchesBrand(title, ref.brand) ||
      Boolean(sourceBrand && matchesBrand(sourceBrand, ref.brand));
    let status: Observation["status"];
    let rating: number | null;

    if (reviews === 0) {
      status = hasStrictBrandMatch ? "no_reviews" : "needs_review";
      rating = null;
    } else if (!ratingIsValid || rawRating === 0 || !hasStrictBrandMatch) {
      status = "needs_review";
      rating = ratingIsValid && rawRating !== 0 ? rawRating : null;
    } else {
      status = "ok";
      rating = rawRating;
    }

    return {
      domain: PLATFORM_DOMAIN,
      platform: PLATFORM_ID,
      listingId,
      brand: ref.brand,
      canonicalUrl: canonicalProductUrl(listingId),
      product: title,
      reviews,
      rating,
      ...(rating !== null ? { rawRating: rating, rawRatingScale: 5 } : {}),
      status,
      capturedAt: this.now().toISOString(),
      evidenceRef: evidenceUrl,
      ...(groupId ? { groupId } : {}),
      source: "wildberries-card-v4"
    };
  }

  private async enrichProductTitle(
    listingId: string,
    brand: string,
    currentTitle: string,
    context: AdapterContext
  ): Promise<string> {
    if ((!TRUNCATED_TITLE.test(currentTitle) && hasExplicitPackageCount(currentTitle)) ||
      !matchesBrand(currentTitle, brand) || this.productInfoFetchOverride === false) return currentTitle;
    const fetchImplementation = this.productInfoFetchOverride ?? context.fetch ?? this.injectedFetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") return currentTitle;

    for (const url of cardInfoUrls(listingId)) {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/json",
            "accept-language": "ru-RU,ru;q=0.9",
            referer: canonicalProductUrl(listingId),
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36"
          },
          signal: context.signal
        });
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return currentTitle;
      }
      if (response.status === 404) continue;
      if (!response.ok) return currentTitle;
      const body = await response.text();
      if (body.length > MAX_CARD_INFO_BYTES) return currentTitle;
      try {
        const enriched = exactCardInfoTitle(JSON.parse(body) as unknown, listingId, brand);
        return enriched ? preferProductTitle(currentTitle, enriched) : currentTitle;
      } catch {
        return currentTitle;
      }
    }
    return currentTitle;
  }

  private async fetchSearchPage(
    brand: string,
    page: number,
    context: AdapterContext
  ): Promise<SearchProductPage> {
    const url = new URL(this.searchEndpoints[0]);
    url.searchParams.set("ab_testing", "false");
    url.searchParams.set("appType", "1");
    url.searchParams.set("curr", "rub");
    url.searchParams.set("dest", this.destination);
    url.searchParams.set("hide_dtype", "13");
    url.searchParams.set("lang", "ru");
    url.searchParams.set("page", String(page));
    url.searchParams.set("query", brand);
    url.searchParams.set("resultset", "catalog");
    url.searchParams.set("sort", "popular");
    url.searchParams.set("spp", "30");
    url.searchParams.set("suppressSpellcheck", "false");
    return {
      ...parseProductPage(await this.requestJson(url, context)),
      evidenceUrl: url.toString()
    };
  }

  private async fetchCard(
    listingId: string,
    context: AdapterContext
  ): Promise<{ page: ProductPage; evidenceUrl: string }> {
    const url = new URL(this.cardEndpoint);
    url.searchParams.set("appType", "1");
    url.searchParams.set("curr", "rub");
    url.searchParams.set("dest", this.destination);
    url.searchParams.set("lang", "ru");
    url.searchParams.set("locale", "ru");
    url.searchParams.set("nm", listingId);
    return {
      page: parseProductPage(await this.requestJson(url, context)),
      evidenceUrl: url.toString()
    };
  }

  private async fetchCardBatch(
    listingIds: string[],
    context: AdapterContext
  ): Promise<{ page: ProductPage; evidenceUrl: string }> {
    if (listingIds.length < 1 || listingIds.length > MAX_CARD_BATCH_SIZE) {
      throw new Error(`Wildberries card batch size must be between 1 and ${MAX_CARD_BATCH_SIZE}`);
    }
    const url = new URL(this.cardEndpoint);
    url.searchParams.set("appType", "1");
    url.searchParams.set("curr", "rub");
    url.searchParams.set("dest", this.destination);
    url.searchParams.set("lang", "ru");
    url.searchParams.set("locale", "ru");
    url.searchParams.set("nm", listingIds.join(";"));
    return {
      page: parseProductPage(await this.requestJson(url, context)),
      evidenceUrl: url.toString()
    };
  }

  private async fetchRootFeedback(
    rootId: string,
    context: AdapterContext
  ): Promise<{ payload: unknown; evidenceUrl: string }> {
    const url = new URL(`${FEEDBACK_ENDPOINT}/${rootId}`);
    return {
      payload: await this.requestJson(url, context),
      evidenceUrl: url.toString()
    };
  }

  private async requestJson(url: URL, context: AdapterContext): Promise<unknown> {
    return this.serializeRequest(async () => {
      const fetchImplementation = context.fetch ?? this.injectedFetch ?? globalThis.fetch;
      if (typeof fetchImplementation !== "function") {
        throw new Error("No fetch implementation is available for the Wildberries adapter");
      }
      const routes = this.requestRoutes(url);
      const blocked: string[] = [];

      for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        if (index > 0 && this.blockedRetryBaseMs > 0) {
          await this.sleep(this.blockedRetryDelay(index));
          context.signal?.throwIfAborted();
        }

        const attemptUrl = new URL(route.searchEndpoint ?? url.toString());
        if (route.searchEndpoint) attemptUrl.search = url.search;
        attemptUrl.searchParams.set("appType", route.appType);
        let response: Response;
        try {
          response = await fetchImplementation(attemptUrl, {
            method: "GET",
            headers: {
              accept: "application/json, text/plain, */*",
              "accept-language": "ru-RU,ru;q=0.9",
              origin: "https://www.wildberries.ru",
              referer: "https://www.wildberries.ru/",
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
              ...(route.browser ? {
                "x-ratings-browser": "1",
                "x-ratings-browser-mode": "wildberries-api"
              } : {})
            },
            signal: context.signal
          });
        } catch (error) {
          if (context.signal?.aborted) throw error;
          blocked.push(`${this.routeLabel(route)} network error: ${errorMessage(error)}`);
          continue;
        }

        const body = await response.text();
        if (TRANSIENT_BLOCK_STATUSES.has(response.status) || isAntiBotPayload(body)) {
          blocked.push(`${this.routeLabel(route)} HTTP ${response.status}`);
          continue;
        }
        if (!response.ok) {
          throw new Error(`Wildberries request failed with HTTP ${response.status}`);
        }

        try {
          const payload = JSON.parse(body) as unknown;
          this.preferredRoute = route;
          this.blockedUntil = 0;
          this.blockedMessage = undefined;
          return payload;
        } catch {
          throw new ParserChangedError("Wildberries returned a successful response that was not JSON");
        }
      }

      const proofUrl = this.searchNoResultsProofUrl(url);
      if (proofUrl) {
        if (this.blockedRetryBaseMs > 0) {
          await this.sleep(this.blockedRetryDelay(routes.length));
          context.signal?.throwIfAborted();
        }
        try {
          const response = await fetchImplementation(proofUrl, {
            method: "GET",
            headers: {
              accept: "application/json",
              "accept-language": "ru-RU,ru;q=0.9",
              "x-ratings-browser": "1",
              "x-ratings-browser-mode": "wildberries-search-proof"
            },
            signal: context.signal
          });
          const body = await response.text();
          if (TRANSIENT_BLOCK_STATUSES.has(response.status) || isAntiBotPayload(body)) {
            blocked.push(`browser search-page proof HTTP ${response.status}`);
          } else if (response.ok) {
            try {
              const payload = JSON.parse(body) as unknown;
              this.blockedUntil = 0;
              this.blockedMessage = undefined;
              return payload;
            } catch {
              throw new ParserChangedError("Wildberries search-page proof returned invalid JSON");
            }
          } else {
            blocked.push(`browser search-page proof HTTP ${response.status}`);
          }
        } catch (error) {
          if (error instanceof ParserChangedError || context.signal?.aborted) throw error;
          blocked.push(`browser search-page proof failed: ${errorMessage(error)}`);
        }
      }

      const message = `Wildberries blocked the request after direct and browser routes (${blocked.join("; ")}); retry this partition later`;
      this.blockedUntil = this.now().getTime() + this.blockedCooldownMs;
      this.blockedMessage = message;
      throw new AdapterBlockedError(message);
    });
  }

  private requestRoutes(url: URL): RequestRoute[] {
    const isSearchRequest = url.hostname === "search.wb.ru" &&
      /\/exactmatch\/ru\/common\/v(?:14|18)\/search$/.test(url.pathname);
    const endpoints = isSearchRequest ? this.searchEndpoints : [undefined];
    const preferred = isSearchRequest
      ? this.preferredRoute.searchEndpoint ? [this.preferredRoute] : []
      : [{ appType: this.preferredRoute.appType, browser: this.preferredRoute.browser }];
    const routes: RequestRoute[] = [
      ...preferred,
      // Exhaust fixed-function/direct egress across both API generations
      // before spending any EdgeOne Sandbox quota.
      ...endpoints.flatMap((searchEndpoint) => this.directAppTypes.map((appType) => ({
        appType,
        browser: false,
        ...(searchEndpoint ? { searchEndpoint } : {})
      }))),
      ...(this.browserFallbackAppType
        ? endpoints.map((searchEndpoint) => ({
            appType: this.browserFallbackAppType!,
            browser: true,
            ...(searchEndpoint ? { searchEndpoint } : {})
          }))
        : [])
    ];
    const unique = new Map<string, RequestRoute>();
    for (const route of routes) {
      unique.set(
        `${route.searchEndpoint ?? "card"}:${route.browser ? "browser" : "direct"}:${route.appType}`,
        route
      );
    }
    return [...unique.values()];
  }

  private routeLabel(route: RequestRoute): string {
    const generation = route.searchEndpoint?.match(/\/common\/(v\d+)\/search$/)?.[1];
    return `${route.browser ? "browser" : "direct"}${generation ? ` ${generation}` : ""} appType=${route.appType}`;
  }

  private blockedRetryDelay(attemptIndex: number): number {
    let remaining = MAX_BLOCKED_RETRY_TOTAL_MS;
    for (let index = 1; index <= attemptIndex; index += 1) {
      const exponential = this.blockedRetryBaseMs * 2 ** Math.min(index - 1, 10);
      const delay = Math.min(remaining, MAX_BLOCKED_RETRY_DELAY_MS, exponential);
      if (index === attemptIndex) return delay;
      remaining -= delay;
      if (remaining <= 0) return 0;
    }
    return 0;
  }

  private searchNoResultsProofUrl(apiUrl: URL): URL | undefined {
    const query = apiUrl.searchParams.get("query")?.trim();
    if (!query) return undefined;
    const page = apiUrl.searchParams.get("page") ?? "1";
    if (!/^\d+$/.test(page)) return undefined;
    const proof = new URL("https://www.wildberries.ru/catalog/0/search.aspx");
    proof.searchParams.set("search", query);
    if (page !== "1") proof.searchParams.set("page", page);
    return proof;
  }

  private async serializeRequest<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.requestTail;
    this.requestTail = previous.then(
      () => slot,
      () => slot
    );

    await previous.catch(() => undefined);
    try {
      if (this.blockedMessage && this.blockedUntil > this.now().getTime()) {
        throw new AdapterBlockedError(this.blockedMessage);
      }
      if (this.hasMadeRequest && this.requestIntervalMs > 0) {
        await this.sleep(this.requestIntervalMs);
      }
      return await operation();
    } finally {
      this.hasMadeRequest = true;
      release();
    }
  }
}

export const wildberriesAdapter = new WildberriesAdapter();
export default wildberriesAdapter;
