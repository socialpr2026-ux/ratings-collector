import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand } from "../utils/normalize.js";
import { titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "megamarket.ru";
const TRANSLATE_HOST = "megamarket-ru.translate.goog";
const MAX_PAGES = 20;
const MAX_PRODUCTS = 500;
const PRODUCT_PATH = /^\/catalog\/details\/([a-z0-9-]+)-(\d{6,18})(?:_\d+)?\/?$/i;

function compact(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function translated(source: URL): URL {
  const result = new URL(source.pathname, `https://${TRANSLATE_HOST}`);
  for (const [key, value] of source.searchParams) result.searchParams.set(key, value);
  result.searchParams.set("_x_tr_sl", "ru");
  result.searchParams.set("_x_tr_tl", "en");
  result.searchParams.set("_x_tr_hl", "en");
  return result;
}

function sourceFromBase(html: string): URL {
  const value = load(html)("base[href]").first().attr("href");
  if (!value) throw new ParserChangedError(`${DOMAIN}: translated page has no source proof`);
  const source = new URL(value);
  if (source.protocol !== "https:" || source.hostname.replace(/^www\./, "") !== DOMAIN) {
    throw new ParserChangedError(`${DOMAIN}: translated page points to another source`);
  }
  return source;
}

function productFromUrl(value: string): { id: string; url: string } | undefined {
  try {
    const input = new URL(value, `https://${DOMAIN}/`);
    const match = input.pathname.match(PRODUCT_PATH);
    if (!match) return undefined;
    const source = new URL(`/catalog/details/${match[1]}-${match[2]}/`, `https://${DOMAIN}`);
    return { id: match[2], url: canonicalizeUrl(source.toString()) };
  } catch {
    return undefined;
  }
}

function balancedObject(text: string, marker: string): string | undefined {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validRating(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

async function requestHtml(url: URL, context: AdapterContext, fetchImpl: typeof fetch): Promise<{ html: string; status: number }> {
  let response: Response;
  try {
    response = await safeFetch(url.toString(), {
      signal: context.signal,
      headers: { accept: "text/html,application/xhtml+xml" }
    }, context.fetch ?? fetchImpl, 2, 60_000);
  } catch (error) {
    throw new AdapterBlockedError(`${DOMAIN}: request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, 12_000_000, 60_000);
  if (!response.ok || /js-challenge-loader|id_captcha_frame_div|servicepipe\.ru\/static\/checkjs/i.test(html.slice(0, 100_000))) {
    throw new AdapterBlockedError(`${DOMAIN}: public page is blocked (HTTP ${response.status})`);
  }
  return { html, status: response.status };
}

export class MegamarketAdapter implements SiteAdapter {
  readonly id = "megamarket:translated-ssr-v1";
  readonly supportedDomains = [DOMAIN] as const;

  constructor(private readonly evidence: EvidenceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const source = new URL("https://megamarket.ru/catalog/details/ocillokokcinum-granuly-1-g-1-doz-6-sht-100024500008/");
      const result = await requestHtml(translated(source), context, this.fetchImpl);
      const parsed = this.parseProduct(result.html, source, "Оциллококцинум", "100024500008");
      return { ok: true, checkedAt, message: `${DOMAIN}: canary ${parsed.reviews}/${parsed.rating}` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map<string, ProductRef>();
    let explicitEmpty = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const source = new URL("https://megamarket.ru/catalog/");
      source.searchParams.set("q", brand);
      if (page > 1) source.searchParams.set("page", String(page));
      const { html } = await requestHtml(translated(source), context, this.fetchImpl);
      const provedSource = sourceFromBase(html);
      if (provedSource.pathname !== "/catalog/" || provedSource.searchParams.get("q") !== brand ||
        (provedSource.searchParams.get("page") ?? "1") !== String(page)) {
        throw new ParserChangedError(`${DOMAIN}: search response does not prove the requested brand/page`);
      }
      const $ = load(html);
      const cards = $("[data-test='product-item'][data-product-id]");
      const pageRefs = new Set<string>();
      cards.each((_index, node) => {
        const card = $(node);
        const rawId = card.attr("data-product-id") ?? "";
        const id = rawId.match(/^(\d{6,18})(?:_\d+)?$/)?.[1];
        const link = card.find("a[data-test='product-name-link'][href]").first();
        const title = compact(link.attr("title") || link.text());
        const parsed = link.attr("href") ? productFromUrl(link.attr("href")!) : undefined;
        if (!id || !parsed || parsed.id !== id || !matchesBrand(title, brand)) return;
        pageRefs.add(id);
        if (!refs.has(id)) refs.set(id, {
          domain: DOMAIN,
          platform: DOMAIN,
          listingId: id,
          brand,
          url: parsed.url,
          title,
          metadata: { source: "megamarket-search-translated-ssr" }
        });
      });
      if (refs.size > MAX_PRODUCTS) throw new AdapterBlockedError(`${DOMAIN}: more than ${MAX_PRODUCTS} products for one brand`);
      const pages = $(".pui-pagination-control").toArray()
        .map((node) => Number(compact($(node).text())))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
      const lastPage = pages.length ? Math.max(...pages) : 1;
      const bodyText = compact($.root().text());
      explicitEmpty = page === 1 && cards.length === 0 && /ничего не найдено|товары не найдены|no products found/i.test(bodyText);
      if (page >= lastPage) break;
      if (page === MAX_PAGES) throw new AdapterBlockedError(`${DOMAIN}: pagination exceeded ${MAX_PAGES} pages`);
      if (pageRefs.size === 0) throw new ParserChangedError(`${DOMAIN}: pagination declared more pages without product cards`);
    }
    for (const previous of context.previousRefs ?? []) {
      const parsed = productFromUrl(previous.url);
      if (!parsed || parsed.id !== previous.listingId || refs.has(parsed.id)) continue;
      refs.set(parsed.id, {
        domain: DOMAIN, platform: DOMAIN, listingId: parsed.id, brand, url: parsed.url,
        metadata: { source: "historical-registry" }
      });
    }
    if (!refs.size && !explicitEmpty) {
      throw new AdapterBlockedError(`${DOMAIN}: search did not prove products or their absence`);
    }
    return [...refs.values()];
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = productFromUrl(ref.url);
    if (!parsedRef || parsedRef.id !== ref.listingId) throw new ParserChangedError(`${DOMAIN}: invalid product reference`);
    const source = new URL(parsedRef.url);
    const result = await requestHtml(translated(source), context, this.fetchImpl);
    const parsed = this.parseProduct(result.html, source, ref.brand, ref.listingId);
    const capturedAt = new Date().toISOString();
    const productEvidence = titleProductEvidence(parsed.title, { type: "product_id", value: ref.listingId }, parsedRef.url);
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: parsedRef.url,
      status: result.status,
      bodyDigest: createHash("sha256").update(result.html).digest("hex"),
      parsed,
      productEvidence,
      source: "megamarket-product-reviewInfo-translated-ssr"
    });
    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: parsedRef.url,
      product: parsed.title,
      reviews: parsed.reviews,
      rating: parsed.reviews === 0 ? null : parsed.rating,
      rawRating: parsed.reviews === 0 ? null : parsed.rating,
      rawRatingScale: 5,
      ratingCount: parsed.reviews,
      status: parsed.reviews === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence,
      source: "megamarket-product-reviewInfo-translated-ssr"
    };
  }

  private parseProduct(html: string, expected: URL, brand: string, listingId: string): { title: string; reviews: number; rating: number } {
    const source = sourceFromBase(html);
    if (canonicalizeUrl(source.toString()) !== canonicalizeUrl(expected.toString())) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: translated page returned another product`);
    }
    const $ = load(html);
    const product = $("[itemscope][itemtype$='/Product']").first();
    const sku = product.find("meta[itemprop='sku']").first().attr("content")?.trim();
    const title = compact(product.find("h1[itemprop='name']").first().text());
    if (sku !== listingId || !title || !matchesBrand(title, brand)) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: product identity is not proven`);
    }
    const app = $("script").toArray().map((node) => $(node).text()).find((text) => text.includes('window.__APP__='));
    const reviewInfo = app ? balancedObject(app, '"reviewInfo":') : undefined;
    if (!reviewInfo) throw new ParserChangedError(`${DOMAIN}:${listingId}: reviewInfo is missing`);
    const reviews = nonNegativeInteger(reviewInfo.match(/"reviewsCount"\s*:\s*(\d+)/)?.[1]);
    const rating = validRating(reviewInfo.match(/"rating"\s*:\s*([0-5](?:\.\d+)?)(?=\s*[,}])/g)?.at(-1)?.match(/([0-5](?:\.\d+)?)/)?.[1]);
    if (reviews === undefined) throw new ParserChangedError(`${DOMAIN}:${listingId}: reviewsCount is invalid`);
    if (reviews > 0 && rating === undefined) throw new ParserChangedError(`${DOMAIN}:${listingId}: aggregate rating is invalid`);
    return { title, reviews, rating: rating ?? 0 };
  }
}

