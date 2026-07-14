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
const SEARCH_ENDPOINT = "https://search.wb.ru/exactmatch/ru/common/v14/search";
const CARD_ENDPOINT = "https://card.wb.ru/cards/v4/detail";
const MOSCOW_DESTINATION = "-1257786";
const PLATFORM_ID = "wildberries";
const PLATFORM_DOMAIN = "wildberries.ru";
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_DIRECT_APP_TYPES = [1, 32] as const;
const DEFAULT_BROWSER_APP_TYPE = 32;
const DEFAULT_BLOCKED_RETRY_BASE_MS = 100;
const DEFAULT_BLOCKED_COOLDOWN_MS = 30_000;
const TRANSIENT_BLOCK_STATUSES = new Set([403, 407, 423, 429, 498, 502, 503, 504]);

type JsonObject = Record<string, unknown>;

type ProductPage = {
  products: JsonObject[];
  total?: number;
};

export type WildberriesAdapterOptions = {
  fetch?: typeof globalThis.fetch;
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

function observationFromSearchMetadata(
  ref: ProductRef,
  listingId: string,
  capturedAt: string
): Observation | undefined {
  if (ref.metadata.source !== "wildberries-search-v18") return undefined;

  const title = asNonemptyString(ref.title);
  const reviews = metadataInteger(ref.metadata, "nmFeedbacks");
  const rawRating = metadataNumber(ref.metadata, "nmReviewRating");
  const ratingIsValid = rawRating !== undefined && rawRating >= 0 && rawRating <= 5;
  if (!title || reviews === undefined || !ratingIsValid || (reviews > 0 && rawRating === 0)) {
    return undefined;
  }

  const brandMatches = matchesBrand(title, ref.brand);
  const rating = reviews === 0 ? null : rawRating;
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
    status: brandMatches ? (reviews === 0 ? "no_reviews" : "ok") : "needs_review",
    capturedAt,
    ...(metadataId(ref.metadata, "rootId") ? { groupId: metadataId(ref.metadata, "rootId") } : {}),
    source: "wildberries-search-v18"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WildberriesAdapter implements SiteAdapter {
  readonly id = PLATFORM_ID;
  readonly supportedDomains = [PLATFORM_DOMAIN, "www.wildberries.ru"] as const;

  private readonly injectedFetch?: typeof globalThis.fetch;
  private readonly maxPages: number;
  private readonly requestIntervalMs: number;
  private readonly searchEndpoint: string;
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
    this.maxPages = maxPages;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.searchEndpoint = options.searchEndpoint ?? SEARCH_ENDPOINT;
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
        if (!listingId || !title || !matchesBrand(title, brand)) continue;
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
            ...(groupId ? { rootId: groupId } : {}),
            ...(nmReviewRating !== undefined ? { nmReviewRating } : {}),
            ...(nmFeedbacks !== undefined ? { nmFeedbacks } : {}),
            ...(groupReviewRating !== undefined ? { groupReviewRating } : {}),
            ...(groupFeedbacks !== undefined ? { groupFeedbacks } : {})
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

    const searchObservation = observationFromSearchMetadata(ref, listingId, this.now().toISOString());
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

    const title = asNonemptyString(product.name) ?? asNonemptyString(product.title) ?? ref.title;
    if (!title) throw new ParserChangedError(`Wildberries card ${listingId} has no product title`);

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
    const hasStrictBrandMatch = matchesBrand(title, ref.brand);
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

  private async fetchSearchPage(
    brand: string,
    page: number,
    context: AdapterContext
  ): Promise<ProductPage> {
    const url = new URL(this.searchEndpoint);
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
    return parseProductPage(await this.requestJson(url, context));
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

  private async requestJson(url: URL, context: AdapterContext): Promise<unknown> {
    return this.serializeRequest(async () => {
      const fetchImplementation = context.fetch ?? this.injectedFetch ?? globalThis.fetch;
      if (typeof fetchImplementation !== "function") {
        throw new Error("No fetch implementation is available for the Wildberries adapter");
      }
      const routes = this.requestRoutes();
      const blocked: string[] = [];

      for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        if (index > 0 && this.blockedRetryBaseMs > 0) {
          const delay = Math.min(10_000, this.blockedRetryBaseMs * 3 ** (index - 1));
          await this.sleep(delay);
          context.signal?.throwIfAborted();
        }

        const attemptUrl = new URL(url);
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
          const delay = Math.min(10_000, this.blockedRetryBaseMs * 3 ** Math.max(0, routes.length - 1));
          await this.sleep(delay);
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

  private requestRoutes(): RequestRoute[] {
    const routes: RequestRoute[] = [
      this.preferredRoute,
      ...this.directAppTypes.map((appType) => ({ appType, browser: false })),
      ...(this.browserFallbackAppType
        ? [{ appType: this.browserFallbackAppType, browser: true }]
        : [])
    ];
    const unique = new Map<string, RequestRoute>();
    for (const route of routes) unique.set(`${route.browser ? "browser" : "direct"}:${route.appType}`, route);
    return [...unique.values()];
  }

  private routeLabel(route: RequestRoute): string {
    return `${route.browser ? "browser" : "direct"} appType=${route.appType}`;
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
