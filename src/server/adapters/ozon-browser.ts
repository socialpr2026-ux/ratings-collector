import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { matchesBrand, normalizeRating } from "../utils/normalize.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const SEARCH_ENDPOINT = "https://www.ozon.ru/api/composer-api.bx/page/json/v2";
const PLATFORM_DOMAIN = "ozon.ru";
const PLATFORM_ID = "ozon";
const SOURCE = "ozon:composer-api:edgeone-browser";
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_DOCUMENT_BYTES = 15_000_000;

type JsonObject = Record<string, unknown>;

type SearchTile = {
  listingId: string;
  title: string;
  url: string;
  reviews: number | null;
  rating: number | null;
  rawRating: unknown;
  rawReviewCount: unknown;
};

type SearchPage = {
  items: SearchTile[];
  rawItemCount: number;
  totalPages: number | undefined;
};

export type OzonBrowserAdapterOptions = {
  fetch?: typeof globalThis.fetch;
  maxPages?: number;
  maxDocumentBytes?: number;
  now?: () => Date;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.normalize("NFKC").trim() : undefined;
}

function asSku(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== "string") return undefined;
  const compact = value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, "");
  return /^\d+$/.test(compact) && compact !== "0" ? compact.replace(/^0+(?=\d)/, "") : undefined;
}

function skuFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const path = new URL(value, "https://www.ozon.ru").pathname;
    return asSku(path.match(/(?:^|[-/])(\d{5,})(?:\/)?$/)?.[1]);
  } catch {
    return undefined;
  }
}

function canonicalUrl(value: unknown, listingId: string): string {
  const fallback = `https://www.ozon.ru/product/${listingId}/`;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value, "https://www.ozon.ru");
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (host !== "ozon.ru" && !host.endsWith(".ozon.ru")) return fallback;
    const segment = url.pathname.match(/\/product\/([^/]+)/i)?.[1];
    return segment && skuFromUrl(url.toString()) === listingId
      ? `https://www.ozon.ru/product/${segment}/`
      : fallback;
  } catch {
    return fallback;
  }
}

function compactNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/g, "").replace(",", ".");
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const multiplier = /(?:тыс|k)/i.test(normalized) ? 1_000 : /(?:млн|m)/i.test(normalized) ? 1_000_000 : 1;
  const parsed = Number(match[0]) * multiplier;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function reviewCount(value: unknown): number | null {
  const parsed = compactNumber(value);
  return parsed !== null && Number.isSafeInteger(Math.round(parsed)) ? Math.round(parsed) : null;
}

function rating(value: unknown): number | null {
  const parsed = compactNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function widgetName(key: string): string {
  return key.split("-")[0] ?? key;
}

function parsedWidgets(page: JsonObject, name: string): JsonObject[] {
  if (!isObject(page.widgetStates)) throw new ParserChangedError("Ozon composer response has no widgetStates object");
  const result: JsonObject[] = [];
  for (const [key, raw] of Object.entries(page.widgetStates)) {
    if (widgetName(key) !== name || typeof raw !== "string") continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (isObject(value)) result.push(value);
    } catch {
      throw new ParserChangedError(`Ozon composer widget ${name} is not valid JSON`);
    }
  }
  return result;
}

function textFromState(state: JsonObject): string | undefined {
  const textDs = isObject(state.textDS) ? state.textDS : undefined;
  return asString(textDs?.text);
}

function labelTexts(state: JsonObject): unknown[] {
  const label = isObject(state.labelListV2) ? state.labelListV2 : undefined;
  const items = Array.isArray(label?.items) ? label.items : [];
  return items.filter(isObject).map((item) => {
    const text = isObject(item.text) ? item.text : undefined;
    return text?.text;
  }).filter((value) => value !== undefined);
}

function parseTile(value: unknown): SearchTile | null {
  if (!isObject(value)) return null;
  const states = Array.isArray(value.mainState) ? value.mainState.filter(isObject) : [];
  const title = states.find((state) => state.id === "name") ? textFromState(states.find((state) => state.id === "name")!) : undefined;
  const action = isObject(value.action) ? value.action : undefined;
  const link = asString(action?.link);
  const listingId = asSku(value.sku) ?? asSku(value.id) ?? skuFromUrl(link);
  if (!listingId || !title) return null;

  const ratingState = states.find((state) =>
    isObject(state.labelListV2) && JSON.stringify(state.labelListV2).includes("ic_s_star")
  );
  const values = ratingState ? labelTexts(ratingState) : [];
  const rawRating = values[0];
  const rawReviewCount = values[1];
  return {
    listingId,
    title,
    url: canonicalUrl(link, listingId),
    reviews: reviewCount(rawReviewCount),
    rating: rating(rawRating),
    rawRating,
    rawReviewCount
  };
}

function totalPages(page: JsonObject): number | undefined {
  if (typeof page.shared !== "string") return undefined;
  try {
    const shared = JSON.parse(page.shared) as unknown;
    if (!isObject(shared) || !isObject(shared.catalog)) return undefined;
    const value = Number(shared.catalog.totalPages);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    throw new ParserChangedError("Ozon composer shared state is not valid JSON");
  }
}

function parseSearchPage(value: unknown): SearchPage {
  if (!isObject(value)) throw new ParserChangedError("Ozon composer returned a non-object response");
  const grids = parsedWidgets(value, "tileGridDesktop");
  const raw = grids.flatMap((grid) => Array.isArray(grid.items) ? grid.items : []);
  const items = raw.map(parseTile).filter((item): item is SearchTile => item !== null);
  if (raw.length > 0 && items.length === 0) {
    throw new ParserChangedError("Ozon search tiles no longer expose SKU and product title");
  }
  return { items, rawItemCount: raw.length, totalPages: totalPages(value) };
}

function blockedBody(value: string): boolean {
  return /(?:captcha|antibot|access denied|доступ (?:ограничен|запрещен)|вы робот|variti)/i.test(value);
}

export class OzonBrowserAdapter implements SiteAdapter {
  readonly id = PLATFORM_ID;
  readonly supportedDomains = [PLATFORM_DOMAIN, "www.ozon.ru"] as const;

  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxPages: number;
  private readonly maxDocumentBytes: number;
  private readonly now: () => Date;

  constructor(options: OzonBrowserAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) {
      throw new RangeError("Ozon browser maxPages must be an integer from 1 to 100");
    }
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = this.now().toISOString();
    try {
      const page = await this.fetchSearchPage("Арбидол", 1, context);
      if (page.rawItemCount === 0) throw new ParserChangedError("Ozon canary search returned no tiles");
      return { ok: true, checkedAt, message: "Ozon composer search schema is valid" };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const requestedBrand = brand.normalize("NFKC").trim();
    if (!requestedBrand) throw new TypeError("brand must not be empty");
    const products = new Map<string, SearchTile>();
    let previousPageIds: string | undefined;
    let declaredTotalPages: number | undefined;
    let exhausted = false;

    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
      const page = await this.fetchSearchPage(requestedBrand, pageNumber, context);
      if (page.totalPages !== undefined && page.totalPages > this.maxPages) {
        throw new AdapterBlockedError(
          `Ozon search for ${requestedBrand} has ${page.totalPages} pages, above the safe limit ${this.maxPages}`
        );
      }
      if (page.totalPages !== undefined) {
        if (page.rawItemCount > 0 && page.totalPages === 0) {
          throw new ParserChangedError(`Ozon search for ${requestedBrand} returned items with totalPages=0`);
        }
        declaredTotalPages = Math.max(declaredTotalPages ?? 0, page.totalPages);
      }
      if (page.rawItemCount === 0) {
        if (declaredTotalPages !== undefined && declaredTotalPages >= pageNumber) {
          throw new AdapterBlockedError(
            `Ozon search for ${requestedBrand} returned an empty page ${pageNumber} before declared page ${declaredTotalPages}`
          );
        }
        exhausted = true;
        break;
      }
      const pageIds = page.items.map((item) => item.listingId).join(",");
      if (previousPageIds !== undefined && pageIds === previousPageIds) {
        throw new AdapterBlockedError(`Ozon repeated a search page for ${requestedBrand}; discovery was stopped fail-closed`);
      }
      previousPageIds = pageIds;
      for (const item of page.items) {
        if (matchesBrand(item.title, requestedBrand)) products.set(item.listingId, item);
      }
      if (declaredTotalPages !== undefined && pageNumber >= declaredTotalPages) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted) {
      throw new AdapterBlockedError(
        `Ozon search for ${requestedBrand} reached the ${this.maxPages}-page safety limit without proving exhaustion`
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
        collector: "ozon-composer",
        rating: product.rating,
        reviewCount: product.reviews,
        rawRating: product.rawRating,
        rawReviewCount: product.rawReviewCount,
        capturedAt,
        source: SOURCE
      }
    }));
  }

  async collect(ref: ProductRef, _context: AdapterContext): Promise<Observation> {
    const listingId = asSku(ref.listingId);
    const product = ref.title?.normalize("NFKC").trim();
    if (!listingId || !product) throw new ParserChangedError("Ozon composer ProductRef is incomplete");
    const reviews = reviewCount(ref.metadata.reviewCount);
    const rawRating = rating(ref.metadata.rating);
    let normalizedRating = rawRating === null ? null : normalizeRating(rawRating, 5);
    let status: Observation["status"];
    if (reviews === 0) {
      status = "no_reviews";
      normalizedRating = null;
    } else if (reviews === null || normalizedRating === null || normalizedRating === 0 || !matchesBrand(product, ref.brand)) {
      status = "needs_review";
    } else {
      status = "ok";
    }
    const captured = typeof ref.metadata.capturedAt === "string" ? Date.parse(ref.metadata.capturedAt) : Number.NaN;
    return {
      domain: PLATFORM_DOMAIN,
      platform: PLATFORM_ID,
      listingId,
      brand: ref.brand,
      canonicalUrl: canonicalUrl(ref.url, listingId),
      product,
      reviews,
      rating: normalizedRating,
      ...(rawRating === null ? {} : { rawRating, rawRatingScale: 5 }),
      status,
      capturedAt: Number.isNaN(captured) ? this.now().toISOString() : new Date(captured).toISOString(),
      source: SOURCE
    };
  }

  private async fetchSearchPage(brand: string, page: number, context: AdapterContext): Promise<SearchPage> {
    const search = new URL("https://www.ozon.ru/search/");
    search.searchParams.set("text", brand);
    search.searchParams.set("from_global", "true");
    if (page > 1) search.searchParams.set("page", String(page));
    const endpoint = new URL(SEARCH_ENDPOINT);
    endpoint.searchParams.set("url", `${search.pathname}${search.search}`);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-language": "ru-RU,ru;q=0.9",
          "x-ratings-browser": "1",
          "x-ratings-browser-mode": "ozon-composer"
        },
        signal: context.signal
      });
    } catch (error) {
      if (context.signal?.aborted) throw error;
      throw new AdapterBlockedError(`Ozon browser request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxDocumentBytes) {
      throw new ParserChangedError("Ozon composer response exceeded the document safety limit");
    }
    const body = await response.text();
    if (body.length > this.maxDocumentBytes) throw new ParserChangedError("Ozon composer response exceeded the document safety limit");
    if ([403, 407, 423, 429, 498, 503].includes(response.status) || blockedBody(body)) {
      throw new AdapterBlockedError(`Ozon blocked the browser collector (HTTP ${response.status})`);
    }
    if (!response.ok) throw new AdapterBlockedError(`Ozon composer returned HTTP ${response.status}`);
    try {
      return parseSearchPage(JSON.parse(body) as unknown);
    } catch (error) {
      if (error instanceof ParserChangedError) throw error;
      throw new ParserChangedError("Ozon composer returned invalid JSON");
    }
  }
}

export function isOzonComposerRef(ref: ProductRef): boolean {
  return ref.metadata.collector === "ozon-composer";
}
