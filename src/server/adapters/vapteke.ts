import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { extractPageProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "vapteke.ru";
const ORIGIN = `https://${DOMAIN}`;
const AUTOCOMPLETE_URL = `${ORIGIN}/ajax/autocomplete`;
const HEALTH_LISTING_ID = "365917";
const HEALTH_BRAND = "АкваОптик";
const HEALTH_URL = `${ORIGIN}/product/rastvor-dlya-uhoda-za-kontaktnymi-linzami-akvaoptik-mnogofunktsionalnyy-60-ml-${HEALTH_LISTING_ID}`;
const MAX_API_BYTES = 2_000_000;
const MAX_DOCUMENT_BYTES = 8_000_000;
const STATIC_RETRY_DELAY_MS = 250;
const PRODUCT_PATH = /^\/product\/([a-z0-9-]+)-(\d+)\/?$/i;
const BLOCK_MARKERS = /captcha|access denied|forbidden|too many requests|cloudflare|qrator|доступ (?:ограничен|запрещ[её]н)|слишком много запросов|провер(?:ка|ьте),? что вы не робот|подтвердите,? что вы человек/i;

type JsonObject = Record<string, unknown>;

type AutocompleteHit = {
  productId: string;
  name: string;
  slug: string;
};

type ProductPage = {
  title: string;
  canonicalUrl: string;
  rating: number;
  ratingCount: number;
};

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeHost(hostname: string): string {
  return hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\s\u00a0]/gu, "");
  if (!/^\d+$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function ratingValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

function listingIdFromUrl(value: string | URL): string | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || normalizeHost(url.hostname) !== DOMAIN) return undefined;
    return url.pathname.match(PRODUCT_PATH)?.[2];
  } catch {
    return undefined;
  }
}

function productUrlFromSlug(slug: string, listingId: string): string | undefined {
  if (!/^[a-z0-9-]+$/iu.test(slug) || !slug.endsWith(`-${listingId}`)) return undefined;
  const url = `${ORIGIN}/product/${slug}`;
  return listingIdFromUrl(url) === listingId ? url : undefined;
}

function canonicalProductUrl(value: string, listingId: string): string | undefined {
  try {
    const url = new URL(value, ORIGIN);
    if (listingIdFromUrl(url) !== listingId) return undefined;
    return canonicalizeUrl(url.toString());
  } catch {
    return undefined;
  }
}

function isBlockedBody(body: string): boolean {
  const sample = body.slice(0, 250_000);
  return BLOCK_MARKERS.test(sample) || /<(?:iframe|input)\b[^>]*(?:captcha|challenge)/iu.test(sample);
}

function blockedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 498 || status >= 500;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function jsonLdProducts(html: string): JsonObject[] {
  const $ = load(html);
  const products: JsonObject[] = [];
  const seen = new Set<object>();

  function visit(value: unknown, depth = 0): void {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object" || seen.has(value as object)) return;
    seen.add(value as object);
    const object = value as JsonObject;
    const types = (Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]])
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeText(item));
    if (types.includes("product")) products.push(object);
    for (const child of Object.values(object).slice(0, 200)) visit(child, depth + 1);
  }

  $("script[type='application/ld+json']").each((_index, node) => {
    const source = $(node).text().trim().replace(/^<!--|-->$/gu, "").replace(/^<!\[CDATA\[|\]\]>$/gu, "");
    if (!source || source.length > 1_500_000) return;
    try { visit(JSON.parse(source)); }
    catch { /* Invalid unrelated JSON-LD is ignored; the exact Product is still mandatory. */ }
  });
  return products;
}

function parseAutocomplete(body: string, brand: string): AutocompleteHit[] {
  let root: JsonObject;
  try { root = objectValue(JSON.parse(body)) ?? {}; }
  catch { throw new ParserChangedError(`${DOMAIN}: autocomplete returned invalid JSON`); }
  const data = objectValue(root.data);
  const total = objectValue(data?.total);
  const hits = data?.hits;
  const totalValue = safeInteger(total?.value);
  if (root.success !== true || root.error !== "200" || total?.relation !== "eq" || totalValue === undefined || !Array.isArray(hits)) {
    throw new ParserChangedError(`${DOMAIN}: autocomplete did not prove an exact complete result set`);
  }

  const exactById = new Map<string, AutocompleteHit>();
  const idBySlug = new Map<string, string>();
  for (const rawHit of hits) {
    const hit = objectValue(rawHit);
    const numericId = safeInteger(hit?.product_id);
    const productId = numericId === undefined ? undefined : String(numericId);
    const name = typeof hit?.name === "string" ? compactText(hit.name) : "";
    if (!productId || !name || !matchesBrand(name, brand)) continue;
    if (hit?.is_active !== true || typeof hit.slug !== "string") {
      throw new ParserChangedError(`${DOMAIN}: exact autocomplete hit is inactive or incomplete`);
    }
    const slug = hit.slug.trim();
    if (!productUrlFromSlug(slug, productId)) {
      throw new ParserChangedError(`${DOMAIN}: exact autocomplete hit has an invalid product URL`);
    }
    const parsed = { productId, name, slug };
    const existing = exactById.get(productId);
    if (existing && (existing.slug !== slug || normalizeText(existing.name) !== normalizeText(name))) {
      throw new ParserChangedError(`${DOMAIN}: autocomplete returned ambiguous duplicate ID ${productId}`);
    }
    const existingSlugId = idBySlug.get(slug);
    if (existingSlugId && existingSlugId !== productId) {
      throw new ParserChangedError(`${DOMAIN}: autocomplete returned one slug for several products`);
    }
    exactById.set(productId, parsed);
    idBySlug.set(slug, productId);
  }

  if (exactById.size !== totalValue) {
    throw new ParserChangedError(
      `${DOMAIN}: autocomplete exact total ${totalValue} does not match ${exactById.size} unique exact hits`
    );
  }
  return [...exactById.values()];
}

function parseProductPage(html: string, listingId: string, brand: string): ProductPage {
  const $ = load(html);
  const titleNodes = $("h1.q-product__header-title");
  const title = compactText(titleNodes.first().text());
  if (titleNodes.length !== 1 || !title || !matchesBrand(title, brand)) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: exact product title or brand is not proven`);
  }

  const canonicalNodes = $("link[rel='canonical'][href]");
  const canonicalUrl = canonicalNodes.length === 1
    ? canonicalProductUrl(canonicalNodes.first().attr("href") ?? "", listingId)
    : undefined;
  if (!canonicalUrl) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: canonical URL is missing or belongs to another product`);
  }

  const products = jsonLdProducts(html);
  if (products.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: expected one exact Product JSON-LD object`);
  }
  const product = products[0];
  const jsonIdentity = [product.name, product.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (!matchesBrand(jsonIdentity, brand)) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: Product JSON-LD belongs to another brand`);
  }
  const aggregate = objectValue(product.aggregateRating);
  const structuredRating = ratingValue(aggregate?.ratingValue);
  const structuredCount = safeInteger(aggregate?.reviewCount);
  const structuredRatingCount = aggregate?.ratingCount === undefined ? undefined : safeInteger(aggregate.ratingCount);
  const bestRating = ratingValue(aggregate?.bestRating);
  const worstRating = aggregate?.worstRating === undefined ? 1 : ratingValue(aggregate.worstRating);
  if (!aggregate || structuredRating === undefined || structuredCount === undefined || structuredCount === 0 ||
      bestRating !== 5 || worstRating !== 1 ||
      structuredRatingCount !== undefined && structuredRatingCount !== structuredCount) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: Product JSON-LD has no valid positive vote aggregate`);
  }

  const visibleScopes = $("#active_rating.item-rating").filter((_index, node) =>
    $(node).find(`.item-rating-stars[data-id='${listingId}']`).length === 1
  );
  if (visibleScopes.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: exact visible rating scope is missing or duplicated`);
  }
  const visible = visibleScopes.first();
  const visibleRating = ratingValue(compactText(visible.find(".rating-value").text()));
  const voteText = compactText(visible.find(".rating-count").text());
  const voteMatch = voteText.match(/^\(?\s*([\d\s\u00a0]+)\s+голос(?:а|ов)?\s*\)?$/iu);
  const visibleCount = safeInteger(voteMatch?.[1]);
  if (visibleRating !== structuredRating || visibleCount !== structuredCount) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: visible votes do not match Product JSON-LD`);
  }

  return { title, canonicalUrl, rating: structuredRating, ratingCount: structuredCount };
}

export class VaptekeAdapter implements SiteAdapter {
  readonly id = DOMAIN;
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const { response, body } = await this.request(HEALTH_URL, context, "text/html,application/xhtml+xml");
      this.assertProductResponse(response, body, HEALTH_URL);
      parseProductPage(body, HEALTH_LISTING_ID, HEALTH_BRAND);
      return { ok: true, checkedAt, message: `${DOMAIN}: exact АкваОптик vote canary is healthy` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        checkedAt,
        message: error instanceof ParserChangedError ? `parser_changed: ${message}` : `blocked_free_mode: ${message}`
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const body = new URLSearchParams({ query: brand }).toString();
    const result = await this.request(AUTOCOMPLETE_URL, context, "application/json", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body
    }, MAX_API_BYTES);
    this.assertApiResponse(result.response, result.body);
    return parseAutocomplete(result.body, brand)
      .map((hit): ProductRef => ({
        domain: DOMAIN,
        platform: DOMAIN,
        listingId: hit.productId,
        brand,
        url: productUrlFromSlug(hit.slug, hit.productId)!,
        title: hit.name,
        metadata: { discovery: "vapteke-exact-autocomplete", searchUrl: `${ORIGIN}/search?s=${encodeURIComponent(brand)}` }
      }))
      .sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru") || Number(left.listingId) - Number(right.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const listingId = /^\d+$/u.test(ref.listingId) ? ref.listingId : undefined;
    const requestUrl = listingId ? canonicalProductUrl(ref.url, listingId) : undefined;
    if (!listingId || !requestUrl) {
      throw new ParserChangedError(`${DOMAIN}: invalid product ID or URL for ${ref.listingId}`);
    }

    const capturedAt = new Date().toISOString();
    const { response, body } = await this.request(requestUrl, context, "text/html,application/xhtml+xml");
    if (response.status === 404 || response.status === 410) {
      return {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId,
        brand: ref.brand,
        canonicalUrl: requestUrl,
        product: ref.title?.trim() || ref.brand,
        reviews: null,
        rating: null,
        status: "not_found",
        capturedAt,
        source: "vapteke-exact-product"
      };
    }
    this.assertProductResponse(response, body, requestUrl);
    const parsed = parseProductPage(body, listingId, ref.brand);
    const productEvidence = extractPageProductEvidence(body, parsed.canonicalUrl, ref.brand, {
      structuredSignals: [parsed.title]
    });
    if (!productEvidence.identifiers.some((item) => item.type === "product_id" && item.value === listingId)) {
      productEvidence.identifiers.push({ type: "product_id", value: listingId });
    }
    const source = "vapteke-product-jsonld-visible-votes";
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: requestUrl,
      status: response.status,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
      parsed: {
        listingId,
        title: parsed.title,
        canonicalUrl: parsed.canonicalUrl,
        reviews: parsed.ratingCount,
        rating: parsed.rating,
        ratingCount: parsed.ratingCount,
        countMeaning: "ratings"
      },
      productEvidence,
      source
    });

    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId,
      brand: ref.brand,
      canonicalUrl: parsed.canonicalUrl,
      product: parsed.title,
      reviews: parsed.ratingCount,
      rating: parsed.rating,
      rawRating: parsed.rating,
      rawRatingScale: 5,
      ratingCount: parsed.ratingCount,
      status: "ok",
      capturedAt,
      evidenceRef,
      productEvidence,
      source
    };
  }

  private async request(
    url: string,
    context: AdapterContext,
    accept: string,
    init: RequestInit = {},
    maxBytes = MAX_DOCUMENT_BYTES
  ): Promise<{ response: Response; body: string }> {
    const wantsHtml = /text\/html|application\/xhtml\+xml/iu.test(accept);
    const browserHeaders = new Headers(init.headers);
    browserHeaders.set("x-ratings-browser", "1");
    const browserInit = { ...init, headers: browserHeaders };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let direct: { response: Response; body: string };
      try {
        direct = await this.requestOnce(url, context, accept, init, maxBytes);
      } catch (error) {
        if (!wantsHtml) throw error;
        if (attempt === 1) return this.requestOnce(url, context, accept, browserInit, maxBytes);
        context.signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, STATIC_RETRY_DELAY_MS));
        context.signal?.throwIfAborted();
        continue;
      }
      if (!wantsHtml || !blockedStatus(direct.response.status) && !isBlockedBody(direct.body)) return direct;
      if (attempt === 1) return this.requestOnce(url, context, accept, browserInit, maxBytes);
      context.signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, STATIC_RETRY_DELAY_MS));
      context.signal?.throwIfAborted();
    }
    return this.requestOnce(url, context, accept, browserInit, maxBytes);
  }

  private async requestOnce(
    url: string,
    context: AdapterContext,
    accept: string,
    init: RequestInit,
    maxBytes: number
  ): Promise<{ response: Response; body: string }> {
    let response: Response;
    const requestHeaders = new Headers(init.headers);
    requestHeaders.set("accept", accept);
    try {
      response = await safeFetch(url, {
        ...init,
        headers: Object.fromEntries(requestHeaders.entries()),
        signal: context.signal
      }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: string;
    try { body = await readTextBounded(response, maxBytes); }
    catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { response, body };
  }

  private assertApiResponse(response: Response, body: string): void {
    if (blockedStatus(response.status) || isBlockedBody(body)) {
      throw new AdapterBlockedError(`${DOMAIN}: autocomplete is blocked (HTTP ${response.status})`);
    }
    if (response.status === 404 || response.status === 410) {
      throw new ParserChangedError(`${DOMAIN}: exact autocomplete endpoint is unavailable (HTTP ${response.status})`);
    }
    if (!response.ok) throw new AdapterBlockedError(`${DOMAIN}: autocomplete returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/application\/json/iu.test(contentType)) {
      throw new ParserChangedError(`${DOMAIN}: autocomplete returned a non-JSON response`);
    }
  }

  private assertProductResponse(response: Response, body: string, url: string): void {
    if (blockedStatus(response.status) || isBlockedBody(body)) {
      throw new AdapterBlockedError(`${DOMAIN} did not return ${url}: HTTP ${response.status}`);
    }
    if (!response.ok) throw new AdapterBlockedError(`${DOMAIN} returned HTTP ${response.status} for ${url}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
      throw new ParserChangedError(`${DOMAIN}:${listingIdFromUrl(url) ?? "unknown"}: product response is not HTML`);
    }
  }
}
