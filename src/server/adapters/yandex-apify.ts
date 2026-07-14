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
import { YandexAdapter } from "./yandex.js";

const DEFAULT_ACTOR_ID = "zen-studio~yandex-market-scraper-parser";
const DEFAULT_API_BASE_URL = "https://api.apify.com";
const DEFAULT_MAX_ITEMS = 40;
const DEFAULT_MAX_TOTAL_CHARGE_USD = 0.25;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_ACTOR_ITEMS = 2_700;
const ABSOLUTE_MAX_TOTAL_CHARGE_USD = 4.5;
const MAX_SYNC_TIMEOUT_SECONDS = 300;
const MOSCOW_REGION_ID = "213";
const SOURCE = "apify:zen-studio/yandex-market-scraper-parser:enriched";
const REVIEWS_FETCH_MAX_ATTEMPTS = 3;
const REVIEWS_FETCH_RETRY_DELAYS_MS = [100, 250] as const;

type JsonRecord = Record<string, unknown>;

type ParsedProduct = {
  listingId: string;
  title: string;
  duplicateCount: number;
};

class MissingReviewCountError extends ParserChangedError {}

export type YandexApifyAdapterOptions = {
  token?: string;
  actorId?: string;
  apiBaseUrl?: string;
  maxItems?: number;
  maxTotalChargeUsd?: number;
  timeoutSeconds?: number;
  fetch?: typeof globalThis.fetch;
  /** Direct HTTPS fetch used only for fixed reviews.yandex.ru model pages. */
  reviewsFetch?: typeof globalThis.fetch;
  now?: () => Date;
};

function envValue(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name]?.trim();
  return value || undefined;
}

function numericEnv(name: string): number | undefined {
  const value = envValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integerInRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function numberInRange(value: number, name: string, minimumExclusive: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= minimumExclusive || value > maximum) {
    throw new RangeError(`${name} must be greater than ${minimumExclusive} and at most ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.normalize("NFKC").trim()
    : undefined;
}

function normalizeModelId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const compact = value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, "");
  if (!/^\d+$/.test(compact)) return undefined;
  const normalized = compact.replace(/^0+(?=\d)/, "");
  return normalized === "0" ? undefined : normalized;
}

function parseReviewCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const compact = value.normalize("NFKC").replace(/[^\d]/g, "");
  if (!compact) return undefined;
  const parsed = Number(compact);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function reviewsModelUrl(listingId: string): string {
  return `https://reviews.yandex.ru/product/model--${listingId}`;
}

function actorItemError(record: JsonRecord): string | undefined {
  const error = record.error ?? record.errorInfo;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    return nonEmptyString(error.message) ?? nonEmptyString(error.type) ?? nonEmptyString(error.code);
  }
  if (typeof record.status === "string" && /failed|aborted|timed.?out/i.test(record.status)) {
    return record.status;
  }
  return undefined;
}

function quotaMessage(message: string): boolean {
  return /quota|credit|billing|payment.required|monthly.usage|usage.limit|not.enough.usage|max.total.charge|plan.required/i.test(
    message
  );
}

function throwActorFailure(message: string, status?: number): never {
  const safe = message.slice(0, 500);
  if (status === 402 || quotaMessage(safe)) {
    throw new AdapterQuotaError(`Apify quota or cost limit prevented Yandex collection: ${safe}`);
  }
  throw new AdapterBlockedError(`Yandex Apify collection is temporarily blocked: ${safe}`);
}

function errorText(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return fallback;
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const type = nonEmptyString(error.type);
    const message = nonEmptyString(error.message);
    if (type || message) return [type, message].filter(Boolean).join(": ");
  }
  return nonEmptyString(payload.message) ?? nonEmptyString(payload.statusMessage) ?? fallback;
}

async function responseErrorText(response: Response): Promise<string> {
  const fallback = `Apify HTTP ${response.status}`;
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      return errorText(JSON.parse(text) as unknown, fallback).slice(0, 500);
    } catch {
      return text.trim().slice(0, 500);
    }
  } catch {
    return fallback;
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function waitForReviewsRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortReason(signal) : new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableReviewsStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function withReviewsRetry(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init): Promise<Response> => {
    const signal = init?.signal;
    let lastNetworkError: unknown;

    for (let attempt = 1; attempt <= REVIEWS_FETCH_MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw abortReason(signal);

      let response: Response;
      try {
        response = await fetchImpl(input, init);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        lastNetworkError = error;
        if (attempt === REVIEWS_FETCH_MAX_ATTEMPTS) throw error;
        await waitForReviewsRetry(REVIEWS_FETCH_RETRY_DELAYS_MS[attempt - 1], signal);
        continue;
      }

      if (!isRetryableReviewsStatus(response.status) || attempt === REVIEWS_FETCH_MAX_ATTEMPTS) {
        return response;
      }

      // The retry response is deliberately discarded; cancelling its body
      // avoids holding a connection while the bounded backoff is running.
      try {
        await response.body?.cancel();
      } catch {
        // A locked or already-consumed body does not change retry semantics.
      }
      await waitForReviewsRetry(REVIEWS_FETCH_RETRY_DELAYS_MS[attempt - 1], signal);
    }

    // The loop is exhaustive, but keeping a hard failure here preserves the
    // fail-closed contract if its bounds are changed later.
    throw lastNetworkError ?? new AdapterBlockedError("Yandex Reviews retry attempts were exhausted");
  };
}

function parseMatchingProduct(record: JsonRecord, brand: string): ParsedProduct | undefined {
  const actorError = actorItemError(record);
  if (actorError) throwActorFailure(actorError);

  const title = nonEmptyString(record.title);
  if (!title) throw new ParserChangedError("Yandex Market actor returned a product without a title");

  // Search results may include incomplete adjacent products. Once the title
  // proves that an item is unrelated to the requested trade name, none of its
  // optional enrichment fields are part of this adapter's schema contract.
  if (!matchesBrand(title, brand)) return undefined;

  const listingId = normalizeModelId(record.modelId);
  if (!listingId) {
    throw new ParserChangedError("Yandex Market actor returned a product without a valid modelId");
  }

  const rawReviewCount = record.reviewCount;
  const reviews = parseReviewCount(rawReviewCount);
  if (reviews === undefined) {
    throw new MissingReviewCountError(
      `Yandex Market model ${listingId} has no valid reviewCount; ratingCount is not a substitute`
    );
  }

  return {
    listingId,
    title,
    duplicateCount: 1
  };
}

function mergeDuplicate(existing: ParsedProduct, incoming: ParsedProduct): ParsedProduct {
  return {
    ...existing,
    duplicateCount: existing.duplicateCount + incoming.duplicateCount
  };
}

export class YandexApifyAdapter implements SiteAdapter {
  readonly id = "yandex";
  readonly supportedDomains = ["market.yandex.ru", "reviews.yandex.ru"] as const;

  private readonly token?: string;
  private readonly actorId: string;
  private readonly apiBaseUrl: string;
  private readonly maxItems: number;
  private readonly maxTotalChargeUsd: number;
  private readonly timeoutSeconds: number;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly reviewsFetch?: typeof globalThis.fetch;
  private readonly reviewsAdapter: YandexAdapter;
  private readonly now: () => Date;

  constructor(options: YandexApifyAdapterOptions = {}) {
    this.token = options.token?.trim() || envValue("APIFY_TOKEN");
    this.actorId = (options.actorId ?? DEFAULT_ACTOR_ID).replace("/", "~");
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.maxItems = integerInRange(
      options.maxItems ?? numericEnv("YANDEX_APIFY_MAX_ITEMS") ?? DEFAULT_MAX_ITEMS,
      "maxItems",
      1,
      MAX_ACTOR_ITEMS
    );
    this.maxTotalChargeUsd = numberInRange(
      options.maxTotalChargeUsd ??
        numericEnv("YANDEX_APIFY_MAX_TOTAL_CHARGE_USD") ??
        DEFAULT_MAX_TOTAL_CHARGE_USD,
      "maxTotalChargeUsd",
      0,
      ABSOLUTE_MAX_TOTAL_CHARGE_USD
    );
    this.timeoutSeconds = integerInRange(
      options.timeoutSeconds ?? numericEnv("YANDEX_APIFY_TIMEOUT_SECONDS") ?? DEFAULT_TIMEOUT_SECONDS,
      "timeoutSeconds",
      1,
      MAX_SYNC_TIMEOUT_SECONDS
    );
    this.fetchImpl = options.fetch;
    this.now = options.now ?? (() => new Date());
    const reviewsFetch = options.reviewsFetch ?? globalThis.fetch;
    this.reviewsFetch = typeof reviewsFetch === "function" ? withReviewsRetry(reviewsFetch) : reviewsFetch;
    this.reviewsAdapter = new YandexAdapter({ fetch: this.reviewsFetch, now: this.now });

    if (!/^[\w-]+~[\w-]+$/i.test(this.actorId)) {
      throw new TypeError("actorId must look like owner~actor-name");
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

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const requestedBrand = brand.normalize("NFKC").trim();
    if (!requestedBrand) throw new TypeError("brand must not be empty");

    const endpoint = new URL(
      `${this.apiBaseUrl}/v2/acts/${this.actorId}/run-sync-get-dataset-items`
    );
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: requestedBrand,
          maxItems: this.maxItems,
          region: MOSCOW_REGION_ID,
          enrichProducts: true,
          includeReviews: false
        }),
        signal: context.signal
      });
    } catch (error) {
      if (error instanceof AdapterBlockedError || error instanceof AdapterQuotaError || isAbortError(error)) {
        throw error;
      }
      throw new AdapterBlockedError(
        `Unable to reach Apify for Yandex collection: ${error instanceof Error ? error.message : "network error"}`
      );
    }

    if (!response.ok) throwActorFailure(await responseErrorText(response), response.status);

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      throw new ParserChangedError("Apify returned non-JSON data for Yandex Market");
    }
    if (!Array.isArray(payload)) {
      throw new ParserChangedError("Apify returned an unexpected Yandex Market dataset shape");
    }
    if (payload.length >= this.maxItems) {
      throw new AdapterQuotaError(
        `Yandex Market search reached the configured ${this.maxItems}-item safety cap; complete discovery was not proven`
      );
    }

    const products = new Map<string, ParsedProduct>();
    const incompleteMatchingItems: MissingReviewCountError[] = [];
    for (const item of payload) {
      if (!isRecord(item)) {
        throw new ParserChangedError("Yandex Market dataset contains a non-object item");
      }
      let parsed: ParsedProduct | undefined;
      try {
        parsed = parseMatchingProduct(item, requestedBrand);
      } catch (error) {
        if (error instanceof MissingReviewCountError) {
          incompleteMatchingItems.push(error);
          continue;
        }
        throw error;
      }
      if (!parsed) continue;
      const previous = products.get(parsed.listingId);
      products.set(parsed.listingId, previous ? mergeDuplicate(previous, parsed) : parsed);
    }

    // A single incomplete search result must not discard other verified cards.
    // If every matching result lacks written-review data, the actor schema is
    // unusable and discovery still fails closed instead of using ratingCount.
    if (products.size === 0 && incompleteMatchingItems.length > 0) {
      throw incompleteMatchingItems[0];
    }

    const capturedAt = this.now().toISOString();
    return [...products.values()].map((product): ProductRef => ({
      domain: "market.yandex.ru",
      platform: this.id,
      listingId: product.listingId,
      brand: requestedBrand,
      url: reviewsModelUrl(product.listingId),
      title: product.title,
      metadata: {
        duplicateCount: product.duplicateCount,
        collector: "yandex-apify",
        capturedAt,
        source: SOURCE
      }
    }));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = normalizeModelId(ref.listingId);
    if (!listingId) throw new ParserChangedError("Yandex ProductRef contains an invalid modelId");
    const title = nonEmptyString(ref.title);
    if (!title) throw new ParserChangedError("Yandex ProductRef is missing its title");
    if (typeof this.reviewsFetch !== "function") {
      throw new AdapterBlockedError("Direct fetch is unavailable for Yandex Reviews collection");
    }

    // Ignore offer-level metrics and URLs from the actor. The stable modelId is
    // resolved through the fixed Reviews origin, whose strict adapter reads
    // AggregateRating.reviewCount and ratingValue from Product JSON-LD.
    return this.reviewsAdapter.collect({
      ...ref,
      listingId,
      url: reviewsModelUrl(listingId),
      title
    }, {
      ...context,
      fetch: this.reviewsFetch
    });
  }

  private fetchFor(context: AdapterContext): typeof globalThis.fetch {
    const fetchImpl = context.fetch ?? this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new AdapterBlockedError("No fetch implementation is available for the Yandex Apify adapter");
    }
    return fetchImpl;
  }

  private authorizationHeaders(): HeadersInit {
    if (!this.token) {
      throw new AdapterBlockedError("APIFY_TOKEN is not configured for Yandex collection");
    }
    return { Accept: "application/json", Authorization: `Bearer ${this.token}` };
  }
}

export function createYandexApifyAdapter(
  options: YandexApifyAdapterOptions = {}
): YandexApifyAdapter {
  return new YandexApifyAdapter(options);
}

export function isYandexApifyRef(ref: ProductRef): boolean {
  return ref.metadata.collector === "yandex-apify";
}

export default YandexApifyAdapter;
