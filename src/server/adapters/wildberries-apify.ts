import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { matchesBrand } from "../utils/normalize.js";
import {
  AdapterBlockedError,
  AdapterQuotaError,
  ParserChangedError
} from "./errors.js";

const DEFAULT_ACTOR_ID = "piotrv1001~wildberries-listings-scraper";
const DEFAULT_API_BASE_URL = "https://api.apify.com";
const DEFAULT_MAX_ITEMS = 250;
const DEFAULT_MAX_TOTAL_CHARGE_USD = 0.25;
const DEFAULT_TIMEOUT_SECONDS = 180;
const ABSOLUTE_MAX_ITEMS = 250;
const ABSOLUTE_MAX_TOTAL_CHARGE_USD = 0.25;
const MAX_TIMEOUT_SECONDS = 300;
const MOSCOW_DESTINATION = "-1257786";
const SOURCE = "apify:piotrv1001/wildberries-listings-scraper:listing";
const PLATFORM_ID = "wildberries";
const PLATFORM_DOMAIN = "wildberries.ru";

type JsonRecord = Record<string, unknown>;

type ParsedListing = {
  listingId: string;
  title: string;
  url: string;
  rating: number;
  reviews: number;
};

export type WildberriesApifyAdapterOptions = {
  token?: string;
  actorId?: string;
  apiBaseUrl?: string;
  maxItems?: number;
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const compact = value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, "");
  if (!/^\d+$/.test(compact)) return undefined;
  const normalized = compact.replace(/^0+(?=\d)/, "");
  return normalized === "0" ? undefined : normalized;
}

function asTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.normalize("NFKC").trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.normalize("NFKC").replace(",", ".").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRating(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 5 ? parsed : undefined;
}

function asReviewCount(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function canonicalProductUrl(value: unknown, listingId: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ParserChangedError(`Wildberries Actor item ${listingId} has no product URL`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParserChangedError(`Wildberries Actor item ${listingId} has an invalid product URL`);
  }

  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (url.protocol !== "https:" || (hostname !== PLATFORM_DOMAIN && !hostname.endsWith(`.${PLATFORM_DOMAIN}`))) {
    throw new ParserChangedError(`Wildberries Actor item ${listingId} has a URL outside wildberries.ru`);
  }

  const urlId = asId(url.pathname.match(/^\/catalog\/(\d+)\/detail\.aspx\/?$/i)?.[1]);
  if (!urlId || urlId !== listingId) {
    throw new ParserChangedError(`Wildberries Actor item ${listingId} has a conflicting product URL`);
  }

  return `https://www.wildberries.ru/catalog/${listingId}/detail.aspx`;
}

function actorItemError(record: JsonRecord): string | undefined {
  const error = record.error ?? record.errorInfo;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    for (const key of ["message", "type", "code"] as const) {
      const value = error[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  if (typeof record.status === "string" && /failed|aborted|timed.?out/i.test(record.status)) {
    return record.status;
  }
  return undefined;
}

function parseListing(value: unknown, brand: string): ParsedListing | null {
  if (!isRecord(value)) {
    throw new ParserChangedError("Wildberries Actor dataset contains a non-object item");
  }

  const actorError = actorItemError(value);
  if (actorError) {
    throw new AdapterBlockedError(`Wildberries Actor reported an item failure: ${actorError.slice(0, 500)}`);
  }

  const listingId = asId(value.id);
  if (!listingId) throw new ParserChangedError("Wildberries Actor item has no valid numeric id");
  const title = asTitle(value.name);
  if (!title) throw new ParserChangedError(`Wildberries Actor item ${listingId} has no product name`);
  const rating = asRating(value.rating);
  if (rating === undefined) throw new ParserChangedError(`Wildberries Actor item ${listingId} has no valid rating`);
  const reviews = asReviewCount(value.reviewsCount);
  if (reviews === undefined) {
    throw new ParserChangedError(`Wildberries Actor item ${listingId} has no valid reviewsCount`);
  }
  if (reviews > 0 && rating === 0) {
    throw new ParserChangedError(`Wildberries Actor item ${listingId} has reviews but a zero rating`);
  }
  const url = canonicalProductUrl(value.url, listingId);

  // Search can contain semantically adjacent products. Only a token-aware
  // match in the public product name qualifies the nmId for this brand.
  if (!matchesBrand(title, brand)) return null;

  return { listingId, title, url, rating, reviews };
}

function duplicateIsIdentical(left: ParsedListing, right: ParsedListing): boolean {
  return left.title === right.title &&
    left.url === right.url &&
    left.rating === right.rating &&
    left.reviews === right.reviews;
}

function isQuotaMessage(message: string): boolean {
  return /quota|credit|billing|payment.required|usage.limit|not.enough.usage|max.total.charge|plan.required/i.test(message);
}

async function responseErrorText(response: Response): Promise<string> {
  const fallback = `Apify HTTP ${response.status}`;
  try {
    const text = (await response.text()).trim();
    if (!text) return fallback;
    try {
      const payload = JSON.parse(text) as unknown;
      if (isRecord(payload)) {
        const error = payload.error;
        if (typeof error === "string" && error.trim()) return error.trim().slice(0, 500);
        if (isRecord(error)) {
          const type = typeof error.type === "string" ? error.type : "";
          const message = typeof error.message === "string" ? error.message : "";
          const combined = [type, message].filter(Boolean).join(": ");
          if (combined) return combined.slice(0, 500);
        }
      }
    } catch {
      // Fall through to the bounded response text.
    }
    return text.slice(0, 500);
  } catch {
    return fallback;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class WildberriesApifyAdapter implements SiteAdapter {
  readonly id = PLATFORM_ID;
  readonly supportedDomains = [PLATFORM_DOMAIN, "www.wildberries.ru"] as const;

  private readonly token?: string;
  private readonly actorId: string;
  private readonly apiBaseUrl: string;
  private readonly maxItems: number;
  private readonly maxTotalChargeUsd: number;
  private readonly timeoutSeconds: number;
  private readonly injectedFetch?: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(options: WildberriesApifyAdapterOptions = {}) {
    this.token = options.token?.trim() || envValue("APIFY_TOKEN");
    this.actorId = (options.actorId ?? DEFAULT_ACTOR_ID).replace("/", "~");
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    this.maxTotalChargeUsd = options.maxTotalChargeUsd ?? DEFAULT_MAX_TOTAL_CHARGE_USD;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.injectedFetch = options.fetch;
    this.now = options.now ?? (() => new Date());

    if (!/^[\w-]+~[\w-]+$/i.test(this.actorId)) {
      throw new TypeError("actorId must look like owner~actor-name");
    }
    if (!Number.isInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > ABSOLUTE_MAX_ITEMS) {
      throw new RangeError(`Wildberries Apify maxItems must be an integer from 1 to ${ABSOLUTE_MAX_ITEMS}`);
    }
    if (!Number.isFinite(this.maxTotalChargeUsd) || this.maxTotalChargeUsd <= 0 || this.maxTotalChargeUsd > ABSOLUTE_MAX_TOTAL_CHARGE_USD) {
      throw new RangeError(`Wildberries Apify maxTotalChargeUsd must be greater than 0 and at most ${ABSOLUTE_MAX_TOTAL_CHARGE_USD}`);
    }
    if (!Number.isInteger(this.timeoutSeconds) || this.timeoutSeconds < 1 || this.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new RangeError(`Wildberries Apify timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
    }
    if (new URL(this.apiBaseUrl).protocol !== "https:") {
      throw new TypeError("apiBaseUrl must use HTTPS");
    }
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = this.now().toISOString();
    if (!this.token) return { ok: false, checkedAt, message: "APIFY_TOKEN is not configured" };

    try {
      const response = await this.fetchFor(context)(
        `${this.apiBaseUrl}/v2/acts/${this.actorId}`,
        { method: "GET", headers: this.authorizationHeaders(), signal: context.signal }
      );
      if (!response.ok) return { ok: false, checkedAt, message: await responseErrorText(response) };
      return { ok: true, checkedAt, message: "Wildberries Apify fallback is available" };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        ok: false,
        checkedAt,
        message: error instanceof Error ? error.message : "Wildberries Apify health check failed"
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const requestedBrand = brand.normalize("NFKC").trim();
    if (!requestedBrand) throw new TypeError("brand must not be empty");

    const endpoint = new URL(`${this.apiBaseUrl}/v2/acts/${this.actorId}/run-sync-get-dataset-items`);
    endpoint.searchParams.set("maxItems", String(this.maxItems));
    endpoint.searchParams.set("maxTotalChargeUsd", String(this.maxTotalChargeUsd));
    endpoint.searchParams.set("timeout", String(this.timeoutSeconds));
    endpoint.searchParams.set("limit", String(this.maxItems));
    endpoint.searchParams.set("clean", "1");
    endpoint.searchParams.set("restartOnError", "false");

    let response: Response;
    try {
      response = await this.fetchFor(context)(endpoint, {
        method: "POST",
        headers: {
          ...this.authorizationHeaders(),
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          searchQueries: [requestedBrand],
          maxItems: this.maxItems,
          enrichDetails: false,
          scrapeReviews: false,
          dest: MOSCOW_DESTINATION,
          sort: "popular",
          maxPagesPerList: 100
        }),
        signal: context.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new AdapterBlockedError(
        `Unable to reach Apify for Wildberries collection: ${error instanceof Error ? error.message : "network error"}`
      );
    }

    if (!response.ok) {
      const message = await responseErrorText(response);
      if (response.status === 402 || isQuotaMessage(message)) {
        throw new AdapterQuotaError(`Apify quota or cost cap prevented Wildberries collection: ${message}`);
      }
      throw new AdapterBlockedError(`Wildberries Apify fallback is temporarily blocked: ${message}`);
    }

    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      throw new ParserChangedError("Apify returned non-JSON data for Wildberries");
    }
    if (!Array.isArray(payload)) {
      throw new ParserChangedError("Apify returned an unexpected Wildberries dataset shape");
    }

    const products = new Map<string, ParsedListing>();
    for (const raw of payload) {
      const product = parseListing(raw, requestedBrand);
      if (!product) continue;
      const existing = products.get(product.listingId);
      if (existing && !duplicateIsIdentical(existing, product)) {
        throw new ParserChangedError(`Wildberries Actor returned conflicting duplicates for nmId ${product.listingId}`);
      }
      products.set(product.listingId, product);
    }

    if (payload.length >= this.maxItems) {
      throw new AdapterQuotaError(
        `Wildberries search reached the configured ${this.maxItems}-item safety cap; complete discovery was not proven`
      );
    }

    const capturedAt = this.now().toISOString();
    return [...products.values()].map((product): ProductRef => ({
      domain: PLATFORM_DOMAIN,
      platform: PLATFORM_ID,
      listingId: product.listingId,
      brand: requestedBrand,
      url: product.url,
      title: product.title,
      metadata: {
        collector: "wildberries-apify",
        rating: product.rating,
        reviewCount: product.reviews,
        capturedAt,
        source: SOURCE
      }
    }));
  }

  async collect(ref: ProductRef, _context: AdapterContext): Promise<Observation> {
    const listingId = asId(ref.listingId);
    if (!listingId) throw new ParserChangedError("Wildberries Apify ProductRef has no valid nmId");
    const product = asTitle(ref.title);
    if (!product) throw new ParserChangedError(`Wildberries Apify ProductRef ${listingId} has no product name`);
    if (!matchesBrand(product, ref.brand)) {
      throw new ParserChangedError(`Wildberries Apify ProductRef ${listingId} no longer matches brand ${ref.brand}`);
    }
    const reviews = asReviewCount(ref.metadata.reviewCount);
    if (reviews === undefined) {
      throw new ParserChangedError(`Wildberries Apify ProductRef ${listingId} has no valid reviewsCount`);
    }
    const rawRating = asRating(ref.metadata.rating);
    if (rawRating === undefined || (reviews > 0 && rawRating === 0)) {
      throw new ParserChangedError(`Wildberries Apify ProductRef ${listingId} has no valid rating`);
    }
    const canonicalUrl = canonicalProductUrl(ref.url, listingId);
    const captured = typeof ref.metadata.capturedAt === "string"
      ? Date.parse(ref.metadata.capturedAt)
      : Number.NaN;

    return {
      domain: PLATFORM_DOMAIN,
      platform: PLATFORM_ID,
      listingId,
      brand: ref.brand,
      canonicalUrl,
      product,
      reviews,
      rating: reviews === 0 ? null : rawRating,
      ...(reviews === 0 ? {} : { rawRating, rawRatingScale: 5 }),
      status: reviews === 0 ? "no_reviews" : "ok",
      capturedAt: Number.isNaN(captured) ? this.now().toISOString() : new Date(captured).toISOString(),
      source: SOURCE
    };
  }

  private fetchFor(context: AdapterContext): typeof globalThis.fetch {
    const fetchImplementation = context.fetch ?? this.injectedFetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new AdapterBlockedError("No fetch implementation is available for the Wildberries Apify adapter");
    }
    return fetchImplementation;
  }

  private authorizationHeaders(): HeadersInit {
    if (!this.token) throw new AdapterBlockedError("APIFY_TOKEN is not configured for Wildberries fallback");
    return { Accept: "application/json", Authorization: `Bearer ${this.token}` };
  }
}

export function isWildberriesApifyRef(ref: ProductRef): boolean {
  return ref.metadata.collector === "wildberries-apify";
}

export function createWildberriesApifyAdapter(
  options: WildberriesApifyAdapterOptions = {}
): WildberriesApifyAdapter {
  return new WildberriesApifyAdapter(options);
}

export const wildberriesApifyAdapter = new WildberriesApifyAdapter();
export default wildberriesApifyAdapter;
