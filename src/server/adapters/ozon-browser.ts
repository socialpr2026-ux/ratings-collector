import { load } from "cheerio";
import type {
  AdapterActivityEvent,
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { matchesBrand, normalizeRating } from "../utils/normalize.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const SEARCH_ENDPOINT = "https://www.ozon.ru/api/composer-api.bx/page/json/v2";
const TRANSLATE_ORIGIN = "https://www-ozon-ru.translate.goog";
const PLATFORM_DOMAIN = "ozon.ru";
const PLATFORM_ID = "ozon";
const SOURCE = "ozon:composer-api:edgeone-browser";
const TRANSLATE_SOURCE = "ozon:search-html:google-translate";
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_DOCUMENT_BYTES = 15_000_000;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const MAX_TRANSLATE_REDIRECTS = 2;
const EXACT_TRANSLATE_PROOF = "ozon:product-json-ld:google-translate";

type JsonObject = Record<string, unknown>;

type ActivityInput = Omit<AdapterActivityEvent, "status">;

async function reportActivity(context: AdapterContext, event: AdapterActivityEvent): Promise<void> {
  try { await context.activity?.(event); }
  catch { /* progress telemetry must never change collector semantics */ }
}

async function withActivity<T>(
  context: AdapterContext,
  input: ActivityInput,
  work: () => Promise<T>
): Promise<T> {
  await reportActivity(context, { ...input, status: "active" });
  try {
    const value = await work();
    await reportActivity(context, { ...input, status: "complete" });
    return value;
  } catch (error) {
    await reportActivity(context, {
      ...input,
      status: "warning",
      detail: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

type SearchTile = {
  listingId: string;
  title: string;
  url: string;
  reviews: number | null;
  rating: number | null;
  rawRating: unknown;
  rawReviewCount: unknown;
  source: typeof SOURCE | typeof TRANSLATE_SOURCE;
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
  detailConcurrency?: number;
  now?: () => Date;
  /** Test-only escape hatch for composer-specific fixtures. Production stays translate-first. */
  translateEnabled?: boolean;
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
    rawReviewCount,
    source: SOURCE
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

function canonicalTranslatedProduct(value: string): { listingId: string; url: string } {
  const url = new URL(value, TRANSLATE_ORIGIN);
  if (!["www-ozon-ru.translate.goog", "www.ozon.ru"].includes(url.hostname)) {
    throw new ParserChangedError(`Ozon translated tile linked to unexpected host ${url.hostname}`);
  }
  const segment = url.pathname.match(/^\/product\/([^/]+)\/?$/i)?.[1];
  const listingId = segment ? skuFromUrl(`/product/${segment}/`) : undefined;
  if (!segment || !listingId) throw new ParserChangedError("Ozon translated tile has no stable product SKU");
  return { listingId, url: `https://www.ozon.ru/product/${segment}/` };
}

function parsedReviewLabel(value: string): number | null {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
  const match = normalized.match(
    /^([\d\s\u00a0\u202f]+)\s*\u043e\u0442\u0437\u044b\u0432(?:\u0430|\u043e\u0432)?$/iu
  );
  if (!match) return null;
  const count = Number(match[1]!.replace(/[\s\u00a0\u202f]+/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function parseTranslatedTile($: ReturnType<typeof load>, element: Parameters<ReturnType<typeof load>>[0]): SearchTile {
  const tile = $(element);
  const anchors = tile.find('a[href*="/product/"]').toArray();
  if (anchors.length === 0) throw new ParserChangedError("Ozon translated tile has no product link");

  const links = anchors.map((anchor) => canonicalTranslatedProduct($(anchor).attr("href") ?? ""));
  const listingIds = new Set(links.map((link) => link.listingId));
  if (listingIds.size !== 1) throw new ParserChangedError("Ozon translated tile links to multiple product SKUs");
  const listingId = links[0]!.listingId;
  const title = anchors
    .map((anchor) => $(anchor).text().normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0];
  if (!title) throw new ParserChangedError("Ozon translated tile has no product title");

  const reviewSpans = tile.find("span").toArray().filter((span) => parsedReviewLabel($(span).text()) !== null);
  if (reviewSpans.length > 1) throw new ParserChangedError("Ozon translated tile exposes multiple review counters");

  let reviews: number | null = null;
  let parsedRating: number | null = null;
  let rawReviewCount: unknown = null;
  let rawRating: unknown = null;
  if (reviewSpans.length === 1) {
    const reviewSpan = $(reviewSpans[0]!);
    const metricRow = reviewSpan.parent();
    if (metricRow.find('svg[style*="graphicRating"]').length !== 1) {
      throw new ParserChangedError("Ozon translated review counter is not paired with one rating marker");
    }
    const ratingValues = metricRow.find("span").toArray()
      .map((span) => $(span).text().normalize("NFKC").trim())
      .filter((text) => /^[0-5](?:[.,]\d+)?$/.test(text));
    if (ratingValues.length !== 1) {
      throw new ParserChangedError("Ozon translated review counter is not paired with one numeric rating");
    }
    rawReviewCount = reviewSpan.text().normalize("NFKC").trim();
    reviews = parsedReviewLabel(String(rawReviewCount))!;
    rawRating = ratingValues[0]!;
    parsedRating = rating(rawRating);
    if (parsedRating === null || parsedRating <= 0 || reviews === null || reviews <= 0) {
      throw new ParserChangedError("Ozon translated tile returned inconsistent review metrics");
    }
  } else {
    const ratingMarkers = tile.find('svg[style*="graphicRating"]');
    if (ratingMarkers.length > 1) throw new ParserChangedError("Ozon translated tile exposes multiple rating markers");
    if (ratingMarkers.length === 1) {
      const metricRow = ratingMarkers.first().parent();
      const ratingValues = metricRow.find("span").toArray()
        .map((span) => $(span).text().normalize("NFKC").trim())
        .filter((text) => /^[0-5](?:[.,]\d+)?$/.test(text));
      if (ratingValues.length !== 1) throw new ParserChangedError("Ozon translated tile has an ambiguous numeric rating");
      rawRating = ratingValues[0]!;
      parsedRating = rating(rawRating);
      if (parsedRating === null || parsedRating <= 0) throw new ParserChangedError("Ozon translated tile has an invalid rating");
      rawReviewCount = metricRow.text().normalize("NFKC").replace(/\s+/g, " ").trim();
    }
  }

  return {
    listingId,
    title,
    url: links[0]!.url,
    reviews,
    rating: parsedRating,
    rawRating,
    rawReviewCount,
    source: TRANSLATE_SOURCE
  };
}

const ALLOWED_OZON_SEARCH_PARAMETERS = new Set([
  "brand",
  "brand_was_predicted",
  "category_was_predicted",
  "deny_category_prediction",
  "from_global",
  "page",
  "text"
]);

function validateTranslatedTarget(target: URL, brand: string, page: number): void {
  const isSearch = target.pathname === "/search/";
  const isCategory = /^\/category\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\/$/i.test(target.pathname);
  if (target.protocol !== "https:" || target.hostname !== "www.ozon.ru" || target.hash || (!isSearch && !isCategory)) {
    throw new ParserChangedError("Ozon translated search redirected outside the allowed search/category path");
  }
  if ([...target.searchParams.keys()].some((key) => !ALLOWED_OZON_SEARCH_PARAMETERS.has(key))) {
    throw new ParserChangedError("Ozon translated search added an unexpected query parameter");
  }
  if (target.searchParams.get("text")?.normalize("NFKC").trim() !== brand || target.searchParams.get("from_global") !== "true") {
    throw new ParserChangedError("Ozon translated search changed the requested brand");
  }
  const requestedPage = target.searchParams.get("page");
  if (page === 1 ? requestedPage !== null && requestedPage !== "1" : requestedPage !== String(page)) {
    throw new ParserChangedError("Ozon translated search changed the requested page");
  }
  if (isCategory && (
    target.searchParams.get("category_was_predicted") !== "true" ||
    target.searchParams.get("deny_category_prediction") !== "true" ||
    target.searchParams.has("brand_was_predicted") && target.searchParams.get("brand_was_predicted") !== "true"
  )) {
    throw new ParserChangedError("Ozon translated category redirect has no prediction proof");
  }
  if (isSearch && target.searchParams.has("brand")) {
    const predictedBrandId = target.searchParams.get("brand") ?? "";
    if (
      !/^\d{1,18}$/.test(predictedBrandId) ||
      target.searchParams.get("brand_was_predicted") !== "true" ||
      target.searchParams.get("deny_category_prediction") !== "true" ||
      target.searchParams.has("category_was_predicted")
    ) {
      throw new ParserChangedError("Ozon translated brand redirect has no exact prediction proof");
    }
  } else if (isSearch && (
    target.searchParams.has("brand_was_predicted") ||
    target.searchParams.has("deny_category_prediction") ||
    target.searchParams.has("category_was_predicted")
  )) {
    throw new ParserChangedError("Ozon translated search has incomplete prediction parameters");
  }
}

function targetSignature(target: URL): string {
  const parameters = [...target.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );
  return `${target.protocol}//${target.hostname}${target.pathname}?${new URLSearchParams(parameters).toString()}`;
}

function translatedProxyUrl(target: URL): URL {
  const proxy = new URL(`${target.pathname}${target.search}`, TRANSLATE_ORIGIN);
  proxy.searchParams.set("_x_tr_sl", "ru");
  proxy.searchParams.set("_x_tr_tl", "en");
  proxy.searchParams.set("_x_tr_hl", "en");
  return proxy;
}

function translatedRedirect(html: string): URL | undefined {
  const encoded = html.match(/location\.replace\(("(?:\\.|[^"\\])*")\)/)?.[1];
  if (!encoded) return undefined;
  try {
    return new URL(JSON.parse(encoded) as string);
  } catch {
    throw new ParserChangedError("Ozon translated search returned an invalid client redirect");
  }
}

function parseTranslatedSearchPage(html: string, target: URL, page: number): SearchPage {
  if (!/<\/html>\s*$/i.test(html) || !html.includes("window.__NUXT__.state=")) {
    throw new ParserChangedError("Ozon translated search returned incomplete server-rendered HTML");
  }
  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href");
  if (!baseValue) throw new ParserChangedError("Ozon translated search has no source URL proof");
  const base = new URL(baseValue);
  if (targetSignature(base) !== targetSignature(target)) {
    throw new ParserChangedError("Ozon translated search returned a different source page");
  }

  const state = $("script").toArray()
    .map((script) => $(script).text())
    .find((text) => text.includes("window.__NUXT__.state="));
  if (!state) throw new ParserChangedError("Ozon translated search has no application state");
  const totals = [...state.matchAll(/"totalPages":(\d+)/g)].map((match) => Number(match[1]));
  const distinctTotals = [...new Set(totals)];
  if (distinctTotals.length !== 1 || !Number.isSafeInteger(distinctTotals[0]) || distinctTotals[0]! < 0) {
    throw new ParserChangedError("Ozon translated search has no unambiguous totalPages value");
  }

  const roots = $('[data-widget="tileGridDesktop"] .tile-root').toArray();
  const explicitEmpty = state.includes("catalog.searchEmptyState");
  if (explicitEmpty) {
    if (roots.length > 0) throw new ParserChangedError("Ozon translated search exposes products and an empty-state together");
    return { items: [], rawItemCount: 0, totalPages: 0 };
  }
  if (roots.length === 0) throw new ParserChangedError("Ozon translated search has no product grid and no empty-state proof");
  const declaredTotalPages = distinctTotals[0]!;
  if (declaredTotalPages < page) {
    throw new ParserChangedError("Ozon translated search returned products beyond its declared page count");
  }
  const items = roots.map((root) => parseTranslatedTile($, root));
  if (items.length !== roots.length) throw new ParserChangedError("Ozon translated search did not parse every product tile");
  return { items, rawItemCount: roots.length, totalPages: declaredTotalPages };
}

type ExactProductMetrics = {
  product: string;
  reviews: number;
  rating: number | null;
  rawRating: number | null;
  aggregateGroupId?: string;
};

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stopped && cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(values[index]!);
      } catch (error) {
        if (!stopped) firstError = error;
        stopped = true;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

function exactNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function productJsonLdEntries(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(productJsonLdEntries);
  if (!isObject(value)) return [];
  const graph = Array.isArray(value["@graph"]) ? value["@graph"]!.flatMap(productJsonLdEntries) : [];
  return [value, ...graph];
}

function parseExactProductMetrics(html: string, target: URL, listingId: string): ExactProductMetrics {
  if (!/<\/html>\s*$/i.test(html) || !html.includes("window.__NUXT__.state=")) {
    throw new ParserChangedError("Ozon translated product returned incomplete server-rendered HTML");
  }
  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href");
  if (!baseValue || targetSignature(new URL(baseValue)) !== targetSignature(target)) {
    throw new ParserChangedError("Ozon translated product returned a different source page");
  }

  const products: JsonObject[] = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      products.push(...productJsonLdEntries(JSON.parse($(script).text()) as unknown));
    } catch {
      throw new ParserChangedError("Ozon translated product JSON-LD is invalid");
    }
  }
  const product = products.find((entry) =>
    (entry["@type"] === "Product" || (Array.isArray(entry["@type"]) && entry["@type"].includes("Product"))) &&
    asSku(entry.sku) === listingId
  );
  const title = product ? asString(product.name) : undefined;
  if (!product || !title) throw new ParserChangedError("Ozon translated product has no matching Product JSON-LD");

  const variantIds = new Set<string>([listingId]);
  const compactVariantProof = $('meta[name="ratings-ozon-variant-skus"][content]').first().attr("content");
  if (compactVariantProof) {
    const ids = compactVariantProof.split(",").map((value) => asSku(value));
    if (ids.some((value) => !value) || !ids.includes(listingId) || new Set(ids).size !== ids.length) {
      throw new ParserChangedError("Ozon compact variant proof is invalid");
    }
    ids.forEach((value) => variantIds.add(value!));
  } else {
    $('a[href*="/product/"][href*="from_sku="]').each((_index, node) => {
      const raw = $(node).attr("href");
      if (!raw) return;
      try {
        const link = new URL(raw, TRANSLATE_ORIGIN);
        if (!["www.ozon.ru", "ozon.ru", "www-ozon-ru.translate.goog"].includes(link.hostname) ||
          link.searchParams.get("from_sku") !== listingId || link.searchParams.get("oos_search") !== "false") return;
        const targetId = skuFromUrl(link.toString());
        if (targetId) variantIds.add(targetId);
      } catch { /* unrelated malformed storefront link */ }
    });
  }
  const aggregateGroupId = variantIds.size > 1
    ? `ozon:variants:${[...variantIds].sort((left, right) => Number(left) - Number(right)).join(",")}`
    : undefined;

  const scoreValue = $('[id^="state-webSingleProductScore"]').first().attr("data-state");
  if (!scoreValue) throw new ParserChangedError("Ozon translated product has no review score proof");
  let score: JsonObject;
  try {
    const parsed = JSON.parse(scoreValue) as unknown;
    if (!isObject(parsed)) throw new Error("non-object");
    score = parsed;
  } catch {
    throw new ParserChangedError("Ozon translated product review score is invalid JSON");
  }
  const scoreText = asString(score.text)?.replace(/\s+/g, " ") ?? "";
  const aggregate = isObject(product.aggregateRating) ? product.aggregateRating : undefined;
  if (!aggregate) {
    if (!/^\u043d\u0435\u0442 \u043e\u0442\u0437\u044b\u0432\u043e\u0432$/iu.test(scoreText)) {
      throw new ParserChangedError("Ozon translated product has no AggregateRating and no explicit zero-review proof");
    }
    return { product: title, reviews: 0, rating: null, rawRating: null, ...(aggregateGroupId ? { aggregateGroupId } : {}) };
  }

  const reviews = exactNonNegativeInteger(aggregate.reviewCount);
  const rawRating = rating(aggregate.ratingValue);
  if (reviews === null || reviews <= 0 || rawRating === null || rawRating <= 0) {
    throw new ParserChangedError("Ozon translated product AggregateRating is incomplete");
  }
  const scoreMatch = scoreText.match(/^([0-5](?:[.,]\d+)?)\s*[\u2022\u00b7]\s*([\d\s\u00a0\u202f]+)\s*\u043e\u0442\u0437\u044b\u0432(?:\u0430|\u043e\u0432)?$/iu);
  const scoreReviews = scoreMatch ? exactNonNegativeInteger(scoreMatch[2]!.replace(/[\s\u00a0\u202f]+/g, "")) : null;
  const scoreRating = scoreMatch ? rating(scoreMatch[1]) : null;
  if (scoreReviews !== reviews || scoreRating !== rawRating) {
    throw new ParserChangedError("Ozon translated product JSON-LD and visible review score disagree");
  }
  return {
    product: title,
    reviews,
    rating: normalizeRating(rawRating, 5),
    rawRating,
    ...(aggregateGroupId ? { aggregateGroupId } : {})
  };
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
  private readonly translateEnabled: boolean;
  private readonly detailConcurrency: number;

  constructor(options: OzonBrowserAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.now = options.now ?? (() => new Date());
    this.translateEnabled = options.translateEnabled ?? true;
    this.detailConcurrency = options.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) {
      throw new RangeError("Ozon browser maxPages must be an integer from 1 to 100");
    }
    if (!Number.isInteger(this.detailConcurrency) || this.detailConcurrency < 1 || this.detailConcurrency > 8) {
      throw new RangeError("Ozon detailConcurrency must be an integer from 1 to 8");
    }
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = this.now().toISOString();
    try {
      const page = await this.fetchSearchPage("Арбидол", 1, context, "health_check");
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
    const matchedProducts = [...products.values()];
    const exactMetrics = new Map<string, ExactProductMetrics>();
    await mapWithConcurrency(
      matchedProducts.filter((product) => product.source === TRANSLATE_SOURCE),
      this.detailConcurrency,
      async (product) => {
        const ref: ProductRef = {
          domain: PLATFORM_DOMAIN,
          platform: PLATFORM_ID,
          listingId: product.listingId,
          brand: requestedBrand,
          url: product.url,
          title: product.title,
          metadata: { source: product.source }
        };
        const exact = await this.fetchExactTranslatedProduct(ref, product.listingId, context);
        if (!matchesBrand(exact.product, requestedBrand)) {
          throw new ParserChangedError("Ozon translated product JSON-LD belongs to a different brand");
        }
        exactMetrics.set(product.listingId, exact);
        return exact;
      }
    );
    return matchedProducts.map((product): ProductRef => {
      const exact = exactMetrics.get(product.listingId);
      return {
      domain: PLATFORM_DOMAIN,
      platform: PLATFORM_ID,
      listingId: product.listingId,
      brand: requestedBrand,
      url: product.url,
      title: exact?.product ?? product.title,
      metadata: {
        collector: "ozon-composer",
        rating: exact ? exact.rawRating : product.rating,
        reviewCount: exact ? exact.reviews : product.reviews,
        rawRating: exact ? exact.rawRating : product.rawRating,
        rawReviewCount: product.rawReviewCount,
        capturedAt,
        source: product.source,
        ...(exact ? {
          exactProductTitle: exact.product,
          exactProductListingId: product.listingId,
          exactProductProof: EXACT_TRANSLATE_PROOF,
          ...(exact.aggregateGroupId ? { exactProductAggregateGroupId: exact.aggregateGroupId } : {})
        } : {})
      }
    };
    });
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = asSku(ref.listingId);
    let product = ref.title?.normalize("NFKC").trim();
    if (!listingId || !product) throw new ParserChangedError("Ozon composer ProductRef is incomplete");
    const source = ref.metadata.source === TRANSLATE_SOURCE ? TRANSLATE_SOURCE : SOURCE;
    let reviews = reviewCount(ref.metadata.reviewCount);
    let rawRating = rating(ref.metadata.rating);
    if (source === TRANSLATE_SOURCE) {
      const cachedTitle = asString(ref.metadata.exactProductTitle);
      const hasExactProof = ref.metadata.exactProductProof === EXACT_TRANSLATE_PROOF &&
        ref.metadata.exactProductListingId === listingId && cachedTitle !== undefined &&
        reviews !== null && (reviews === 0 ? rawRating === null : rawRating !== null && rawRating > 0);
      const exact = hasExactProof
        ? {
            product: cachedTitle,
            reviews: reviews!,
            rating: rawRating === null ? null : normalizeRating(rawRating, 5),
            rawRating,
            aggregateGroupId: asString(ref.metadata.exactProductAggregateGroupId)
          }
        : await this.fetchExactTranslatedProduct(ref, listingId, context);
      if (!matchesBrand(exact.product, ref.brand)) {
        throw new ParserChangedError("Ozon translated product JSON-LD belongs to a different brand");
      }
      product = exact.product;
      reviews = exact.reviews;
      rawRating = exact.rawRating;
      if (exact.aggregateGroupId) ref.metadata.exactProductAggregateGroupId = exact.aggregateGroupId;
    }
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
      ...(asString(ref.metadata.exactProductAggregateGroupId)
        ? { aggregateGroupId: asString(ref.metadata.exactProductAggregateGroupId)! }
        : {}),
      status,
      capturedAt: Number.isNaN(captured) ? this.now().toISOString() : new Date(captured).toISOString(),
      source
    };
  }

  private async fetchExactTranslatedProduct(
    ref: ProductRef,
    listingId: string,
    context: AdapterContext
  ): Promise<ExactProductMetrics> {
    return withActivity(context, {
      operationId: `ozon:translate-product:${listingId}`,
      stage: "collection",
      label: "Google Translate · карточка Ozon",
      listingId,
      channels: ["google_translate"]
    }, async () => {
    const target = new URL(canonicalUrl(ref.url, listingId));
    if (
      target.protocol !== "https:" || target.hostname !== "www.ozon.ru" || target.search || target.hash ||
      !/^\/product\/[a-z0-9-]+\/$/i.test(target.pathname) || skuFromUrl(target.toString()) !== listingId
    ) {
      throw new ParserChangedError("Ozon translated ProductRef is outside the fixed product path");
    }
    const endpoint = translatedProxyUrl(target);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ru-RU,ru;q=0.9",
          "cache-control": "no-cache"
        },
        signal: context.signal
      });
    } catch (error) {
      if (context.signal?.aborted) throw error;
      throw new AdapterBlockedError(`Ozon translated product request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxDocumentBytes) {
      throw new ParserChangedError("Ozon translated product exceeded the document safety limit");
    }
    const body = await response.text();
    if (body.length > this.maxDocumentBytes) throw new ParserChangedError("Ozon translated product exceeded the document safety limit");
    if ([403, 407, 423, 429, 498, 503].includes(response.status) ||
      /(?:incidentId|Antibot Captcha|abt-challenge|Target URL returned error 403)/i.test(body)) {
      throw new AdapterBlockedError(`Ozon blocked the translated product collector (HTTP ${response.status})`);
    }
    if (!response.ok) throw new AdapterBlockedError(`Ozon translated product returned HTTP ${response.status}`);
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
      throw new ParserChangedError("Ozon translated product returned non-HTML data");
    }
    if (translatedRedirect(body)) throw new ParserChangedError("Ozon translated product returned an unexpected client redirect");
    return withActivity(context, {
      operationId: `ozon:parse-product-jsonld:${listingId}`,
      stage: "parsing",
      label: "JSON-LD · рейтинг и отзывы",
      listingId,
      channels: ["google_translate"],
      parsers: ["json_ld"]
    }, async () => parseExactProductMetrics(body, target, listingId));
    });
  }

  private async fetchSearchPage(
    brand: string,
    page: number,
    context: AdapterContext,
    stage: "health_check" | "discovery" = "discovery"
  ): Promise<SearchPage> {
    let translateFailure: AdapterBlockedError | ParserChangedError | undefined;
    if (this.translateEnabled) {
      try {
        return await this.fetchTranslatedSearchPage(brand, page, context, stage);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        translateFailure = error instanceof ParserChangedError || error instanceof AdapterBlockedError
          ? error
          : new ParserChangedError(`Ozon translated search failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      return await this.fetchComposerSearchPage(brand, page, context, stage);
    } catch (composerFailure) {
      if (!translateFailure) throw composerFailure;
      const message = `Ozon translated search: ${translateFailure.message}; composer browser: ${composerFailure instanceof Error ? composerFailure.message : String(composerFailure)}`;
      if (translateFailure instanceof ParserChangedError || composerFailure instanceof ParserChangedError) {
        throw new ParserChangedError(message);
      }
      throw new AdapterBlockedError(message);
    }
  }

  private async fetchTranslatedSearchPage(
    brand: string,
    page: number,
    context: AdapterContext,
    stage: "health_check" | "discovery"
  ): Promise<SearchPage> {
    return withActivity(context, {
      operationId: `ozon:translate-search:${page}`,
      stage,
      label: "Google Translate · выдача Ozon",
      channels: ["google_translate"],
      detail: `Страница ${page}`
    }, async () => {
    const search = new URL("https://www.ozon.ru/search/");
    search.searchParams.set("text", brand);
    search.searchParams.set("from_global", "true");
    if (page > 1) search.searchParams.set("page", String(page));
    let target = search;

    for (let redirectCount = 0; redirectCount <= MAX_TRANSLATE_REDIRECTS; redirectCount += 1) {
      validateTranslatedTarget(target, brand, page);
      const endpoint = translatedProxyUrl(target);
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "ru-RU,ru;q=0.9",
            "cache-control": "no-cache"
          },
          signal: context.signal
        });
      } catch (error) {
        if (context.signal?.aborted) throw error;
        throw new AdapterBlockedError(`Ozon translated search request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxDocumentBytes) {
        throw new ParserChangedError("Ozon translated search exceeded the document safety limit");
      }
      const body = await response.text();
      if (body.length > this.maxDocumentBytes) {
        throw new ParserChangedError("Ozon translated search exceeded the document safety limit");
      }
      if ([403, 407, 423, 429, 498, 503].includes(response.status) ||
        /(?:incidentId|Antibot Captcha|abt-challenge|Target URL returned error 403)/i.test(body)) {
        throw new AdapterBlockedError(`Ozon blocked the translated search collector (HTTP ${response.status})`);
      }
      if (!response.ok) throw new AdapterBlockedError(`Ozon translated search returned HTTP ${response.status}`);
      if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
        throw new ParserChangedError("Ozon translated search returned non-HTML data");
      }

      const redirected = translatedRedirect(body);
      if (!redirected) {
        return withActivity(context, {
          operationId: `ozon:parse-search-dom:${page}`,
          stage: "parsing",
          label: "DOM · карточки выдачи",
          channels: ["google_translate"],
          parsers: ["dom"],
          detail: `Страница ${page}`
        }, async () => parseTranslatedSearchPage(body, target, page));
      }
      if (redirectCount >= MAX_TRANSLATE_REDIRECTS) {
        throw new ParserChangedError("Ozon translated search exceeded the redirect safety limit");
      }
      validateTranslatedTarget(redirected, brand, page);
      target = redirected;
    }
    throw new ParserChangedError("Ozon translated search did not reach a product page");
    });
  }

  private async fetchComposerSearchPage(
    brand: string,
    page: number,
    context: AdapterContext,
    stage: "health_check" | "discovery"
  ): Promise<SearchPage> {
    return withActivity(context, {
      operationId: `ozon:composer-browser:${page}`,
      stage,
      label: "Sandbox Chromium · Ozon API",
      channels: ["sandbox", "browser", "first_party_api"],
      detail: `Резервный канал · страница ${page}`
    }, async () => {
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
    return withActivity(context, {
      operationId: `ozon:parse-composer-json:${page}`,
      stage: "parsing",
      label: "JSON API · карточки выдачи",
      channels: ["sandbox", "browser", "first_party_api"],
      parsers: ["api_json"],
      detail: `Страница ${page}`
    }, async () => {
      try {
        return parseSearchPage(JSON.parse(body) as unknown);
      } catch (error) {
        if (error instanceof ParserChangedError) throw error;
        throw new ParserChangedError("Ozon composer returned invalid JSON");
      }
    });
    });
  }
}

export function isOzonComposerRef(ref: ProductRef): boolean {
  return ref.metadata.collector === "ozon-composer";
}
