import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ObservationStatus,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import {
  matchesBrand,
  normalizeRating
} from "../utils/normalize.js";
import { canonicalizeUrl } from "../utils/urls.js";
import {
  AdapterBlockedError,
  AdapterQuotaError,
  ParserChangedError
} from "./errors.js";

const DEFAULT_ACTOR_ID = "ahaham_bytiz~ozon-scraper";
const DEFAULT_API_BASE_URL = "https://api.apify.com";
const DEFAULT_MAX_RESULTS = 80;
const DEFAULT_MAX_TOTAL_CHARGE_USD = 0.15;
const DEFAULT_TIMEOUT_SECONDS = 300;

const MAX_ACTOR_RESULTS = 10_000;
const ABSOLUTE_MAX_TOTAL_CHARGE_USD = 4.5;
const MAX_SYNC_TIMEOUT_SECONDS = 300;

// The tiles-only mode already exposes SKU, title, rating and reviewCount and is
// materially faster/cheaper than opening every product page.
const SOURCE = "apify:ahaham_bytiz/ozon-scraper:search";

type JsonRecord = Record<string, unknown>;

type ParsedProduct = {
  listingId: string;
  title: string;
  url: string;
  rawBrand?: string;
  rating: number | null;
  reviews: number | null;
  rawRating: unknown;
  rawReviewCount: unknown;
  idConflict: boolean;
  conflictingMetrics: boolean;
  duplicateCount: number;
};

type DiscoveryBatch = Map<string, ProductRef[]>;
type DiscoveryCacheEntry = {
  brandKeys: Set<string>;
  promise: Promise<DiscoveryBatch>;
};

export type OzonAdapterOptions = {
  token?: string;
  actorId?: string;
  apiBaseUrl?: string;
  maxResults?: number;
  maxTotalChargeUsd?: number;
  timeoutSeconds?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

function envValue(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name]?.trim();
  return value || undefined;
}

function normalizedBrand(value: string): string {
  return value.normalize("NFKC").trim();
}

function brandKey(value: string): string {
  return normalizedBrand(value).toLocaleLowerCase("ru");
}

function batchBrands(brand: string, context: AdapterContext): string[] {
  const requested = normalizedBrand(brand);
  if (!requested) throw new TypeError("brand must not be empty");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...(context.brands ?? []), requested]) {
    const normalized = normalizedBrand(candidate);
    const key = brandKey(normalized);
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function numericEnv(name: string): number | undefined {
  const value = envValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireNumberInRange(
  value: number,
  name: string,
  minimumExclusive: number,
  maximum: number
): number {
  if (!Number.isFinite(value) || value <= minimumExclusive || value > maximum) {
    throw new RangeError(`${name} must be greater than ${minimumExclusive} and at most ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AGGREGATE_COLUMNS = ["sku", "url", "title", "rating", "reviewCount"] as const;

/**
 * The actor normally emits one dataset item per product. Its synchronous API
 * can also expose a column-oriented item, so accept that shape only when every
 * required column is present and all column lengths agree. A partial column
 * set must fail closed rather than pair a rating with the wrong SKU.
 */
function expandDatasetItem(record: JsonRecord): JsonRecord[] {
  const hasAggregateColumn = AGGREGATE_COLUMNS.some((key) => Array.isArray(record[key]));
  if (!hasAggregateColumn) return [record];

  const columns = AGGREGATE_COLUMNS.map((key) => record[key]);
  if (!columns.every(Array.isArray)) {
    throw new ParserChangedError("Ozon actor returned an incomplete column-oriented dataset item");
  }

  const length = (columns[0] as unknown[]).length;
  if (!columns.every((column) => (column as unknown[]).length === length)) {
    throw new ParserChangedError("Ozon actor returned column arrays with different lengths");
  }
  if (Array.isArray(record.brand) && record.brand.length !== length) {
    throw new ParserChangedError("Ozon actor returned a brand column with a different length");
  }

  return Array.from({ length }, (_, index) => {
    const row: JsonRecord = { ...record };
    for (const key of AGGREGATE_COLUMNS) row[key] = (record[key] as unknown[])[index];
    if (Array.isArray(record.brand)) row.brand = record.brand[index];
    return row;
  });
}

function firstPresent(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  return undefined;
}

function normalizeSku(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }

  if (typeof value !== "string") return null;
  const compact = value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, "");
  if (!/^\d+$/.test(compact)) return null;
  const normalized = compact.replace(/^0+(?=\d)/, "");
  return normalized === "0" ? null : normalized;
}

function skuFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, "https://www.ozon.ru");
    const match = url.pathname.match(/(?:^|[-/])(\d{5,})(?:\/)?$/);
    return normalizeSku(match?.[1]);
  } catch {
    return null;
  }
}

function parseReviewCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const digits = value.normalize("NFKC").replace(/[^\d]/g, "");
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRating(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = value.normalize("NFKC").replace(",", ".").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function rawBrandName(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const name = value.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function canonicalOzonUrl(value: unknown, sku: string): string {
  const fallback = `https://www.ozon.ru/product/${sku}/`;
  if (typeof value !== "string" || !value.trim()) return fallback;

  let url: URL;
  try {
    const absolute = new URL(value, "https://www.ozon.ru").toString();
    url = new URL(canonicalizeUrl(absolute));
  } catch {
    throw new ParserChangedError("Ozon returned an invalid product URL");
  }

  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const isRussianOzon = hostname === "ozon.ru" || hostname.endsWith(".ozon.ru");
  if (!isRussianOzon) {
    throw new ParserChangedError("Ozon RU actor returned a product URL outside ozon.ru");
  }

  const productSegment = url.pathname.match(/\/product\/([^/]+)/i)?.[1];
  if (!productSegment || skuFromUrl(url.toString()) !== sku) return fallback;
  return `https://www.ozon.ru/product/${productSegment}/`;
}

function safeTitle(record: JsonRecord): string | null {
  const value = firstPresent(record, ["title", "name"]);
  return typeof value === "string" && value.trim() ? value.normalize("NFKC").trim() : null;
}

function actorItemError(record: JsonRecord): string | null {
  const error = record.error ?? record.errorInfo;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const message = firstPresent(error, ["message", "type", "code"]);
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof record.status === "string" && /failed|aborted|timed.?out/i.test(record.status)) {
    return record.status;
  }
  const warning = firstPresent(record, ["_warning", "warning"]);
  if (typeof warning === "string" && warning.trim()) return warning.trim();
  return null;
}

function isQuotaMessage(message: string): boolean {
  return /quota|credit|billing|payment.required|monthly.usage|usage.limit|not.enough.usage|max.total.charge|plan.required|free.tier.limit|limit.reached/i.test(
    message
  );
}

function throwActorFailure(message: string, status?: number): never {
  const safeMessage = message.slice(0, 500);
  if (status === 402 || isQuotaMessage(safeMessage)) {
    throw new AdapterQuotaError(`Apify quota or cost limit prevented Ozon collection: ${safeMessage}`);
  }
  throw new AdapterBlockedError(`Ozon collection is temporarily blocked: ${safeMessage}`);
}

function extractErrorText(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return fallback;

  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const type = typeof error.type === "string" ? error.type : "";
    const message = typeof error.message === "string" ? error.message : "";
    const combined = [type, message].filter(Boolean).join(": ");
    if (combined) return combined;
  }

  const message = firstPresent(payload, ["message", "statusMessage"]);
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

async function responseErrorText(response: Response): Promise<string> {
  const fallback = `Apify HTTP ${response.status}`;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    return extractErrorText(JSON.parse(text) as unknown, fallback);
  } catch {
    return text.trim().slice(0, 500);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function parseProduct(record: JsonRecord, brand: string): ParsedProduct | null {
  const title = safeTitle(record);
  if (!title) throw new ParserChangedError("Ozon actor returned a product without a title");

  const sourceUrl = firstPresent(record, ["url", "productUrl", "link"]);
  const skuValue = normalizeSku(firstPresent(record, ["sku", "id"]));
  const productIdValue = normalizeSku(record.productId);
  const urlValue = skuFromUrl(sourceUrl);
  const listingId = skuValue ?? productIdValue ?? urlValue;
  if (!listingId) throw new ParserChangedError("Ozon actor returned a product without a usable SKU");

  const ids = new Set([skuValue, productIdValue, urlValue].filter((value): value is string => !!value));
  const rawBrand = rawBrandName(record.brand);
  if (!matchesBrand(title, brand) && !(rawBrand && matchesBrand(rawBrand, brand))) return null;

  const rawRating = firstPresent(record, ["rating", "reviewRating", "averageRating"]);
  const rawReviewCount = firstPresent(record, [
    "reviewCount",
    "reviewsCount",
    "reviewsTotal",
    "feedbackCount"
  ]);

  return {
    listingId,
    title,
    url: canonicalOzonUrl(sourceUrl, listingId),
    rawBrand,
    rating: parseRating(rawRating),
    reviews: parseReviewCount(rawReviewCount),
    rawRating,
    rawReviewCount,
    idConflict: ids.size > 1,
    conflictingMetrics: false,
    duplicateCount: 1
  };
}

function completeness(product: ParsedProduct): number {
  return Number(product.reviews !== null) + Number(product.rating !== null) + Number(!product.url.endsWith(`/product/${product.listingId}/`));
}

function mergeDuplicate(existing: ParsedProduct, incoming: ParsedProduct): ParsedProduct {
  const metricConflict =
    (existing.reviews !== null && incoming.reviews !== null && existing.reviews !== incoming.reviews) ||
    (existing.rating !== null && incoming.rating !== null && existing.rating !== incoming.rating);
  const preferred = completeness(incoming) > completeness(existing) ? incoming : existing;
  const other = preferred === existing ? incoming : existing;

  return {
    ...preferred,
    rating: preferred.rating ?? other.rating,
    reviews: preferred.reviews ?? other.reviews,
    rawRating: preferred.rawRating ?? other.rawRating,
    rawReviewCount: preferred.rawReviewCount ?? other.rawReviewCount,
    idConflict: existing.idConflict || incoming.idConflict,
    conflictingMetrics: existing.conflictingMetrics || incoming.conflictingMetrics || metricConflict,
    duplicateCount: existing.duplicateCount + incoming.duplicateCount
  };
}

function metadataBoolean(metadata: ProductRef["metadata"], key: string): boolean {
  return metadata[key] === true;
}

export class OzonAdapter implements SiteAdapter {
  readonly id = "ozon";
  readonly supportedDomains = ["ozon.ru", "www.ozon.ru"] as const;

  private readonly token?: string;
  private readonly actorId: string;
  private readonly apiBaseUrl: string;
  private readonly maxResults: number;
  private readonly maxTotalChargeUsd: number;
  private readonly timeoutSeconds: number;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly discoveryCache = new Map<string, DiscoveryCacheEntry>();

  constructor(options: OzonAdapterOptions = {}) {
    this.token = options.token?.trim() || envValue("APIFY_TOKEN");
    this.actorId = (options.actorId ?? DEFAULT_ACTOR_ID).replace("/", "~");
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.maxResults = requireIntegerInRange(
      options.maxResults ?? numericEnv("OZON_APIFY_MAX_RESULTS") ?? DEFAULT_MAX_RESULTS,
      "maxResults",
      1,
      MAX_ACTOR_RESULTS
    );
    this.maxTotalChargeUsd = requireNumberInRange(
      options.maxTotalChargeUsd ??
        numericEnv("OZON_APIFY_MAX_TOTAL_CHARGE_USD") ??
        DEFAULT_MAX_TOTAL_CHARGE_USD,
      "maxTotalChargeUsd",
      0,
      ABSOLUTE_MAX_TOTAL_CHARGE_USD
    );
    this.timeoutSeconds = requireIntegerInRange(
      options.timeoutSeconds ?? numericEnv("OZON_APIFY_TIMEOUT_SECONDS") ?? DEFAULT_TIMEOUT_SECONDS,
      "timeoutSeconds",
      1,
      MAX_SYNC_TIMEOUT_SECONDS
    );
    this.fetchImpl = options.fetch;
    this.now = options.now ?? (() => new Date());

    if (!/^[\w-]+~[\w-]+$/i.test(this.actorId)) {
      throw new TypeError("actorId must look like owner~actor-name");
    }
    const baseUrl = new URL(this.apiBaseUrl);
    if (baseUrl.protocol !== "https:") throw new TypeError("apiBaseUrl must use HTTPS");
  }

  private fetchFor(context: AdapterContext): typeof globalThis.fetch {
    const fetchImpl = context.fetch ?? this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new AdapterBlockedError("No fetch implementation is available for the Ozon adapter");
    }
    return fetchImpl;
  }

  private authorizationHeaders(): HeadersInit {
    if (!this.token) throw new AdapterBlockedError("APIFY_TOKEN is not configured for Ozon collection");
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`
    };
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = this.now().toISOString();
    if (!this.token) {
      return { ok: false, checkedAt, message: "APIFY_TOKEN is not configured" };
    }

    try {
      const response = await this.fetchFor(context)(
        `${this.apiBaseUrl}/v2/acts/${this.actorId}`,
        {
          method: "GET",
          headers: this.authorizationHeaders(),
          signal: context.signal
        }
      );
      if (!response.ok) {
        return { ok: false, checkedAt, message: await responseErrorText(response) };
      }
      return { ok: true, checkedAt };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        ok: false,
        checkedAt,
        message: error instanceof Error ? error.message : "Apify health check failed"
      };
    }
  }

  isDiscoveryCached(brand: string, context: AdapterContext): boolean {
    const cacheKey = context.runId?.trim();
    if (!cacheKey) return false;
    return this.discoveryCache.get(cacheKey)?.brandKeys.has(brandKey(brand)) === true;
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const requestedBrand = normalizedBrand(brand);
    if (!requestedBrand) throw new TypeError("brand must not be empty");
    const brands = batchBrands(requestedBrand, context);
    const cacheKey = context.runId?.trim();
    const requestedKey = brandKey(requestedBrand);
    const existing = cacheKey ? this.discoveryCache.get(cacheKey) : undefined;
    if (existing?.brandKeys.has(requestedKey)) {
      return (await existing.promise).get(requestedKey) ?? [];
    }

    const promise = this.discoverBatch(brands, context);
    const entry: DiscoveryCacheEntry = {
      brandKeys: new Set(brands.map(brandKey)),
      promise
    };
    if (cacheKey) {
      this.discoveryCache.set(cacheKey, entry);
      // Agent runtimes may be reused. Keep only a small run-local cache instead
      // of retaining product datasets for the lifetime of the isolate.
      while (this.discoveryCache.size > 32) {
        const oldest = this.discoveryCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.discoveryCache.delete(oldest);
      }
    }

    try {
      return (await promise).get(requestedKey) ?? [];
    } catch (error) {
      // A failed Actor call must be retryable and must never masquerade as a
      // free cache hit on the next selective retry.
      if (cacheKey && this.discoveryCache.get(cacheKey) === entry) {
        this.discoveryCache.delete(cacheKey);
      }
      throw error;
    }
  }

  private async discoverBatch(brands: string[], context: AdapterContext): Promise<DiscoveryBatch> {
    const batchResultLimit = Math.min(MAX_ACTOR_RESULTS, this.maxResults * brands.length);

    const endpoint = new URL(
      `${this.apiBaseUrl}/v2/acts/${this.actorId}/run-sync-get-dataset-items`
    );
    endpoint.searchParams.set("maxItems", String(batchResultLimit));
    endpoint.searchParams.set("maxTotalChargeUsd", String(this.maxTotalChargeUsd));
    endpoint.searchParams.set("timeout", String(this.timeoutSeconds));
    endpoint.searchParams.set("limit", String(batchResultLimit));
    endpoint.searchParams.set("clean", "1");
    endpoint.searchParams.set("restartOnError", "false");

    let response: Response;
    try {
      response = await this.fetchFor(context)(endpoint, {
        method: "POST",
        headers: {
          ...this.authorizationHeaders(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          searchQueries: brands,
          maxItems: batchResultLimit,
          maxPagesPerQuery: 20
        }),
        signal: context.signal
      });
    } catch (error) {
      if (error instanceof AdapterBlockedError || error instanceof AdapterQuotaError || isAbortError(error)) {
        throw error;
      }
      throw new AdapterBlockedError(
        `Unable to reach Apify for Ozon collection: ${error instanceof Error ? error.message : "network error"}`
      );
    }

    if (!response.ok) {
      throwActorFailure(await responseErrorText(response), response.status);
    }

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      throw new ParserChangedError("Apify returned non-JSON data for Ozon");
    }
    if (!Array.isArray(payload)) {
      throw new ParserChangedError("Apify returned an unexpected Ozon dataset shape");
    }

    const products = new Map<string, Map<string, ParsedProduct>>(
      brands.map((requestedBrand) => [brandKey(requestedBrand), new Map<string, ParsedProduct>()])
    );
    let titledItems = 0;
    let itemsWithoutTitle = 0;
    for (const item of payload) {
      if (!isRecord(item)) throw new ParserChangedError("Ozon dataset contains a non-object item");
      const actorError = actorItemError(item);
      if (actorError) throwActorFailure(actorError);

      for (const row of expandDatasetItem(item)) {
        // A service/diagnostic object without a product title must not discard
        // valid cards in the same response. If no titled item remains, schema
        // validity is not proven and collection fails closed below.
        if (!safeTitle(row)) {
          itemsWithoutTitle += 1;
          continue;
        }
        titledItems += 1;

        for (const requestedBrand of brands) {
          const parsed = parseProduct(row, requestedBrand);
          if (!parsed) continue;
          const brandProducts = products.get(brandKey(requestedBrand))!;
          const existing = brandProducts.get(parsed.listingId);
          brandProducts.set(parsed.listingId, existing ? mergeDuplicate(existing, parsed) : parsed);
        }
      }
    }

    if (payload.length > 0 && titledItems === 0 && itemsWithoutTitle > 0) {
      throw new ParserChangedError("Ozon actor returned no product items with titles");
    }

    const capturedAt = this.now().toISOString();
    const discoveryTruncated = titledItems >= batchResultLimit;
    const cappedBrand = brands.find((requestedBrand) =>
      products.get(brandKey(requestedBrand))!.size >= this.maxResults
    );
    if (discoveryTruncated || cappedBrand) {
      throw new AdapterQuotaError(
        cappedBrand
          ? `Ozon search for ${cappedBrand} reached the configured ${this.maxResults}-item per-brand safety cap; complete discovery was not proven`
          : `Ozon search reached the configured ${batchResultLimit}-item batch safety cap; complete discovery was not proven`
      );
    }

    return new Map(brands.map((requestedBrand) => [
      brandKey(requestedBrand),
      [...products.get(brandKey(requestedBrand))!.values()].map((product): ProductRef => ({
        domain: "ozon.ru",
        platform: this.id,
        listingId: product.listingId,
        brand: requestedBrand,
        url: product.url,
        title: product.title,
        metadata: {
          rating: product.rating,
          reviewCount: product.reviews,
          rawRating: product.rawRating,
          rawReviewCount: product.rawReviewCount,
          rawBrand: product.rawBrand,
          idConflict: product.idConflict,
          conflictingMetrics: product.conflictingMetrics,
          duplicateCount: product.duplicateCount,
          discoveryTruncated,
          capturedAt,
          source: SOURCE
        }
      }))
    ]));
  }

  async collect(ref: ProductRef, _context: AdapterContext): Promise<Observation> {
    const listingId = normalizeSku(ref.listingId);
    if (!listingId) throw new ParserChangedError("Ozon ProductRef contains an invalid SKU");
    const product = ref.title?.normalize("NFKC").trim();
    if (!product) throw new ParserChangedError("Ozon ProductRef is missing its title");

    const reviews = parseReviewCount(ref.metadata.reviewCount);
    const rawRating = parseRating(ref.metadata.rating);
    const brandMatches = matchesBrand(product, ref.brand);
    const needsManualReview =
      !brandMatches ||
      metadataBoolean(ref.metadata, "idConflict") ||
      metadataBoolean(ref.metadata, "conflictingMetrics") ||
      metadataBoolean(ref.metadata, "discoveryTruncated");

    let status: ObservationStatus;
    let rating: number | null = rawRating === null ? null : normalizeRating(rawRating, 5);
    const ratingUnavailable = reviews !== null && reviews > 0 && rawRating === 0;
    if (reviews === 0) {
      status = needsManualReview ? "needs_review" : "no_reviews";
      rating = null;
    } else if (ratingUnavailable) {
      // Zero is the actor's sentinel when Ozon displays written reviews but
      // has not calculated a product score. It is not a real 0-star rating.
      status = needsManualReview ? "needs_review" : "ok";
      rating = null;
    } else if (
      reviews === null ||
      rating === null ||
      needsManualReview
    ) {
      status = "needs_review";
    } else {
      status = "ok";
    }

    const capturedAtValue = ref.metadata.capturedAt;
    const capturedAt =
      typeof capturedAtValue === "string" && !Number.isNaN(Date.parse(capturedAtValue))
        ? new Date(capturedAtValue).toISOString()
        : this.now().toISOString();

    return {
      domain: "ozon.ru",
      platform: this.id,
      listingId,
      brand: ref.brand,
      canonicalUrl: canonicalOzonUrl(ref.url, listingId),
      product,
      reviews,
      rating,
      ...(rawRating === null ? {} : { rawRating, rawRatingScale: 5 }),
      ...(ratingUnavailable ? { ratingUnavailable: true } : {}),
      status,
      capturedAt,
      source: typeof ref.metadata.source === "string" ? ref.metadata.source : SOURCE
    };
  }
}

export function createOzonAdapter(options: OzonAdapterOptions = {}): OzonAdapter {
  return new OzonAdapter(options);
}

export const ozonAdapter = new OzonAdapter();
export default ozonAdapter;
