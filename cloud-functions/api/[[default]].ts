import { timingSafeEqual } from "node:crypto";
import { load } from "cheerio";
import { COMPANY_BRANDS, INITIAL_BRANDS, INITIAL_DOMAINS } from "../../src/shared/constants.js";
import type { RunState } from "../../src/shared/types.js";
import { authenticate, authConfig, type AuthUser } from "../../src/server/auth.js";
import { BlobEvidenceStore, BlobRepository } from "../../src/server/blob-repository.js";
import { reconcileStaleCollectionCheckpoint } from "../../src/server/collection-checkpoint.js";
import { RatingsService } from "../../src/server/orchestrator.js";
import type { RepositoryRpc } from "../../src/server/remote-repository.js";
import { prepareBrowserPublication, reconcileBrowserPublication } from "../../src/server/sheets/publication-state.js";
import { safeErrorMessage } from "../../src/server/utils/error-message.js";
import { matchesBrand } from "../../src/server/utils/normalize.js";
import { assertSafePublicDestination, readTextBounded, safeFetch } from "../../src/server/utils/safe-fetch.js";
import { readerMarkdownToHtml, readerProxyUrl } from "../../src/server/utils/reader-proxy.js";
import { importOzonCompanionResult, issueOzonCompanionSession } from "../../src/server/companion-import.js";

type Context = { request: Request; env: Record<string, string | undefined> };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const OZON_TRANSLATE_HOST = "www-ozon-ru.translate.goog";
const OZON_SOURCE_HOST = "www.ozon.ru";
const OZON_TRANSLATE_PARAMETERS = new Set(["_x_tr_sl", "_x_tr_tl", "_x_tr_hl"]);
const OZON_SEARCH_PARAMETERS = new Set([
  "brand",
  "brand_was_predicted",
  "category_was_predicted",
  "deny_category_prediction",
  "from_global",
  "page",
  "text"
]);
const PHARMACY_TRANSLATE_PARAMETERS = new Set(["_x_tr_sl", "_x_tr_tl", "_x_tr_hl"]);
const FARMLEND_TRANSLATE_HOST = "farmlend-ru.translate.goog";
const OKAPTEKA_TRANSLATE_HOST = "okapteka-ru.translate.goog";
const ZDRAVCITY_TRANSLATE_HOST = "zdravcity-ru.translate.goog";
const ASNA_TRANSLATE_HOST = "www-asna-ru.translate.goog";
const POLZA_TRANSLATE_HOST = "polza-ru.translate.goog";
const APTEKA_TRANSLATE_HOST = "apteka-ru.translate.goog";
const NFAPTEKA_TRANSLATE_HOST = "nfapteka-ru.translate.goog";
const BUDZDOROV_TRANSLATE_HOST = "www-budzdorov-ru.translate.goog";
const ETABL_TRANSLATE_HOST = "etabl-ru.translate.goog";
const YANDEX_MODEL_SITEMAP_PATH = /^\/ugcpub\/sitemap_model_(\d+)-(\d+)-\d+\.xml$/i;

type PharmacyTranslateTarget = {
  kind: "farmlend-search" | "farmlend-product" | "okapteka-group" | "okapteka-reviews" | "asna-product" |
    "polza-family" | "polza-product" | "nfapteka-search" | "nfapteka-product" |
    "budzdorov-family" | "budzdorov-product" | "etabl-search" | "etabl-product" |
    "apteka-preparation" | "apteka-product";
  source: URL;
  productId?: string;
};

type AptekaRuTarget = {
  kind: "preparation" | "product" | "sitemap";
  source: URL;
  productId?: string;
  slugs?: string[];
};

type OzonTranslateTarget = {
  kind: "search" | "category" | "product";
  source: URL;
  sku?: string;
};

type OzonTranslatedComposerTarget = {
  kind: "search" | "product";
  source: URL;
  sku?: string;
};

type OzonYandexComposerTarget = {
  composer: URL;
  source: URL;
  sku?: string;
};

type IrecommendTarget = {
  kind: "search" | "product";
  brand?: string;
};

type RuOtzyvTarget = {
  source: URL;
  translated: URL;
};

type UtekaReviewsTarget = {
  source: URL;
};

function parseUtekaReviewsTarget(target: URL): UtekaReviewsTarget | undefined {
  if (
    target.protocol !== "https:" || target.hostname !== "uteka.ru" || target.port ||
    target.username || target.password || target.search || target.hash ||
    !/^\/(?:[a-z0-9][a-z0-9-]*\/){2,}[a-z0-9][a-z0-9-]*\/reviews\/$/i.test(target.pathname)
  ) return undefined;
  return { source: new URL(target.toString()) };
}

function parseRuOtzyvTarget(target: URL): RuOtzyvTarget | undefined {
  if (
    target.protocol !== "https:" || target.hostname !== "ru.otzyv.com" || target.port ||
    target.username || target.password || target.search || target.hash ||
    !/^\/[a-z0-9][a-z0-9-]*$/i.test(target.pathname)
  ) return undefined;
  const translated = new URL(target.pathname, "https://ru-otzyv-com.translate.goog");
  translated.searchParams.set("_x_tr_sl", "ru");
  translated.searchParams.set("_x_tr_tl", "en");
  translated.searchParams.set("_x_tr_hl", "en");
  return { source: new URL(target.toString()), translated };
}

function parseIrecommendTarget(target: URL): IrecommendTarget | undefined {
  if (target.protocol !== "https:" || target.hostname !== "irecommend.ru" || target.port ||
    target.username || target.password || target.hash) return undefined;
  if (target.pathname === "/srch") {
    if ([...target.searchParams.keys()].some((key) => key !== "query") || target.searchParams.getAll("query").length !== 1) {
      return undefined;
    }
    const brand = target.searchParams.get("query")?.normalize("NFKC").trim() ?? "";
    return brand.length >= 2 && brand.length <= 160 ? { kind: "search", brand } : undefined;
  }
  return !target.search && /^\/content\/[a-z0-9][a-z0-9-]*\/?$/i.test(target.pathname)
    ? { kind: "product" }
    : undefined;
}

function singleSearchParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function exactUrlSignature(url: URL): string {
  const parameters = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );
  return `${url.protocol}//${url.hostname}${url.pathname}?${new URLSearchParams(parameters).toString()}`;
}

function exactTranslateParameters(target: URL): boolean {
  return singleSearchParameter(target, "_x_tr_sl") === "ru" &&
    singleSearchParameter(target, "_x_tr_tl") === "en" &&
    singleSearchParameter(target, "_x_tr_hl") === "en";
}

function parsePharmacyTranslateTarget(target: URL): PharmacyTranslateTarget | undefined {
  if (
    target.protocol !== "https:" || target.port || target.username || target.password || target.hash ||
    !exactTranslateParameters(target) ||
    [...target.searchParams.keys()].some((key) => target.searchParams.getAll(key).length !== 1)
  ) return undefined;

  const sourceHost = target.hostname === FARMLEND_TRANSLATE_HOST
    ? "farmlend.ru"
    : target.hostname === OKAPTEKA_TRANSLATE_HOST
      ? "okapteka.ru"
      : target.hostname === ASNA_TRANSLATE_HOST
        ? "www.asna.ru"
        : target.hostname === POLZA_TRANSLATE_HOST
          ? "polza.ru"
          : target.hostname === APTEKA_TRANSLATE_HOST
            ? "apteka.ru"
            : target.hostname === NFAPTEKA_TRANSLATE_HOST
            ? "nfapteka.ru"
            : target.hostname === BUDZDOROV_TRANSLATE_HOST
              ? "www.budzdorov.ru"
              : target.hostname === ETABL_TRANSLATE_HOST ? "etabl.ru" : undefined;
  if (!sourceHost) return undefined;
  const source = new URL(target.pathname, `https://${sourceHost}`);

  if (target.hostname === FARMLEND_TRANSLATE_HOST) {
    if (target.pathname === "/search") {
      if ([...target.searchParams.keys()].some((key) =>
        !PHARMACY_TRANSLATE_PARAMETERS.has(key) && key !== "keyword"
      )) return undefined;
      const keyword = singleSearchParameter(target, "keyword")?.normalize("NFKC").trim() ?? "";
      if (keyword.length < 2 || keyword.length > 160) return undefined;
      source.searchParams.set("keyword", keyword);
      return { kind: "farmlend-search", source };
    }
    const product = target.pathname.match(/^\/(?:[a-z0-9][a-z0-9-]*\/)?product\/(\d+)\/?$/i);
    if (!product || [...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key))) {
      return undefined;
    }
    return { kind: "farmlend-product", source, productId: product[1] };
  }

  if (target.hostname === ASNA_TRANSLATE_HOST) {
    if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key)) ||
      !/^\/cards\/[a-z0-9_.-]+\.html$/i.test(target.pathname)) return undefined;
    return { kind: "asna-product", source };
  }

  if (target.hostname === POLZA_TRANSLATE_HOST) {
    if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key))) return undefined;
    if (/^\/product\/[a-z0-9][a-z0-9-]*\/$/i.test(target.pathname)) {
      return { kind: "polza-family", source };
    }
    const product = target.pathname.match(/^\/catalog\/[a-z0-9][a-z0-9-]*_(\d+)\/$/i);
    return product ? { kind: "polza-product", source, productId: product[1] } : undefined;
  }

  if (target.hostname === NFAPTEKA_TRANSLATE_HOST) {
    if (target.pathname === "/catalog/") {
      if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key) && key !== "q")) return undefined;
      const brand = singleSearchParameter(target, "q")?.normalize("NFKC").trim() ?? "";
      if (brand.length < 2 || brand.length > 160) return undefined;
      source.searchParams.set("q", brand);
      return { kind: "nfapteka-search", source };
    }
    if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key)) ||
      !/^\/(?:[a-z0-9-]+\/)*catalog\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/i.test(target.pathname)) return undefined;
    return { kind: "nfapteka-product", source };
  }

  if (target.hostname === APTEKA_TRANSLATE_HOST) {
    if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key))) return undefined;
    if (/^\/preparation\/[a-z0-9][a-z0-9-]*\/$/i.test(target.pathname)) {
      return { kind: "apteka-preparation", source };
    }
    const product = target.pathname.match(/^\/product\/[a-z0-9-]+-([a-f0-9]{24})\/$/i);
    return product ? { kind: "apteka-product", source, productId: product[1] } : undefined;
  }

  if (target.hostname === BUDZDOROV_TRANSLATE_HOST) {
    if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key))) return undefined;
    if (/^\/forms\/[a-z0-9][a-z0-9-]*$/i.test(target.pathname)) return { kind: "budzdorov-family", source };
    const product = target.pathname.match(/^\/product\/(?:[a-z0-9-]+-)?(\d+)$/i);
    return product ? { kind: "budzdorov-product", source, productId: product[1] } : undefined;
  }

  if (target.hostname === ETABL_TRANSLATE_HOST) {
    if (target.pathname === "/search") {
      if ([...target.searchParams.keys()].some((key) =>
        !PHARMACY_TRANSLATE_PARAMETERS.has(key) && !["query", "limit"].includes(key)
      )) return undefined;
      const brand = singleSearchParameter(target, "query")?.normalize("NFKC").trim() ?? "";
      if (brand.length < 2 || brand.length > 160 || singleSearchParameter(target, "limit") !== "100") return undefined;
      source.searchParams.set("query", brand);
      source.searchParams.set("limit", "100");
      return { kind: "etabl-search", source };
    }
    const product = target.pathname.match(/^\/product\/[a-z0-9-]+=(\d+)$/i);
    if (!product || [...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key))) return undefined;
    return { kind: "etabl-product", source, productId: product[1] };
  }

  const group = target.pathname.match(/^\/(pg|reviews)\/([^/]+)\/$/i);
  if (!group) return undefined;
  let brand: string;
  try { brand = decodeURIComponent(group[2]).normalize("NFKC").trim(); }
  catch { return undefined; }
  if (brand.length < 2 || brand.length > 160) return undefined;
  if (group[1].toLocaleLowerCase("en-US") === "pg") {
    if ([...target.searchParams.keys()].some((key) => !PHARMACY_TRANSLATE_PARAMETERS.has(key))) return undefined;
    return { kind: "okapteka-group", source };
  }
  for (const [key, value] of target.searchParams) {
    if (PHARMACY_TRANSLATE_PARAMETERS.has(key)) continue;
    if (!/^(?:page|pagen_\d+|sizen_\d+)$/i.test(key) || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
      return undefined;
    }
    source.searchParams.set(key, value);
  }
  return { kind: "okapteka-reviews", source };
}

function parseAptekaRuTarget(target: URL): AptekaRuTarget | undefined {
  if (target.protocol !== "https:" || target.hostname !== "apteka.ru" || target.port || target.username ||
    target.password || target.hash) return undefined;
  if (target.pathname === "/sitemap-product.xml") {
    if ([...target.searchParams.keys()].some((key) => key !== "slugs") || target.searchParams.getAll("slugs").length !== 1) {
      return undefined;
    }
    const slugs = target.searchParams.get("slugs")!.split(",");
    if (!slugs.length || slugs.length > 6 || slugs.some((slug) => !/^[a-z0-9-]{3,80}$/i.test(slug))) return undefined;
    return { kind: "sitemap", source: new URL("https://apteka.ru/sitemap-product.xml"), slugs: [...new Set(slugs)] };
  }
  if (target.search) return undefined;
  if (/^\/preparation\/[a-z0-9][a-z0-9-]*\/$/i.test(target.pathname)) {
    return { kind: "preparation", source: new URL(target.toString()) };
  }
  const product = target.pathname.match(/^\/product\/[a-z0-9-]+-([a-f0-9]{24})\/$/i);
  return product ? { kind: "product", source: new URL(target.toString()), productId: product[1] } : undefined;
}

function translatedSourceMatches(value: string | undefined, requested: URL): boolean {
  if (!value) return false;
  try {
    return exactUrlSignature(new URL(value)) === exactUrlSignature(requested);
  } catch {
    return false;
  }
}

function megamarketSource(target: URL): URL {
  const source = new URL(target.pathname, "https://megamarket.ru");
  for (const key of ["q", "page"] as const) {
    const value = target.searchParams.get(key);
    if (value !== null) source.searchParams.set(key, value);
  }
  return source;
}

function balancedJsonAfterMarker(text: string, marker: string): string | undefined {
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

function compactMegamarketTranslateHtml(html: string, target: URL): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const requested = megamarketSource(target);
  const baseValue = $("base[href]").first().attr("href");
  if (!translatedSourceMatches(baseValue, requested)) return undefined;
  const title = $("title").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (/(?:captcha|access denied|unusual traffic|Target URL returned error)/i.test(title) ||
    /js-challenge-loader|id_captcha_frame_div|servicepipe\.ru\/static\/checkjs/i.test(html.slice(0, 150_000))) {
    return undefined;
  }
  const base = `<base href="${escapeHtml(requested.toString())}">`;

  if (requested.pathname === "/catalog/") {
    const cards: string[] = [];
    const seen = new Set<string>();
    $("[data-test='product-item'][data-product-id]").each((_index, node) => {
      const card = $(node);
      const rawId = card.attr("data-product-id")?.trim() ?? "";
      const id = rawId.match(/^(\d{6,18})(?:_\d+)?$/)?.[1];
      const link = card.find("a[data-test='product-name-link'][href]").first();
      const titleText = (link.attr("title") || link.text()).normalize("NFKC").replace(/\s+/g, " ").trim();
      if (!id || !titleText || seen.has(id)) return;
      let product: URL;
      try { product = new URL(link.attr("href")!, target); }
      catch { return; }
      const match = product.pathname.match(/^\/catalog\/details\/[a-z0-9-]+-(\d{6,18})(?:_\d+)?\/?$/i);
      if (!match || match[1] !== id || !["megamarket.ru", "megamarket-ru.translate.goog"].includes(product.hostname)) return;
      seen.add(id);
      cards.push(`<div data-test="product-item" data-product-id="${escapeHtml(rawId)}">` +
        `<a data-test="product-name-link" title="${escapeHtml(titleText)}" href="${escapeHtml(product.pathname)}">` +
        `${escapeHtml(titleText)}</a></div>`);
    });
    const pages = $(".pui-pagination-control").toArray()
      .map((node) => Number($(node).text().trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 20);
    const pagination = [...new Set(pages)].map((page) =>
      `<button class="pui-pagination-control">${page}</button>`
    ).join("");
    if ($("[data-test='product-item']").length > 0 && cards.length === 0) return undefined;
    return `<html><head>${base}</head><body>${cards.join("")}${pagination}</body></html>`;
  }

  const product = $("[itemscope][itemtype$='/Product']").first();
  const sku = product.find("meta[itemprop='sku']").first().attr("content")?.trim() ?? "";
  const productTitle = product.find("h1[itemprop='name']").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  const expectedId = requested.pathname.match(/-(\d{6,18})\/?$/)?.[1];
  if (!expectedId || sku !== expectedId || !productTitle) return undefined;
  const app = $("script").toArray().map((node) => $(node).text()).find((text) => text.includes("window.__APP__="));
  const reviewInfo = app ? balancedJsonAfterMarker(app, '"reviewInfo":') : undefined;
  if (!reviewInfo || reviewInfo.length > 100_000) return undefined;
  let aggregate: { reviewsCount?: unknown; rating?: unknown };
  try { aggregate = JSON.parse(reviewInfo) as typeof aggregate; }
  catch { return undefined; }
  const reviews = Number(aggregate.reviewsCount);
  const rating = Number(aggregate.rating);
  if (!Number.isSafeInteger(reviews) || reviews < 0 || reviews > 0 && (!Number.isFinite(rating) || rating <= 0 || rating > 5)) {
    return undefined;
  }
  const compactAggregate = JSON.stringify({ reviewsCount: reviews, rating: reviews > 0 ? rating : 0 });
  return `<html><head>${base}</head><body><main itemscope itemtype="http://schema.org/Product">` +
    `<meta itemprop="sku" content="${expectedId}"><h1 itemprop="name">${escapeHtml(productTitle)}</h1></main>` +
    `<script>window.__APP__={"reviewInfo":${compactAggregate}}</script></body></html>`;
}

function compactZdravcityTranslateHtml(html: string, requested: URL): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const title = $("title").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (/(?:captcha|access denied|unusual traffic|Target URL returned error)/i.test(title) ||
    /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 150_000))) return undefined;
  const baseValue = $("base[href]").first().attr("href");
  if (!translatedSourceMatches(baseValue, requested)) return undefined;

  const nextSource = $("#__NEXT_DATA__").first().text();
  if (!nextSource) return undefined;
  let next: { props?: { pageProps?: Record<string, unknown> } };
  try { next = JSON.parse(nextSource) as typeof next; }
  catch { return undefined; }
  const pageProps = next.props?.pageProps;
  if (!pageProps) return undefined;
  let compactPageProps: Record<string, unknown>;

  if (/^\/g_[a-z0-9-]+\/$/i.test(requested.pathname)) {
    const products = pageProps.products;
    if (!Array.isArray(products)) return undefined;
    const compactProducts: Array<Record<string, unknown>> = [];
    for (const value of products) {
      if (!value || typeof value !== "object") continue;
      const item = value as { id?: unknown; url?: unknown; name?: unknown; brand?: { name?: unknown }; sku?: unknown };
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
      let productUrl: URL;
      try { productUrl = new URL(String(item.url ?? ""), requested); }
      catch { continue; }
      if (!/^[0-9a-f-]{36}$/i.test(id) || !name || productUrl.protocol !== "https:" ||
        productUrl.hostname !== "zdravcity.ru" || productUrl.search || productUrl.hash ||
        !/^\/p_[a-z0-9][a-z0-9-]*-\d+\.html$/i.test(productUrl.pathname)) continue;
      const brandName = typeof item.brand?.name === "string"
        ? item.brand.name.normalize("NFKC").replace(/\s+/g, " ").trim()
        : "";
      compactProducts.push({
        id,
        url: productUrl.pathname,
        name,
        ...(brandName ? { brand: { name: brandName } } : {}),
        ...(typeof item.sku === "string" || typeof item.sku === "number" ? { sku: item.sku } : {})
      });
    }
    if (products.length > 0 && compactProducts.length === 0) return undefined;
    compactPageProps = { products: compactProducts };
  } else if (/^\/p_[a-z0-9][a-z0-9-]*-\d+\.html$/i.test(requested.pathname)) {
    const rawProduct = pageProps.productV2;
    if (!rawProduct || typeof rawProduct !== "object") return undefined;
    const product = rawProduct as {
      id?: unknown;
      attributes?: { name?: unknown; url?: unknown; rating?: unknown; sku?: unknown };
      reviews?: unknown;
    };
    const id = typeof product.id === "string" ? product.id.trim() : "";
    const attributes = product.attributes;
    const name = typeof attributes?.name === "string"
      ? attributes.name.normalize("NFKC").replace(/\s+/g, " ").trim()
      : "";
    let canonical: URL;
    try { canonical = new URL(String(attributes?.url ?? ""), requested); }
    catch { return undefined; }
    if (!/^[0-9a-f-]{36}$/i.test(id) || !name || !translatedSourceMatches(canonical.toString(), requested) ||
      !Array.isArray(product.reviews)) return undefined;
    const reviewIds = new Set<string>();
    const reviews: Array<{ ID: string; rate: number }> = [];
    for (const value of product.reviews) {
      if (!value || typeof value !== "object") return undefined;
      const review = value as { ID?: unknown; rate?: unknown };
      const reviewId = String(review.ID ?? "").trim();
      const rate = Number(review.rate);
      // Zdravcity uses 0 for written reviews where the author left text but
      // no star score. They still count toward the written-review total.
      if (!reviewId || reviewIds.has(reviewId) || !Number.isInteger(rate) || rate < 0 || rate > 5) return undefined;
      reviewIds.add(reviewId);
      reviews.push({ ID: reviewId, rate });
    }
    const rating = Number(attributes?.rating);
    if (reviews.length > 0 && (!Number.isFinite(rating) || rating <= 0 || rating > 5)) return undefined;
    const structuredCounts: number[] = [];
    const currentSku = typeof attributes?.sku === "string" || typeof attributes?.sku === "number"
      ? String(attributes.sku).trim()
      : "";
    const visitStructuredProduct = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visitStructuredProduct); return; }
      if (!value || typeof value !== "object") return;
      const item = value as {
        "@type"?: unknown;
        "@graph"?: unknown;
        name?: unknown;
        sku?: unknown;
        url?: unknown;
        aggregateRating?: { reviewCount?: unknown; ratingCount?: unknown };
      };
      visitStructuredProduct(item["@graph"]);
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (!types.includes("Product")) return;
      const structuredName = typeof item.name === "string"
        ? item.name.normalize("NFKC").replace(/\s+/g, " ").trim()
        : "";
      const structuredSku = typeof item.sku === "string" || typeof item.sku === "number"
        ? String(item.sku).trim()
        : "";
      let structuredPath = "";
      try { structuredPath = item.url ? new URL(String(item.url), requested).pathname : ""; }
      catch { return; }
      const nameMatches = Boolean(structuredName) && structuredName.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU");
      const skuMatches = Boolean(structuredSku && currentSku) && structuredSku === currentSku;
      const pathMatches = structuredPath === requested.pathname;
      if (structuredSku && currentSku && !skuMatches || structuredPath && !pathMatches) return;
      if (!nameMatches && !skuMatches && !pathMatches) return;
      for (const raw of [item.aggregateRating?.reviewCount, item.aggregateRating?.ratingCount]) {
        const count = Number(raw);
        if (Number.isSafeInteger(count) && count >= 0) structuredCounts.push(count);
      }
    };
    for (const script of $("script[type='application/ld+json']").toArray()) {
      try { visitStructuredProduct(JSON.parse($(script).text())); }
      catch { /* unrelated or malformed optional JSON-LD */ }
    }
    const structuredCount = structuredCounts.length ? Math.max(...structuredCounts) : undefined;
    compactPageProps = {
      productV2: {
        id,
        attributes: {
          name,
          url: requested.pathname,
          ...(reviews.length > 0 ? { rating } : {}),
          ...(typeof attributes?.sku === "string" || typeof attributes?.sku === "number" ? { sku: attributes.sku } : {})
        },
        reviews
      }
    };
    if (structuredCount !== undefined) {
      compactPageProps.structuredProduct = {
        "@type": "Product",
        name,
        ...(currentSku ? { sku: currentSku } : {}),
        url: requested.pathname,
        aggregateRating: { "@type": "AggregateRating", reviewCount: structuredCount }
      };
    }
  } else {
    return undefined;
  }

  const compactNext = JSON.stringify({ props: { pageProps: compactPageProps } }).replace(/</g, "\\u003c");
  const structuredScript = compactPageProps.structuredProduct
    ? `<script type="application/ld+json">${JSON.stringify(compactPageProps.structuredProduct).replace(/</g, "\\u003c")}</script>`
    : "";
  return `<html><head><base href="${escapeHtml(baseValue!)}">${structuredScript}</head><body>` +
    `<script id="__NEXT_DATA__" type="application/json">${compactNext}</script></body></html>`;
}

function parseAssignedJsonObject(script: string, prefix: string): Record<string, unknown> | undefined {
  const assignment = script.indexOf(prefix);
  if (assignment < 0) return undefined;
  const start = assignment + prefix.length;
  let objectStart = start;
  while (/\s/.test(script[objectStart] ?? "")) objectStart += 1;
  if (script[objectStart] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < script.length; index += 1) {
    const character = script[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(script.slice(objectStart, index + 1)) as Record<string, unknown>; }
        catch { return undefined; }
      }
    }
  }
  return undefined;
}

function compactPharmacyTranslateHtml(html: string, requested: PharmacyTranslateTarget): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const title = $("title").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (/(?:captcha|access denied|unusual traffic|подозрительн\w*\s+активност|проверка\s+браузера|Target URL returned error)/i.test(title) ||
    /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 150_000))) return undefined;
  const baseValue = $("base[href]").first().attr("href");
  if (!translatedSourceMatches(baseValue, requested.source)) return undefined;
  const base = `<base href="${escapeHtml(requested.source.toString())}">`;

  if (requested.kind === "apteka-preparation" || requested.kind === "apteka-product") {
    return compactAptekaRuHtml(html, {
      kind: requested.kind === "apteka-preparation" ? "preparation" : "product",
      source: requested.source,
      productId: requested.productId
    });
  }

  if (requested.kind === "nfapteka-search") {
    const cards: string[] = [];
    $(".productOuter, [class*='productOuter']").each((_index, node) => {
      const root = $(node);
      const productId = root.find("[data-id]").first().attr("data-id")?.trim();
      if (!productId || !/^\d+$/.test(productId)) return;
      let selected: { product: URL; title: string } | undefined;
      for (const candidate of root.find("a[href$='.html'], a[href*='.html?']").toArray()) {
        const link = $(candidate);
        const titleText = (link.text() || link.find("img[alt]").first().attr("alt") || "")
          .normalize("NFKC").replace(/\s+/g, " ").trim();
        if (!titleText) continue;
        let product: URL;
        try { product = new URL(link.attr("href") ?? "", requested.source); }
        catch { continue; }
        if (![NFAPTEKA_TRANSLATE_HOST, "nfapteka.ru"].includes(product.hostname) ||
          !/^\/(?:[a-z0-9-]+\/)*catalog\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/i.test(product.pathname)) continue;
        selected = { product, title: titleText };
        break;
      }
      if (!selected) return;
      const { product, title: titleText } = selected;
      cards.push(`<div class="productOuter"><div class="productName"><a href="https://nfapteka.ru${escapeHtml(product.pathname)}">${escapeHtml(titleText)}</a></div>` +
        `<a data-id="${escapeHtml(productId)}"></a></div>`);
    });
    const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const empty = pageText.match(/(?:ничего не найдено|товары не найдены|по вашему запросу.{0,80}не найдено)/i)?.[0];
    if (!cards.length && !empty) return undefined;
    return `<html><head>${base}</head><body><main>${cards.join("")}${empty ? `<p>${escapeHtml(empty)}</p>` : ""}</main></body></html>`;
  }

  if (requested.kind === "nfapteka-product") {
    const canonicalValue = $("link[rel='canonical'][href]").first().attr("href");
    const productId = $("input[name='productId']").first().attr("value")?.trim() ?? $("[data-id]").first().attr("data-id")?.trim();
    const heading = $("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const aggregate = $("[itemprop='aggregateRating']").first();
    let reviews = aggregate.find("[itemprop='reviewCount']").first().attr("content")?.trim() ??
      aggregate.find("[itemprop='reviewCount']").first().text().replace(/[\s\u00a0]+/g, "");
    const rating = aggregate.find("[itemprop='ratingValue']").first().attr("content")?.trim() ??
      aggregate.find("[itemprop='ratingValue']").first().text().trim();
    const reviewSection = $("#review");
    if (!/^\d+$/.test(reviews) && reviewSection.length === 1 && reviewSection.children().length === 2 &&
      reviewSection.children("h2").length === 1 &&
      !reviewSection.find("[itemprop='review'], [data-review-id], .review-item, [itemprop='ratingValue']").length) {
      const headingText = reviewSection.children("h2").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
      const links = reviewSection.find("a[href]");
      let exactEmpty = /^Отзывы\s+\S/iu.test(headingText) && links.length === 1 &&
        links.first().text().normalize("NFKC").replace(/\s+/g, " ").trim() === "Оставить отзыв";
      try { exactEmpty &&= new URL(links.first().attr("href") ?? "", requested.source).hash === "#testimonialModal"; }
      catch { exactEmpty = false; }
      if (exactEmpty) reviews = "0";
    }
    if (!translatedSourceMatches(canonicalValue, requested.source) || !productId || !/^\d+$/.test(productId) || !heading ||
      !/^\d+$/.test(reviews) || Number(reviews) > 0 && !/^\d(?:[.,]\d+)?$/.test(rating)) return undefined;
    const compactReviews: string[] = [];
    if (Number(reviews) > 0) {
      const items = reviewSection.find(".testimonial[itemscope][itemtype*='Review']");
      if (items.length !== Number(reviews)) return undefined;
      for (const node of items.toArray()) {
        const item = $(node);
        const reviewed = item.find("meta[itemprop='itemReviewed']").first().attr("content")?.normalize("NFKC").replace(/\s+/g, " ").trim();
        const score = item.find("[itemprop='reviewRating'] [itemprop='ratingValue']").first().attr("content")?.trim();
        if (!reviewed || !/^\d(?:[.,]\d+)?$/.test(score ?? "")) return undefined;
        compactReviews.push(`<article class="testimonial" itemscope itemtype="https://schema.org/Review">` +
          `<meta itemprop="itemReviewed" content="${escapeHtml(reviewed)}">` +
          `<span itemprop="reviewRating"><meta itemprop="ratingValue" content="${escapeHtml(score!)}"></span></article>`);
      }
    }
    return `<html><head>${base}<link rel="canonical" href="${escapeHtml(requested.source.toString())}"></head><body>` +
      `<h1>${escapeHtml(heading)}</h1><input name="productId" value="${escapeHtml(productId)}">` +
      `<div itemprop="aggregateRating"><meta itemprop="reviewCount" content="${escapeHtml(reviews)}">` +
      `${rating ? `<meta itemprop="ratingValue" content="${escapeHtml(rating)}">` : ""}</div>` +
      `${compactReviews.length ? `<div id="review">${compactReviews.join("")}</div>` : ""}</body></html>`;
  }

  if (requested.kind === "budzdorov-family") {
    const products = new Map<string, { pathname: string; title: string }>();
    $("a[href*='/product/']").each((_index, node) => {
      const titleText = ($(node).attr("title") || $(node).text()).normalize("NFKC").replace(/\s+/g, " ").trim();
      let product: URL;
      try { product = new URL($(node).attr("href") ?? "", requested.source); }
      catch { return; }
      const productId = product.pathname.match(/^\/product\/(?:[a-z0-9-]+-)?(\d+)\/?$/i)?.[1];
      if (!productId || ![BUDZDOROV_TRANSLATE_HOST, "www.budzdorov.ru"].includes(product.hostname) || !titleText) return;
      if (!products.has(productId)) products.set(productId, { pathname: product.pathname, title: titleText });
    });
    const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const empty = pageText.match(/(?:ничего не найдено|товары не найдены|нет препаратов)/i)?.[0];
    if (!products.size && !empty) return undefined;
    return `<html><head>${base}</head><body><main>${[...products.values()].map(({ pathname, title }) =>
      `<a href="https://www.budzdorov.ru${escapeHtml(pathname)}" title="${escapeHtml(title)}">${escapeHtml(title)}</a>`
    ).join("")}${empty ? `<p>${escapeHtml(empty)}</p>` : ""}</main></body></html>`;
  }

  if (requested.kind === "budzdorov-product") {
    const heading = $("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const total = $("[allreviewsqty]").first().attr("allreviewsqty")?.trim();
    const stateScript = $("script").toArray().map((node) => $(node).html() ?? "")
      .find((value) => value.includes("window.__INITIAL_STATE__="));
    if (!heading || !total || !/^\d+$/.test(total) || !stateScript) return undefined;
    let state: { productView?: { reviews?: unknown } };
    const parsedState = parseAssignedJsonObject(stateScript, "window.__INITIAL_STATE__=");
    if (!parsedState) return undefined;
    state = parsedState as typeof state;
    if (!Array.isArray(state.productView?.reviews) || state.productView.reviews.length !== Number(total)) return undefined;
    const reviews: Array<{ id: string; ratings: Array<{ attribute_code: string; value: number }> }> = [];
    const ids = new Set<string>();
    for (const value of state.productView.reviews) {
      if (!value || typeof value !== "object") return undefined;
      const review = value as { id?: unknown; ratings?: unknown };
      const id = String(review.id ?? "");
      if (!Array.isArray(review.ratings)) return undefined;
      const ratings = review.ratings;
      const scores = ratings.filter((item): item is { attribute_code?: unknown; value?: unknown } => Boolean(item && typeof item === "object"))
        .filter((item) => ["оценка", "rating"].includes(String(item.attribute_code ?? "").normalize("NFKC").trim().toLocaleLowerCase("ru-RU")));
      if (!id || ids.has(id) || scores.length > 1) return undefined;
      const score = scores.length === 1 ? Number(scores[0].value) : undefined;
      if (score !== undefined && (!Number.isInteger(score) || score < 1 || score > 5)) return undefined;
      ids.add(id);
      reviews.push({ id, ratings: score === undefined ? [] : [{ attribute_code: "Оценка", value: score }] });
    }
    const compactState = JSON.stringify({ productView: { reviews } }).replace(/</g, "\\u003c");
    return `<html><head>${base}</head><body><h1>${escapeHtml(heading)}</h1><div allreviewsqty="${escapeHtml(total)}"></div>` +
      `<script>window.__INITIAL_STATE__=${compactState};document.currentScript.remove()</script></body></html>`;
  }

  if (requested.kind === "etabl-search" || requested.kind === "etabl-product") {
    const stateScript = $("script").toArray().map((node) => $(node).html() ?? "").find((value) => value.startsWith("window.__INITIAL_STATE__="));
    if (!stateScript) return undefined;
    const raw = stateScript.slice("window.__INITIAL_STATE__=".length);
    const marker = raw.indexOf(";document.currentScript.remove()");
    let state: { search?: { searchResultNew?: unknown; searchResultCount?: unknown }; products?: { product?: unknown } };
    try { state = JSON.parse(marker >= 0 ? raw.slice(0, marker) : raw.replace(/;\s*$/, "")) as typeof state; }
    catch { return undefined; }
    const validateProduct = (value: unknown): Record<string, unknown> | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const item = value as Record<string, unknown>;
      const id = String(item.id ?? "");
      const slug = String(item.url ?? "");
      const name = String(item.name ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
      const subtitleFull = String(item.subtitleFull ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
      const reviewsStats = item.reviewsStats;
      if (!/^\d+$/.test(id) || !new RegExp(`^[a-z0-9-]+=${id}$`, "i").test(slug) || !name || !subtitleFull ||
        !reviewsStats || typeof reviewsStats !== "object") return undefined;
      const stats = reviewsStats as Record<string, unknown>;
      const reviewsCount = Number(stats.reviewsCount);
      const rating = Number(stats.rating);
      if (!Number.isSafeInteger(reviewsCount) || reviewsCount < 0 || reviewsCount > 0 && (!Number.isFinite(rating) || rating <= 0 || rating > 5)) return undefined;
      return { id, name, url: slug, subtitleFull, reviewsStats: { reviewsCount, rating } };
    };
    let compactState: Record<string, unknown>;
    if (requested.kind === "etabl-search") {
      if (!Array.isArray(state.search?.searchResultNew)) return undefined;
      const products = state.search.searchResultNew.map(validateProduct);
      const count = Number(state.search.searchResultCount);
      if (products.some((item) => !item) || !Number.isSafeInteger(count) || count < 0 || count !== products.length) return undefined;
      compactState = { search: { searchResultNew: products, searchResultCount: count } };
    } else {
      const product = validateProduct(state.products?.product);
      if (!product || product.id !== requested.productId) return undefined;
      compactState = { products: { product } };
    }
    return `<html><head>${base}<script data-source-url="${escapeHtml(requested.source.toString())}"></script></head><body>` +
      `<script>window.__INITIAL_STATE__=${JSON.stringify(compactState).replace(/</g, "\\u003c")};document.currentScript.remove()</script></body></html>`;
  }

  if (requested.kind === "polza-family") {
    const cards: string[] = [];
    $(".catalog__block--cards .catalog-block__items > .catalog-card[itemscope]").each((_index, node) => {
      const root = $(node);
      const sku = root.find("meta[itemprop='sku']").first().attr("content")?.trim();
      const href = root.find("link[itemprop='url']").first().attr("href");
      const name = root.find("meta[itemprop='name']").first().attr("content")?.normalize("NFKC").replace(/\s+/g, " ").trim();
      const aggregate = root.find("[itemprop='aggregateRating']").first();
      const reviews = aggregate.find("meta[itemprop='reviewCount']").first().attr("content")?.trim();
      const rating = aggregate.find("meta[itemprop='ratingValue']").first().attr("content")?.trim();
      if (!sku || !/^\d+$/.test(sku) || !href || !name || !reviews || !/^\d+$/.test(reviews)) return;
      let product: URL;
      try { product = new URL(href, requested.source); }
      catch { return; }
      const productId = product.pathname.match(/^\/catalog\/[a-z0-9][a-z0-9-]*_(\d+)\/$/i)?.[1];
      const reviewCount = Number(reviews);
      const ratingValue = rating && /^\d(?:[.,]\d+)?$/.test(rating) ? Number(rating.replace(",", ".")) : Number.NaN;
      if (product.protocol !== "https:" || product.hostname !== "polza.ru" || productId !== sku ||
        !Number.isSafeInteger(reviewCount) || reviewCount < 0 ||
        reviewCount > 0 && (!Number.isFinite(ratingValue) || ratingValue <= 0 || ratingValue > 5)) return;
      cards.push(`<div class="catalog-card" itemscope itemtype="https://schema.org/Product">` +
        `<link itemprop="url" href="${escapeHtml(product.pathname)}"><meta itemprop="sku" content="${escapeHtml(sku)}">` +
        `<meta itemprop="name" content="${escapeHtml(name)}"><span itemprop="aggregateRating">` +
        `<meta itemprop="reviewCount" content="${escapeHtml(reviews)}">` +
        `${rating ? `<meta itemprop="ratingValue" content="${escapeHtml(rating)}">` : ""}</span></div>`);
    });
    if (!cards.length) return undefined;
    return `<html><head>${base}</head><body><script data-source-url="${escapeHtml(requested.source.toString())}"></script>` +
      `<div class="catalog__block--cards"><div class="catalog-block__items">${cards.join("")}</div></div></body></html>`;
  }

  if (requested.kind === "polza-product") {
    const roots = $(`meta[itemprop='sku'][content='${requested.productId}']`).closest("[itemscope]");
    if (roots.length === 0) return undefined;
    const candidates: Array<{ reviews: string; rating?: string; reviewCount: number; ratingValue: number }> = [];
    for (const node of roots.toArray()) {
      const root = $(node);
      const aggregate = root.find("[itemprop='aggregateRating']").first();
      // Polza repeats the current SKU in a recommendation carousel. Those
      // duplicate cards have no aggregate and must not invalidate the single
      // source-bound product aggregate above them.
      if (!aggregate.length) continue;
      const href = root.find("link[itemprop='url']").first().attr("href");
      const reviews = aggregate.find("meta[itemprop='reviewCount']").first().attr("content")?.trim();
      const rating = aggregate.find("meta[itemprop='ratingValue']").first().attr("content")?.trim();
      const reviewCount = reviews && /^\d+$/.test(reviews) ? Number(reviews) : Number.NaN;
      const ratingValue = rating && /^\d(?:[.,]\d+)?$/.test(rating) ? Number(rating.replace(",", ".")) : Number.NaN;
      if (!href || !translatedSourceMatches(new URL(href, requested.source).toString(), requested.source) ||
        !Number.isSafeInteger(reviewCount) || reviewCount < 0 ||
        reviewCount > 0 && (!Number.isFinite(ratingValue) || ratingValue <= 0 || ratingValue > 5)) return undefined;
      candidates.push({ reviews: reviews!, ...(rating ? { rating } : {}), reviewCount, ratingValue });
    }
    if (candidates.length === 0 || new Set(candidates.map((item) => `${item.reviewCount}:${item.ratingValue}`)).size !== 1) {
      return undefined;
    }
    const [{ reviews, rating }] = candidates;
    return `<html><head>${base}</head><body><script data-source-url="${escapeHtml(requested.source.toString())}"></script>` +
      `<main itemscope itemtype="https://schema.org/Product"><meta itemprop="sku" content="${escapeHtml(requested.productId!)}">` +
      `<link itemprop="url" href="${escapeHtml(requested.source.pathname)}">` +
      `<div itemprop="aggregateRating" itemscope><meta itemprop="reviewCount" content="${escapeHtml(reviews)}">` +
      `${rating ? `<meta itemprop="ratingValue" content="${escapeHtml(rating)}">` : ""}</div></main></body></html>`;
  }

  if (requested.kind === "asna-product") {
    const canonicalValue = $("link[rel='canonical'][href]").first().attr("href");
    if (!translatedSourceMatches(canonicalValue, requested.source)) return undefined;
    const roots = $(".productPage__content.product__item[itemscope]");
    if (roots.length !== 1) return undefined;
    const root = roots.first();
    const sku = root.find("meta[itemprop='sku']").first().attr("content")?.trim();
    const aggregate = root.find("[itemprop='aggregateRating']").first();
    const reviews = aggregate.find("meta[itemprop='reviewCount']").first().attr("content")?.trim();
    const rating = aggregate.find("meta[itemprop='ratingValue']").first().attr("content")?.trim();
    const reviewCount = reviews && /^\d+$/.test(reviews) ? Number(reviews) : Number.NaN;
    const ratingValue = rating && /^\d(?:[.,]\d+)?$/.test(rating) ? Number(rating.replace(",", ".")) : Number.NaN;
    const validRating = Number.isFinite(ratingValue) && ratingValue > 0 && ratingValue <= 5;
    if (!sku || sku.length > 80 || !/^[a-z0-9_.-]+$/i.test(sku) || !Number.isSafeInteger(reviewCount) || reviewCount < 0 ||
      rating && !validRating || reviewCount > 0 && !validRating) return undefined;
    const feedbackList = root.find("#feedbackListContainer.product__feedbackList").first();
    const feedbackItems = feedbackList.find(".product__feedbackItem[itemtype*='Review']");
    const visibleTotal = root.find(".product__ratingText").first().text().match(/\((\d[\d\s\u00a0]*)\)/)?.[1]
      ?.replace(/[\s\u00a0]/g, "");
    if (reviewCount > 0 && (!feedbackList.length || feedbackItems.length === 0 || visibleTotal !== reviews)) return undefined;
    const compactFeedback = reviewCount > 0
      ? `<div class="product__ratingText">(${escapeHtml(reviews!)})</div>` +
        `<div id="feedbackListContainer" class="product__feedbackList">${feedbackItems.toArray().map(() =>
          `<article class="product__feedbackItem" itemscope itemtype="https://schema.org/Review"></article>`
        ).join("")}</div>`
      : "";
    return `<html><head>${base}<link rel="canonical" href="${escapeHtml(canonicalValue!)}"></head><body>` +
      `<script data-source-url="${escapeHtml(requested.source.toString())}"></script>` +
      `<div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">` +
      `<meta itemprop="sku" content="${escapeHtml(sku)}"><div itemprop="aggregateRating" itemscope>` +
      `${rating ? `<meta itemprop="ratingValue" content="${escapeHtml(rating)}">` : ""}` +
      `<meta itemprop="reviewCount" content="${escapeHtml(reviews!)}"></div>${compactFeedback}</div></body></html>`;
  }

  if (requested.kind === "farmlend-search") {
    const anchors: string[] = [];
    $("a[href]").each((_index, node) => {
      const href = $(node).attr("href");
      if (!href) return;
      try {
        const value = new URL(href, `https://${FARMLEND_TRANSLATE_HOST}`);
        const match = value.pathname.match(/^\/(?:[a-z0-9][a-z0-9-]*\/)?product\/(\d+)\/?$/i);
        if (!match || ![FARMLEND_TRANSLATE_HOST, "farmlend.ru"].includes(value.hostname)) return;
        const source = `https://farmlend.ru${value.pathname}`;
        const card = $(node).closest("article, li, [class*='product'], [class*='item']");
        const text = ($(node).text() || card.text()).normalize("NFKC").replace(/\s+/g, " ").trim();
        if (text) anchors.push(`<a href="${escapeHtml(source)}">${escapeHtml(text)}</a>`);
      } catch { /* ignore unrelated links */ }
    });
    const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const empty = pageText.match(/(?:ничего не найдено|товары не найдены|no products found|nothing was found)/i)?.[0];
    if (!anchors.length && !empty) return undefined;
    return `<html><head>${base}</head><body>${anchors.join("")}${empty ? `<p>${escapeHtml(empty)}</p>` : ""}</body></html>`;
  }

  if (requested.kind === "farmlend-product") {
    const canonicalValue = $("link[rel='canonical'][href]").first().attr("href");
    let canonical: URL;
    try { canonical = new URL(canonicalValue ?? ""); }
    catch { return undefined; }
    const canonicalId = canonical.pathname.match(/^\/(?:[a-z0-9][a-z0-9-]*\/)?product\/(\d+)\/?$/i)?.[1];
    if (canonical.protocol !== "https:" || canonical.hostname !== "farmlend.ru" || canonicalId !== requested.productId) return undefined;
    const title = $("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const metric = pageText.match(/(?:Общий рейтинг|Overall rating)\s*[0-5](?:[.,]\d+)?\s*(?:на основе|based on)\s*[\d\s\u00a0\u202f]+\s*(?:отзыв[а-яё]* покупателей|customer reviews?)/iu)?.[0];
    const empty = pageText.match(/(?:Пока еще никто не оставил отзыв|No one has left a review yet)/i)?.[0];
    if (!title || !metric && !empty) return undefined;
    return `<html><head>${base}<link rel="canonical" href="${escapeHtml(canonical.toString())}"></head><body>` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(metric ?? empty!)}</p></body></html>`;
  }

  if (requested.kind === "okapteka-group") {
    const anchors: string[] = [];
    $("a[href]").each((_index, node) => {
      const href = $(node).attr("href");
      if (!href) return;
      try {
        const value = new URL(href, `https://${OKAPTEKA_TRANSLATE_HOST}`);
        if (![OKAPTEKA_TRANSLATE_HOST, "okapteka.ru"].includes(value.hostname) ||
          !/^\/[a-z0-9][a-z0-9-]*-\d+\/?$/i.test(value.pathname)) return;
        const card = $(node).closest("article, li, [class*='product'], [class*='item']");
        const text = ($(node).text() || card.text()).normalize("NFKC").replace(/\s+/g, " ").trim();
        if (text) anchors.push(`<a href="https://okapteka.ru${escapeHtml(value.pathname)}">${escapeHtml(text)}</a>`);
      } catch { /* ignore unrelated links */ }
    });
    const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const empty = pageText.match(/(?:ничего не найдено|товары не найдены|no products found)/i)?.[0];
    if (!anchors.length && !empty) return undefined;
    return `<html><head>${base}</head><body>${anchors.join("")}${empty ? `<p>${escapeHtml(empty)}</p>` : ""}</body></html>`;
  }

  const reviews: string[] = [];
  $("[itemprop='review'][data-id]").each((_index, node) => {
    const id = $(node).attr("data-id")?.trim();
    const href = $(node).find("a[href]").first().attr("href");
    if (!id || !href) return;
    try {
      const value = new URL(href, `https://${OKAPTEKA_TRANSLATE_HOST}`);
      if (![OKAPTEKA_TRANSLATE_HOST, "okapteka.ru"].includes(value.hostname) ||
        !/^\/[a-z0-9][a-z0-9-]*-\d+\/?$/i.test(value.pathname)) return;
      const score = $(node).find("[itemprop='ratingValue']").first().attr("content");
      reviews.push(`<article itemprop="review" data-id="${escapeHtml(id)}"><a href="https://okapteka.ru${escapeHtml(value.pathname)}"></a>` +
        `${score ? `<meta itemprop="ratingValue" content="${escapeHtml(score)}">` : ""}</article>`);
    } catch { /* incomplete review remains unproved */ }
  });
  const pages: string[] = [];
  $(".pagination a[href], .pager a[href], a[rel='next'][href]").each((_index, node) => {
    const href = $(node).attr("href");
    if (!href) return;
    try {
      const value = new URL(href, `https://${OKAPTEKA_TRANSLATE_HOST}`);
      const parsed = parsePharmacyTranslateTarget(value.hostname === OKAPTEKA_TRANSLATE_HOST
        ? value
        : new URL(`${value.pathname}${value.search}`, `https://${OKAPTEKA_TRANSLATE_HOST}`));
      if (parsed?.kind === "okapteka-reviews") pages.push(`<a rel="next" href="${escapeHtml(value.toString())}"></a>`);
    } catch { /* ignore unsafe pagination */ }
  });
  const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  const empty = pageText.match(/(?:отзывов пока нет|нет отзывов|no reviews yet|no reviews)/i)?.[0];
  const wrapper = $(".s-reviews-wrapper");
  let exactEmptyWrapper = "";
  if (wrapper.length === 1 && !wrapper.find("[itemprop='review'], [data-review-id], .review-item").length &&
    !wrapper.children().not("a[name], h1").length) {
    const heading = wrapper.find("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const link = wrapper.find("h1 a[href]").first();
    try {
      const productGroup = new URL(link.attr("href") ?? "", `https://${OKAPTEKA_TRANSLATE_HOST}`);
      const reviewBrand = decodeURIComponent(requested.source.pathname.match(/^\/reviews\/([^/]+)\/$/i)?.[1] ?? "");
      const groupBrand = decodeURIComponent(productGroup.pathname.match(/^\/pg\/([^/]+)\/$/i)?.[1] ?? "");
      if ([OKAPTEKA_TRANSLATE_HOST, "okapteka.ru"].includes(productGroup.hostname) && reviewBrand &&
        reviewBrand.normalize("NFKC").toLocaleLowerCase("ru-RU") === groupBrand.normalize("NFKC").toLocaleLowerCase("ru-RU") &&
        heading === `Отзывы на ${reviewBrand}`) {
        exactEmptyWrapper = `<div class="s-reviews-wrapper"><a name="reviewheader"></a><h1>Отзывы на ` +
          `<a href="https://okapteka.ru/pg/${escapeHtml(encodeURIComponent(reviewBrand))}/">${escapeHtml(reviewBrand)}</a></h1></div>`;
      }
    } catch { /* ambiguous empty template remains fail-closed */ }
  }
  if (!reviews.length && !empty && !exactEmptyWrapper) return undefined;
  return `<html><head>${base}</head><body>${reviews.join("")}<nav class="pagination">${pages.join("")}</nav>` +
    `${empty ? `<p>${escapeHtml(empty)}</p>` : exactEmptyWrapper}</body></html>`;
}

function parseOzonTranslateTarget(target: URL): OzonTranslateTarget | undefined {
  if (
    target.protocol !== "https:" || target.hostname !== OZON_TRANSLATE_HOST || target.port ||
    target.username || target.password || target.hash
  ) return undefined;
  if (
    singleSearchParameter(target, "_x_tr_sl") !== "ru" ||
    singleSearchParameter(target, "_x_tr_tl") !== "en" ||
    singleSearchParameter(target, "_x_tr_hl") !== "en"
  ) return undefined;

  const product = target.pathname.match(/^\/product\/[a-z0-9-]*-(\d+)\/$/i);
  if (product) {
    if ([...target.searchParams.keys()].some((key) => !OZON_TRANSLATE_PARAMETERS.has(key))) return undefined;
    return { kind: "product", source: new URL(target.pathname, `https://${OZON_SOURCE_HOST}`), sku: product[1] };
  }

  const isSearch = target.pathname === "/search/";
  const isCategory = /^\/category\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\/$/i.test(target.pathname);
  if (!isSearch && !isCategory) return undefined;
  if ([...target.searchParams.keys()].some((key) =>
    !OZON_TRANSLATE_PARAMETERS.has(key) && !OZON_SEARCH_PARAMETERS.has(key)
  )) return undefined;
  if ([...target.searchParams.keys()].some((key) => target.searchParams.getAll(key).length !== 1)) return undefined;

  const text = singleSearchParameter(target, "text")?.normalize("NFKC").trim() ?? "";
  const page = singleSearchParameter(target, "page") ?? "1";
  if (
    text.length < 1 || text.length > 200 || singleSearchParameter(target, "from_global") !== "true" ||
    !/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 100
  ) return undefined;
  if (isSearch && target.searchParams.has("brand")) {
    if (
      !/^\d{1,18}$/.test(singleSearchParameter(target, "brand") ?? "") ||
      singleSearchParameter(target, "brand_was_predicted") !== "true" ||
      singleSearchParameter(target, "deny_category_prediction") !== "true" ||
      target.searchParams.has("category_was_predicted")
    ) return undefined;
  } else if (isSearch && (
    target.searchParams.has("brand_was_predicted") || target.searchParams.has("category_was_predicted") ||
    target.searchParams.has("deny_category_prediction")
  )) return undefined;
  if (isCategory && (
    singleSearchParameter(target, "category_was_predicted") !== "true" ||
    singleSearchParameter(target, "deny_category_prediction") !== "true" ||
    target.searchParams.has("brand_was_predicted") && singleSearchParameter(target, "brand_was_predicted") !== "true"
  )) return undefined;

  const source = new URL(target.pathname, `https://${OZON_SOURCE_HOST}`);
  for (const [key, value] of target.searchParams) {
    if (!OZON_TRANSLATE_PARAMETERS.has(key)) source.searchParams.set(key, value);
  }
  return { kind: isSearch ? "search" : "category", source };
}

function parseOzonTranslatedComposerTarget(target: URL): OzonTranslatedComposerTarget | undefined {
  if (
    target.protocol !== "https:" || target.hostname !== OZON_TRANSLATE_HOST || target.port ||
    target.username || target.password || target.hash ||
    target.pathname !== "/api/composer-api.bx/page/json/v2" ||
    singleSearchParameter(target, "_x_tr_sl") !== "ru" ||
    singleSearchParameter(target, "_x_tr_tl") !== "en" ||
    singleSearchParameter(target, "_x_tr_hl") !== "en" ||
    target.searchParams.getAll("url").length !== 1 ||
    [...target.searchParams.keys()].some((key) => !OZON_TRANSLATE_PARAMETERS.has(key) && key !== "url") ||
    [...target.searchParams.keys()].some((key) => target.searchParams.getAll(key).length !== 1)
  ) return undefined;
  const nested = singleSearchParameter(target, "url") ?? "";
  let source: URL;
  try { source = new URL(nested, `https://${OZON_SOURCE_HOST}`); }
  catch { return undefined; }
  const sku = source.pathname.match(/^\/product\/[a-z0-9-]*-(\d+)\/$/i)?.[1];
  if (source.origin !== `https://${OZON_SOURCE_HOST}` || source.hash || nested !== `${source.pathname}${source.search}`) {
    return undefined;
  }
  const page = source.searchParams.get("page") ?? "1";
  const safeSearch = source.pathname === "/search/" &&
    (source.searchParams.get("text")?.normalize("NFKC").trim().length ?? 0) > 0 &&
    (source.searchParams.get("text")?.normalize("NFKC").trim().length ?? 0) <= 200 &&
    source.searchParams.get("from_global") === "true" &&
    [...source.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key)) &&
    /^\d+$/.test(page) && Number(page) >= 1 && Number(page) <= 100;
  if (safeSearch) return { kind: "search", source };
  return sku && !source.search ? { kind: "product", source, sku } : undefined;
}

function parseOzonYandexComposerTarget(target: URL): OzonYandexComposerTarget | undefined {
  if (
    target.protocol !== "https:" || target.hostname !== "translate.yandex.ru" || target.port ||
    target.username || target.password || target.hash || target.pathname !== "/translate" ||
    singleSearchParameter(target, "lang") !== "ru-en" || target.searchParams.getAll("url").length !== 1 ||
    [...target.searchParams.keys()].some((key) => !["lang", "url"].includes(key)) ||
    [...target.searchParams.keys()].some((key) => target.searchParams.getAll(key).length !== 1)
  ) return undefined;
  let composer: URL;
  try { composer = new URL(singleSearchParameter(target, "url") ?? ""); }
  catch { return undefined; }
  if (
    composer.protocol !== "https:" || composer.hostname !== OZON_SOURCE_HOST || composer.port ||
    composer.username || composer.password || composer.hash ||
    composer.pathname !== "/api/composer-api.bx/page/json/v2" ||
    composer.searchParams.getAll("url").length !== 1 ||
    [...composer.searchParams.keys()].some((key) => key !== "url")
  ) return undefined;
  const nested = singleSearchParameter(composer, "url") ?? "";
  let source: URL;
  try { source = new URL(nested, `https://${OZON_SOURCE_HOST}`); }
  catch { return undefined; }
  if (source.origin !== `https://${OZON_SOURCE_HOST}` || source.hash || nested !== `${source.pathname}${source.search}`) {
    return undefined;
  }
  const page = source.searchParams.get("page") ?? "1";
  const safeSearch = source.pathname === "/search/" &&
    (source.searchParams.get("text")?.normalize("NFKC").trim().length ?? 0) > 0 &&
    (source.searchParams.get("text")?.normalize("NFKC").trim().length ?? 0) <= 200 &&
    source.searchParams.get("from_global") === "true" &&
    [...source.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key)) &&
    /^\d+$/.test(page) && Number(page) >= 1 && Number(page) <= 100;
  const sku = source.pathname.match(/^\/product\/[a-z0-9-]*-(\d+)\/$/i)?.[1];
  const safeProduct = Boolean(sku) && !source.search;
  return safeSearch || safeProduct ? { composer, source, ...(sku ? { sku } : {}) } : undefined;
}

function ozonJsonLdEntries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(ozonJsonLdEntries);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const graph = Array.isArray(object["@graph"]) ? object["@graph"].flatMap(ozonJsonLdEntries) : [];
  return [object, ...graph];
}

function validOzonTranslateRedirect(html: string, requested: OzonTranslateTarget): boolean {
  if (requested.kind !== "search") return false;
  const encoded = html.match(/location\.replace\(("(?:\\.|[^"\\])*")\)/)?.[1];
  if (!encoded) return false;
  try {
    const redirected = new URL(JSON.parse(encoded) as string);
    const isCategory = /^\/category\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\/$/i.test(redirected.pathname);
    const isBrandSearch = redirected.pathname === "/search/";
    if (
      redirected.protocol !== "https:" || redirected.hostname !== OZON_SOURCE_HOST || redirected.port ||
      redirected.username || redirected.password || redirected.hash ||
      (!isCategory && !isBrandSearch)
    ) return false;
    if ([...redirected.searchParams.keys()].some((key) => !OZON_SEARCH_PARAMETERS.has(key))) return false;
    if ([...redirected.searchParams.keys()].some((key) => redirected.searchParams.getAll(key).length !== 1)) return false;
    const commonProof = redirected.searchParams.get("text") === requested.source.searchParams.get("text") &&
      redirected.searchParams.get("from_global") === "true" &&
      (redirected.searchParams.get("page") ?? "1") === (requested.source.searchParams.get("page") ?? "1");
    if (!commonProof) return false;
    if (isCategory) {
      return redirected.searchParams.get("category_was_predicted") === "true" &&
        redirected.searchParams.get("deny_category_prediction") === "true" &&
        (!redirected.searchParams.has("brand_was_predicted") ||
          redirected.searchParams.get("brand_was_predicted") === "true");
    }
    return /^\d{1,18}$/.test(redirected.searchParams.get("brand") ?? "") &&
      redirected.searchParams.get("brand_was_predicted") === "true" &&
      redirected.searchParams.get("deny_category_prediction") === "true" &&
      !redirected.searchParams.has("category_was_predicted");
  } catch {
    return false;
  }
}

function provesOzonTranslateHtml(html: string, requested: OzonTranslateTarget): boolean {
  if (!/<\/html>\s*$/i.test(html)) return false;
  if (validOzonTranslateRedirect(html, requested)) return true;
  if (!html.includes("window.__NUXT__.state=")) return false;
  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href");
  if (!baseValue) return false;
  try {
    if (exactUrlSignature(new URL(baseValue)) !== exactUrlSignature(requested.source)) return false;
  } catch {
    return false;
  }

  if (requested.kind === "search" || requested.kind === "category") {
    const state = $("script").toArray().map((script) => $(script).text())
      .find((text) => text.includes("window.__NUXT__.state="));
    if (!state) return false;
    const totals = [...state.matchAll(/"totalPages":(\d+)/g)].map((match) => Number(match[1]));
    if (new Set(totals).size !== 1 || totals.length === 0) return false;
    const products = $('[data-widget="tileGridDesktop"] .tile-root').length;
    const explicitEmpty = state.includes("catalog.searchEmptyState");
    return products > 0 ? !explicitEmpty : explicitEmpty;
  }

  const products: Array<Record<string, unknown>> = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      products.push(...ozonJsonLdEntries(JSON.parse($(script).text()) as unknown));
    } catch {
      return false;
    }
  }
  const product = products.find((entry) => {
    const types = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
    return types.includes("Product") && String(entry.sku ?? "") === requested.sku &&
      typeof entry.name === "string" && entry.name.trim().length > 0;
  });
  if (!product) return false;
  const scoreValue = $('[id^="state-webSingleProductScore"][data-state]').first().attr("data-state");
  if (!scoreValue) return false;
  let scoreText: string;
  try {
    const score = JSON.parse(scoreValue) as { text?: unknown };
    if (typeof score.text !== "string" || !score.text.trim()) return false;
    scoreText = score.text.replace(/\s+/g, " ").trim();
  } catch {
    return false;
  }
  const aggregate = product.aggregateRating;
  if (aggregate && typeof aggregate === "object") {
    const value = aggregate as Record<string, unknown>;
    const reviewsText = String(value.reviewCount ?? "");
    const ratingValue = Number(String(value.ratingValue ?? "").replace(",", "."));
    const scoreMatch = scoreText.match(/^([0-5](?:[.,]\d+)?)\s*[•·]\s*([\d\s\u00a0\u202f]+)\s*отзыв(?:а|ов)?$/iu);
    const scoreRating = scoreMatch ? Number(scoreMatch[1]!.replace(",", ".")) : Number.NaN;
    const scoreReviews = scoreMatch ? Number(scoreMatch[2]!.replace(/[\s\u00a0\u202f]+/g, "")) : Number.NaN;
    return /^\d+$/.test(reviewsText) && Number(reviewsText) > 0 && ratingValue > 0 && ratingValue <= 5 &&
      scoreReviews === Number(reviewsText) && scoreRating === ratingValue;
  }
  return /^нет отзывов$/iu.test(scoreText);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MED_OTZYV_PRODUCT_PATH = /^\/lekarstva\/\d+-[a-z0-9-]+\/(\d+)-[a-z0-9-]+\/?$/i;

function medOtzyvProductFromSearchHref(value: string, base: URL): URL | undefined {
  try {
    let candidate = new URL(value, base);
    if (candidate.hostname === "translate.google.com" && candidate.pathname === "/website") {
      const nested = candidate.searchParams.get("u");
      if (!nested) return undefined;
      candidate = new URL(nested);
    }
    if (candidate.hostname === "duckduckgo.com" && candidate.pathname === "/l/") {
      const nested = candidate.searchParams.get("uddg");
      if (!nested) return undefined;
      candidate = new URL(nested);
    }
    const match = candidate.pathname.match(MED_OTZYV_PRODUCT_PATH);
    if (candidate.protocol !== "https:" || candidate.hostname !== "med-otzyv.ru" || candidate.port ||
      candidate.username || candidate.password || candidate.search || candidate.hash || !match) return undefined;
    return new URL(candidate.toString());
  } catch {
    return undefined;
  }
}

function compactTranslatedMedOtzyvSearch(
  html: string,
  translated: URL,
  discovery: URL,
  brand: string
): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html) || /anomaly-modal|captcha|access denied/iu.test(html.slice(0, 150_000))) {
    return undefined;
  }
  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href");
  if (!baseValue) return undefined;
  try {
    const source = new URL(baseValue);
    if (source.protocol !== "https:" || source.hostname !== discovery.hostname || source.pathname !== discovery.pathname ||
      source.searchParams.getAll("q").length !== 1 || source.searchParams.get("q") !== discovery.searchParams.get("q") ||
      [...source.searchParams.keys()].some((key) => key !== "q")) return undefined;
  } catch {
    return undefined;
  }

  const cards = new Map<string, string>();
  $("a.result__a[href], a.result-link[href]").each((_index, node) => {
    const title = $(node).text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const href = $(node).attr("href");
    const product = href ? medOtzyvProductFromSearchHref(href, translated) : undefined;
    const reviews = title.match(/(?:-|—)\s*([\d\s\u00a0\u202f]+)\s+отзыв(?:а|ов)?\s+(?:врачей|пациентов)/iu)?.[1];
    if (!product || !reviews || !matchesBrand(title.split(/\s+(?:-|—)\s+\d/)[0] ?? title, brand)) return;
    const count = Number(reviews.replace(/[\s\u00a0\u202f]/g, ""));
    if (!Number.isSafeInteger(count) || count < 0) return;
    cards.set(product.toString(), `<a class="result__a" href="${escapeHtml(product.toString())}">${escapeHtml(title)}</a>`);
  });
  if (!cards.size) return undefined;
  return `<html><head><base href="${escapeHtml(discovery.toString())}"></head><body>${[...cards.values()].join("")}</body></html>`;
}

function otzovikSourceProductUrl(value: string, searchSource: URL): URL | undefined {
  try {
    const candidate = new URL(value, searchSource);
    const host = candidate.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (!["otzovik.com", "otzovik-com.translate.goog"].includes(host) ||
      !/^\/reviews\/[a-z0-9_-]+\/?$/i.test(candidate.pathname) || candidate.hash) return undefined;
    if (host === "otzovik-com.translate.goog" &&
      [...candidate.searchParams.keys()].some((key) => !["_x_tr_sl", "_x_tr_tl", "_x_tr_hl"].includes(key))) return undefined;
    const source = new URL(candidate.pathname.replace(/\/?$/, "/"), "https://otzovik.com");
    return source;
  } catch {
    return undefined;
  }
}

/**
 * Turns the source-bound first-party Otzovik search into a tiny inert result
 * page. The live site sometimes hides product links in split document.write
 * calls, so reconstruct only its fixed /reviews/<slug>/ pattern without
 * executing page JavaScript.
 */
function compactOtzovikSearchHtml(html: string, requested: URL, brand: string): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  if (!translatedSourceMatches($("base[href]").first().attr("href"), requested) ||
    !translatedSourceMatches($("link[rel='canonical'][href]").first().attr("href"), requested)) return undefined;
  const counterText = $(".product-counter").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  const declaredCount = Number(counterText.match(/\b(\d+)\b/u)?.[1]);
  const items = $(".product-list .item.sortable");
  if (!Number.isSafeInteger(declaredCount) || declaredCount < 0 || declaredCount > 100 || items.length !== declaredCount) {
    return undefined;
  }

  const results = new Map<string, string>();
  let malformed = false;
  items.each((_index, node) => {
    const item = $(node);
    if (!/^\d+$/.test(item.attr("data-pid") ?? "") || !/^\d+$/.test(item.attr("data-reviews") ?? "") ||
      !/^\d+$/.test(item.attr("data-rating") ?? "")) {
      malformed = true;
      return;
    }
    const direct = item.find("a.product-name[href]").first();
    let title = direct.text().normalize("NFKC").replace(/\s+/g, " ").trim();
    let product = direct.attr("href") ? otzovikSourceProductUrl(direct.attr("href")!, requested) : undefined;
    if (!product) {
      const script = item.find("h3.text script").first().text();
      const slug = script.match(/iews\/([a-z0-9_-]+)\//i)?.[1];
      const embeddedTitle = script.match(/class=['"]product-name['"]>([\s\S]*?)<\/a>/i)?.[1];
      if (slug && embeddedTitle) {
        product = otzovikSourceProductUrl(`/reviews/${slug}/`, requested);
        title = embeddedTitle.replace(/\\"/g, '"').replace(/\\'/g, "'")
          .normalize("NFKC").replace(/\s+/g, " ").trim();
      }
    }
    if (!product || !title) {
      malformed = true;
      return;
    }
    if (matchesBrand(title, brand)) results.set(product.toString(), title);
  });
  if (malformed || declaredCount > 0 && results.size === 0) return undefined;
  if (declaredCount === 0) {
    return `<!doctype html><html><head><title>${escapeHtml(brand)}</title></head><body><h1>No results found for ${escapeHtml(brand)}</h1></body></html>`;
  }
  return `<!doctype html><html><head><title>${escapeHtml(brand)}</title></head><body>${[...results]
    .map(([url, title]) => `<a class="result__a" href="${escapeHtml(url)}">${escapeHtml(title)}</a>`).join("\n")}</body></html>`;
}

function compactRuOtzyvTranslateHtml(html: string, requested: RuOtzyvTarget): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const leadingHtml = html.slice(0, 150_000);
  // A normal review form loads Google's reCAPTCHA script even on a healthy
  // product page. Treat only an actual challenge container/page as blocking.
  if (/<(?:form|div|section)\b[^>]*(?:id|class)=["'][^"']*(?:captcha|challenge)[^"']*["']/iu.test(leadingHtml) ||
    /(?:access denied|unusual traffic|проверка браузера|подтвердите, что вы не робот)/iu.test(leadingHtml)) {
    return undefined;
  }
  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href");
  try {
    if (!baseValue || exactUrlSignature(new URL(baseValue)) !== exactUrlSignature(requested.source)) return undefined;
  } catch {
    return undefined;
  }

  const products: Array<Record<string, unknown>> = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try { products.push(...ozonJsonLdEntries(JSON.parse($(script).text()) as unknown)); }
    catch { /* unrelated malformed JSON-LD is not product proof */ }
  }
  const pageTitle = $("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  const product = products.find((entry) => {
    const types = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
    if (!types.includes("Product") || typeof entry.name !== "string" || !entry.name.trim()) return false;
    const name = entry.name.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!pageTitle.toLocaleLowerCase("ru-RU").startsWith(name.toLocaleLowerCase("ru-RU"))) return false;
    const aggregate = entry.aggregateRating;
    if (!aggregate || typeof aggregate !== "object") return false;
    const rating = aggregate as Record<string, unknown>;
    const reviewCount = String(rating.reviewCount ?? "").replace(/[\s\u00a0]+/g, "");
    const ratingCount = String(rating.ratingCount ?? "").replace(/[\s\u00a0]+/g, "");
    const counts = [reviewCount, ratingCount].filter((value) => /^\d+$/.test(value)).map(Number);
    const ratingValue = Number(String(rating.ratingValue ?? "").replace(",", "."));
    const bestRating = Number(String(rating.bestRating ?? "5").replace(",", "."));
    return counts.length > 0 && Math.max(...counts) > 0 && Number.isFinite(ratingValue) &&
      Number.isFinite(bestRating) && bestRating > 0 && bestRating <= 5 && ratingValue > 0 && ratingValue <= bestRating;
  });
  if (!product) return undefined;
  const aggregate = product.aggregateRating as Record<string, unknown>;
  const compactProduct = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: aggregate.ratingValue,
      reviewCount: aggregate.reviewCount,
      ratingCount: aggregate.ratingCount,
      bestRating: aggregate.bestRating ?? 5,
      worstRating: aggregate.worstRating ?? 1
    }
  };
  return `<html><head><base href="${escapeHtml(requested.source.toString())}">` +
    `<script type="application/ld+json">${JSON.stringify(compactProduct).replace(/</g, "\\u003c")}</script>` +
    `</head><body><h1>${escapeHtml(pageTitle)}</h1></body></html>`;
}

function validIrecommendProof(html: string, requested: URL, target: IrecommendTarget): boolean {
  if (/(?:captcha-checker|captcha-container|\bdb-offline\b|\bin-maintenance\b)/i.test(html.slice(0, 150_000))) {
    return false;
  }
  const $ = load(html);
  if (target.kind === "search") {
    let provedCard = false;
    $("ul.srch-result-nodes > li .ProductTizer[data-type='2'][data-nid]").each((_index, node) => {
      const card = $(node);
      const nid = card.attr("data-nid")?.trim() ?? "";
      const href = card.find(".title a[href]").first().attr("href");
      const counter = card.find(".read-all-reviews-link .counter").first().text().replace(/[\s\u00a0]+/g, "");
      const labelled = card.find(".reviewsLink").first().text().match(/([\d\s\u00a0]+)\s+отзыв/iu)?.[1]
        ?.replace(/[\s\u00a0]+/g, "");
      const rating = Number(card.find(".average-rating span").first().text().trim().replace(",", "."));
      if (!/^\d+$/.test(nid) || !href || !/^\d+$/.test(counter) || counter !== labelled ||
        (!Number.isFinite(rating) || rating <= 0 || rating > 5) && Number(counter) > 0) return;
      try {
        const product = new URL(href, requested);
        if (product.protocol === "https:" && product.hostname === "irecommend.ru" && !product.search && !product.hash &&
          /^\/content\/[a-z0-9][a-z0-9-]*\/?$/i.test(product.pathname)) provedCard = true;
      } catch { /* malformed result URL is not proof */ }
    });
    if (provedCard) return true;
    const heading = $("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const text = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    return Boolean(target.brand) && heading.toLocaleLowerCase("ru-RU").includes(target.brand!.toLocaleLowerCase("ru-RU")) &&
      /Не нашли\?\s*Попробуйте поиск по сайту/iu.test(text);
  }

  const canonicalValue = $("link[rel='canonical'][href]").first().attr("href");
  const title = $("h1 [itemprop='name'], h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  const rating = Number($("[itemprop='ratingValue']").first().text().trim().replace(",", "."));
  const voteCount = $(".total-votes [itemprop='reviewCount']").first().text().replace(/[\s\u00a0]+/g, "");
  const noderef = $("a[href*='noderef=']").first().attr("href");
  try {
    const canonical = new URL(canonicalValue ?? "");
    const nodeId = noderef ? new URL(noderef, requested).searchParams.get("noderef") ?? "" : "";
    const exactCanonical = canonical.protocol === "https:" && canonical.hostname === "irecommend.ru" &&
      canonical.pathname.replace(/\/$/, "") === requested.pathname.replace(/\/$/, "") && !canonical.search && !canonical.hash &&
      canonical.search === requested.search;
    if (exactCanonical && Boolean(title) && /^\d+$/.test(nodeId) &&
      Number.isFinite(rating) && rating > 0 && rating <= 5 && /^\d+$/.test(voteCount)) return true;

    // A cached reader can return inert Markdown converted to HTML instead of
    // the original DOM. It may prove only the rating aggregate on this exact
    // URL; written reviews still come exclusively from the two agreeing,
    // explicitly labelled counters in the search ProductTizer above.
    const documentTitle = $("title").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const exactMetricLink = $("a[href]").toArray().some((node) => {
      try {
        const href = new URL($(node).attr("href") ?? "");
        if (href.protocol !== "https:" || href.hostname !== "irecommend.ru" || href.search || href.hash ||
          href.pathname.replace(/\/$/, "") !== requested.pathname.replace(/\/$/, "")) return false;
        const metric = $(node).text().normalize("NFKC").replace(/\s+/g, " ").trim()
          .match(/Среднее\s*:\s*(?:Среднее\s*:\s*)?([0-5](?:[.,]\d+)?)\s*\(\s*([\d\s\u00a0]+)\s+голос/iu);
        const linkedRating = metric ? Number(metric[1]!.replace(",", ".")) : Number.NaN;
        const linkedVotes = metric?.[2]?.replace(/[\s\u00a0]+/g, "") ?? "";
        return Number.isFinite(linkedRating) && linkedRating > 0 && linkedRating <= 5 && /^\d+$/.test(linkedVotes);
      } catch {
        return false;
      }
    });
    return exactCanonical && Boolean(documentTitle) && exactMetricLink;
  } catch {
    return false;
  }
}

function exactIrecommendReaderSource(markdown: string, expected: URL): boolean {
  const sourceValue = markdown.match(/^URL Source:\s*(https:\/\/[^\s]+)\s*$/mi)?.[1];
  try {
    return Boolean(sourceValue) && exactUrlSignature(new URL(sourceValue!)) === exactUrlSignature(expected);
  } catch {
    return false;
  }
}

function compactIrecommendReaderSearch(
  markdown: string,
  requested: URL,
  brand: string,
  readerSource: URL = requested
): string | undefined {
  if (!exactIrecommendReaderSource(markdown, readerSource)) return undefined;

  const cards = new Map<string, { id: string; title: string; url: string; reviews: number; rating: number }>();
  const cardPattern = /\[([^\]\n]+)\]\((https:\/\/irecommend\.ru\/content\/[a-z0-9][a-z0-9-]*)\)\s+\[Читать\s+все\s+отзывы\s+([\d\s\u00a0]+)\]\((https:\/\/irecommend\.ru\/content\/[a-z0-9][a-z0-9-]*)\)/giu;
  for (const match of markdown.matchAll(cardPattern)) {
    const title = match[1]!.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!matchesBrand(title, brand) || match[2] !== match[4]) continue;
    const start = match.index ?? 0;
    const cardText = markdown.slice(start, start + 2_500);
    const metric = cardText.match(/Среднее\s*:\s*(?:Среднее\s*:\s*)?([0-5](?:[.,]\d+)?)\s*\(\s*([\d\s\u00a0]+)\s+голос/iu);
    const written = cardText.match(/\[([\d\s\u00a0]+)\s+отзыв(?:а|ов)?\]\((https:\/\/irecommend\.ru\/content\/[a-z0-9][a-z0-9-]*)\)/iu);
    const productId = cardText.match(/\/product-images\/(\d{1,18})\//i)?.[1];
    const readAllCount = Number(match[3]!.replace(/[\s\u00a0]+/g, ""));
    const writtenCount = Number(written?.[1]?.replace(/[\s\u00a0]+/g, ""));
    const voteCount = Number(metric?.[2]?.replace(/[\s\u00a0]+/g, ""));
    const rating = Number(metric?.[1]?.replace(",", "."));
    if (
      !productId || !Number.isSafeInteger(readAllCount) || readAllCount < 0 ||
      !Number.isSafeInteger(writtenCount) || writtenCount !== readAllCount || written?.[2] !== match[2] ||
      !Number.isSafeInteger(voteCount) || voteCount < 0 ||
      !Number.isFinite(rating) || rating <= 0 || rating > 5 ||
      readAllCount > 0 && voteCount === 0
    ) continue;
    const existing = cards.get(match[2]!);
    const candidate = { id: productId, title, url: match[2]!, reviews: readAllCount, rating };
    if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) return undefined;
    cards.set(candidate.url, candidate);
  }
  if (!cards.size) return undefined;

  const rendered = [...cards.values()].map((card) => `<li><div class="ProductTizer" data-type="2" data-nid="${card.id}">` +
    `<div class="title"><a href="${escapeHtml(card.url)}">${escapeHtml(card.title)}</a></div>` +
    `<a class="read-all-reviews-link" href="${escapeHtml(card.url)}"><span class="counter">${card.reviews}</span></a>` +
    `<div class="reviewsLink">${card.reviews} отзывов</div>` +
    `<div class="fivestar-summary"><span class="average-rating"><span>${card.rating}</span></span></div>` +
    `</div></li>`).join("");
  return `<html><head><link rel="canonical" href="${escapeHtml(requested.toString())}"></head>` +
    `<body><h1>${escapeHtml(brand)}</h1><ul class="srch-result-nodes">${rendered}</ul></body></html>`;
}

/**
 * The EdgeOne Agent-to-Function hop has a much smaller practical response
 * budget than a browser request. Return only the already-verified proof that
 * the deterministic Ozon parser consumes, never the 0.5-2 MB storefront shell.
 */
function compactOzonTranslateHtml(html: string, requested: OzonTranslateTarget): string {
  const encodedRedirect = html.match(/location\.replace\(("(?:\\.|[^"\\])*")\)/)?.[1];
  if (encodedRedirect && validOzonTranslateRedirect(html, requested)) {
    return `<html><body><script>location.replace(${encodedRedirect})</script></body></html>`;
  }

  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href")!;
  if (requested.kind === "search" || requested.kind === "category") {
    const state = $("script").toArray().map((script) => $(script).text())
      .find((text) => text.includes("window.__NUXT__.state="))!;
    const totalPages = Number(state.match(/"totalPages":(\d+)/)![1]);
    const explicitEmpty = state.includes("catalog.searchEmptyState");
    const tiles = $('[data-widget="tileGridDesktop"] .tile-root').toArray().map((root) => {
      const tile = $(root);
      const anchors = tile.find('a[href*="/product/"]').toArray().map((anchor) => {
        const href = $(anchor).attr("href") ?? "";
        const text = $(anchor).text().normalize("NFKC").replace(/\s+/g, " ").trim();
        return `<a href="${escapeHtml(href)}"><span>${escapeHtml(text)}</span></a>`;
      }).join("");
      // At most one compact metric row is needed. Exact metrics are verified
      // again on the dedicated product page before publication.
      const ratingMarker = tile.find('svg[style*="graphicRating"]').first();
      let metrics = "";
      if (ratingMarker.length) {
        const row = ratingMarker.parent();
        const spans = row.find("span").toArray().map((span) =>
          `<span>${escapeHtml($(span).text().normalize("NFKC").replace(/\s+/g, " ").trim())}</span>`
        ).join("");
        metrics = `<div><svg style="color:var(--graphicRating)"></svg>${spans}</div>`;
      }
      return `<div class="tile-root">${anchors}${metrics}</div>`;
    }).join("");
    const proof = explicitEmpty ? ",\"proof\":\"catalog.searchEmptyState\"" : "";
    return `<html><head><base href="${escapeHtml(baseValue)}"></head><body>` +
      `${tiles ? `<div data-widget="tileGridDesktop">${tiles}</div>` : ""}` +
      `<script>window.__NUXT__={};window.__NUXT__.state={"totalPages":${totalPages}${proof}}</script>` +
      `</body></html>`;
  }

  const products: Array<Record<string, unknown>> = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    products.push(...ozonJsonLdEntries(JSON.parse($(script).text()) as unknown));
  }
  const product = products.find((entry) => {
    const types = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
    return types.includes("Product") && String(entry.sku ?? "") === requested.sku;
  })!;
  const scoreValue = $('[id^="state-webSingleProductScore"][data-state]').first().attr("data-state")!;
  const variantIds = new Set<string>([requested.sku!]);
  $('a[href*="/product/"][href*="from_sku="]').each((_index, node) => {
    const raw = $(node).attr("href");
    if (!raw) return;
    try {
      const link = new URL(raw, `https://${OZON_TRANSLATE_HOST}`);
      if (![OZON_TRANSLATE_HOST, OZON_SOURCE_HOST].includes(link.hostname) ||
        link.searchParams.get("from_sku") !== requested.sku || link.searchParams.get("oos_search") !== "false") return;
      const variantId = link.pathname.match(/^\/product\/[a-z0-9-]*-(\d+)\/$/i)?.[1];
      if (variantId) variantIds.add(variantId);
    } catch { /* unrelated malformed storefront link */ }
  });
  const variantProof = variantIds.size > 1
    ? `<meta name="ratings-ozon-variant-skus" content="${[...variantIds].sort((left, right) => Number(left) - Number(right)).join(",")}">`
    : "";
  return `<html><head><base href="${escapeHtml(baseValue)}">` +
    variantProof +
    `<script type="application/ld+json">${JSON.stringify(product).replace(/</g, "\\u003c")}</script></head><body>` +
    `<div id="state-webSingleProductScore-proof" data-state="${escapeHtml(scoreValue)}"></div>` +
    `<script>window.__NUXT__={};window.__NUXT__.state={}</script></body></html>`;
}

function compactAptekaRuHtml(html: string, requested: AptekaRuTarget): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const title = $("title").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (/(?:captcha|access denied|unusual traffic|проверка браузера|Target URL returned error)/i.test(title) ||
    /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 150_000))) return undefined;
  const canonicalValue = $("link[rel='canonical'][href]").first().attr("href");
  if (!translatedSourceMatches(canonicalValue, requested.source)) return undefined;
  const base = `<base href="${escapeHtml(requested.source.toString())}">`;

  if (requested.kind === "preparation") {
    const heading = $("h1").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const products = new Map<string, { url: string; title: string }>();
    $("a[href*='/product/']").each((_index, node) => {
      let product: URL;
      try { product = new URL($(node).attr("href") ?? "", requested.source); }
      catch { return; }
      const id = product.pathname.match(/^\/product\/[a-z0-9-]+-([a-f0-9]{24})\/$/i)?.[1];
      const productTitle = ($(node).attr("aria-label") || $(node).text()).normalize("NFKC").replace(/\s+/g, " ").trim();
      if (product.protocol !== "https:" || ![APTEKA_TRANSLATE_HOST, "apteka.ru"].includes(product.hostname) || !id || !productTitle) return;
      products.set(id, { url: `https://apteka.ru${product.pathname}`, title: productTitle });
    });
    const pageText = $.root().text().normalize("NFKC").replace(/\s+/g, " ").trim();
    const empty = pageText.match(/(?:ничего не найдено|товары не найдены|нет в наличии)/i)?.[0];
    if (!heading || !products.size && !empty) return undefined;
    return `<html><head>${base}<link rel="canonical" href="${escapeHtml(requested.source.toString())}"></head><body><main>` +
      `<h1>${escapeHtml(heading)}</h1>${[...products.values()].map((product) =>
        `<article class="product"><a href="${escapeHtml(product.url)}" aria-label="${escapeHtml(product.title)}">${escapeHtml(product.title)}</a></article>`
      ).join("")}${empty ? `<p>${escapeHtml(empty)}</p>` : ""}</main></body></html>`;
  }

  const products: Array<Record<string, unknown>> = [];
  for (const script of $("script[type='application/ld+json']").toArray()) {
    try { products.push(...ozonJsonLdEntries(JSON.parse($(script).text()) as unknown)); }
    catch { /* unrelated malformed JSON-LD is not product proof */ }
  }
  const product = products.find((item) => {
    const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
    return types.includes("Product") && String(item.sku ?? "") === requested.productId &&
      typeof item.name === "string" && item.name.trim().length > 0;
  });
  if (!product) return undefined;
  const aggregate = product.aggregateRating;
  if (!aggregate || typeof aggregate !== "object") return undefined;
  const metrics = aggregate as Record<string, unknown>;
  const reviewCount = String(metrics.reviewCount ?? "").replace(/[\s\u00a0\u202f]+/g, "");
  const ratingCount = String(metrics.ratingCount ?? "").replace(/[\s\u00a0\u202f]+/g, "");
  const counts = [reviewCount, ratingCount].filter((value) => /^\d+$/.test(value)).map(Number);
  const ratingValue = Number(String(metrics.ratingValue ?? "").replace(",", "."));
  if (!counts.length || Math.max(...counts) > 0 && (!Number.isFinite(ratingValue) || ratingValue <= 0 || ratingValue > 5)) return undefined;
  const compactProduct = {
    "@context": "https://schema.org", "@type": "Product", sku: requested.productId, name: product.name,
    aggregateRating: {
      "@type": "AggregateRating",
      ...(reviewCount ? { reviewCount: Number(reviewCount) } : {}),
      ...(ratingCount ? { ratingCount: Number(ratingCount) } : {}),
      ...(Math.max(...counts) > 0 ? { ratingValue } : {})
    }
  };
  return `<html><head>${base}<link rel="canonical" href="${escapeHtml(requested.source.toString())}">` +
    `<script type="application/ld+json">${JSON.stringify(compactProduct).replace(/</g, "\\u003c")}</script>` +
    `</head><body><h1>${escapeHtml(String(product.name))}</h1></body></html>`;
}

/**
 * Uteka review pages include recommendation payloads for other products. Keep
 * only the one schema.org Product aggregate bound to the canonical reviews
 * route. Uteka may move a product between categories, so a redirect is accepted
 * only when the terminal product slug is unchanged; analog counters never pass.
 */
function compactUtekaReviewsHtml(html: string, requested: UtekaReviewsTarget): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const title = normalized($("title").first().text());
  if (!title || /(?:captcha|access denied|unusual traffic|Target URL returned error)/i.test(title) ||
    /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 180_000))) return undefined;

  let canonical: URL;
  let openGraphUrl: URL;
  try {
    canonical = new URL($("link[rel='canonical'][href]").first().attr("href") ?? "", requested.source);
    openGraphUrl = new URL($("meta[property='og:url'][content]").first().attr("content") ?? "", requested.source);
  } catch { return undefined; }
  const requestedSlug = requested.source.pathname.match(/\/([a-z0-9][a-z0-9-]*)\/reviews\/$/i)?.[1];
  const canonicalTarget = parseUtekaReviewsTarget(canonical);
  const canonicalSlug = canonical.pathname.match(/\/([a-z0-9][a-z0-9-]*)\/reviews\/$/i)?.[1];
  if (!canonicalTarget || !requestedSlug || canonicalSlug !== requestedSlug ||
    exactUrlSignature(openGraphUrl) !== exactUrlSignature(canonical)) return undefined;

  const products = $("[itemscope][itemtype='https://schema.org/Product']").toArray();
  if (products.length !== 1) return undefined;
  const product = $(products[0]);
  const productName = normalized(product.find("meta[itemprop='name'][content]").first().attr("content") ?? "");
  const heading = normalized(product.find("h1").first().text());
  if (!productName || !heading || !heading.toLocaleLowerCase("ru-RU").includes(productName.toLocaleLowerCase("ru-RU"))) {
    return undefined;
  }

  const aggregates = product.find("[itemscope][itemprop='aggregateRating'][itemtype='https://schema.org/AggregateRating']").toArray();
  if (aggregates.length !== 1) return undefined;
  const aggregate = $(aggregates[0]);
  const countText = aggregate.find("[itemprop='reviewCount']").first().attr("content")?.replace(/[\s\u00a0\u202f]+/g, "") ?? "";
  const ratingText = aggregate.find("[itemprop='ratingValue']").first().attr("content")?.replace(",", ".") ?? "";
  const bestText = aggregate.find("[itemprop='bestRating']").first().attr("content")?.replace(",", ".") ?? "5";
  if (!/^\d+$/.test(countText)) return undefined;
  const reviewCount = Number(countText);
  const ratingValue = Number(ratingText);
  const bestRating = Number(bestText);
  if (!Number.isSafeInteger(reviewCount) || reviewCount < 0 || reviewCount > 10_000_000 ||
    !Number.isFinite(bestRating) || bestRating !== 5 ||
    reviewCount > 0 && (!Number.isFinite(ratingValue) || ratingValue <= 0 || ratingValue > bestRating) ||
    reviewCount === 0 && ratingText && (!Number.isFinite(ratingValue) || ratingValue < 0 || ratingValue > bestRating)) {
    return undefined;
  }

  return `<html><head><base href="${escapeHtml(canonical.toString())}">` +
    `<link rel="canonical" href="${escapeHtml(canonical.toString())}"><title>${escapeHtml(title)}</title></head>` +
    `<body><main itemscope itemtype="https://schema.org/Product"><meta itemprop="name" content="${escapeHtml(productName)}">` +
    `<h1>${escapeHtml(heading)}</h1><div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">` +
    `<meta itemprop="reviewCount" content="${reviewCount}">` +
    `${reviewCount > 0 ? `<meta itemprop="ratingValue" content="${ratingValue}">` : ""}` +
    `<meta itemprop="bestRating" content="5"></div></main></body></html>`;
}

/**
 * EdgeOne's cross-runtime hand-off can truncate multi-megabyte sitemap
 * responses even though the first-party XML itself is complete. Keep every
 * product URL (discovery remains exhaustive) while dropping lastmod/priority
 * fields that the adapter never reads. The complete upstream document and
 * exact shard range are verified before any compact proof is returned.
 */
function compactYandexModelSitemap(xml: string, requested: URL): string | undefined {
  const range = requested.pathname.match(YANDEX_MODEL_SITEMAP_PATH);
  if (!range || !/<urlset\b/i.test(xml) || !/<\/urlset\s*>\s*$/i.test(xml)) return undefined;
  const minimumId = BigInt(range[1]);
  const maximumId = BigInt(range[2]);
  const $ = load(xml, { xmlMode: true });
  const roots = $("urlset");
  if (roots.length !== 1) return undefined;
  const urls = roots.first().children("url");
  const locations: string[] = [];
  for (const node of urls.toArray()) {
    const locs = $(node).children("loc");
    if (locs.length !== 1) return undefined;
    const raw = locs.first().text().trim();
    let product: URL;
    try { product = new URL(raw); }
    catch { return undefined; }
    // Live shards contain a small number of canonical numeric routes without
    // a title slug (`/product/--3252533`). They are valid members of the
    // declared shard and must be preserved for completeness. The adapter
    // cannot match an empty slug to a requested brand, so this does not widen
    // discovery or turn an unrelated card into a candidate.
    const modelId = product.pathname.match(/^\/product\/(?:[a-z0-9][a-z0-9_-]*)?--(\d+)$/i)?.[1];
    if (product.protocol !== "https:" || product.hostname !== "reviews.yandex.ru" || product.port ||
      product.username || product.password || product.search || product.hash || !modelId) return undefined;
    const numericId = BigInt(modelId);
    if (numericId < minimumId || numericId > maximumId) return undefined;
    locations.push(product.toString());
  }
  if (locations.length !== $("url").length) return undefined;
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    locations.map((location) => `<url><loc>${escapeHtml(location)}</loc></url>`).join("") +
    `</urlset>`;
}

function compactMedOtzyvProductHtml(html: string, requested: URL): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const title = normalized($("h1").first().text() || $("title").first().text());
  const pageText = normalized($.root().text());
  const countText = [
    $("[itemprop='reviewCount']").first().attr("content"),
    $("[itemprop='reviewCount']").first().text(),
    pageText.match(/Все\s+отзывы\s+([\d\s\u00a0\u202f]+)/iu)?.[1],
    title.match(/(?:-|—)\s*([\d\s\u00a0\u202f]+)\s+отзыв/iu)?.[1]
  ].find((value) => Boolean(value?.trim()));
  const reviewCount = countText === undefined ? Number.NaN : Number(String(countText).replace(/[\s\u00a0\u202f]/g, ""));
  let canonical: URL;
  try {
    canonical = new URL($("link[rel='canonical'][href]").first().attr("href") ?? requested.toString(), requested);
  } catch { return undefined; }
  if (!title || !Number.isSafeInteger(reviewCount) || reviewCount < 0 ||
    canonical.protocol !== "https:" || canonical.hostname.replace(/^www\./, "") !== "med-otzyv.ru" ||
    canonical.pathname.replace(/\/$/, "") !== requested.pathname.replace(/\/$/, "")) return undefined;
  return `<html><head><base href="${escapeHtml(requested.toString())}">` +
    `<link rel="canonical" href="${escapeHtml(requested.toString())}"></head><body>` +
    `<h1>${escapeHtml(title)}</h1><meta itemprop="reviewCount" content="${reviewCount}"></body></html>`;
}

function assertOwner(run: RunState, user: AuthUser): void {
  if (run.ownerEmail && run.ownerEmail !== user.email) throw new Error("Этот запуск принадлежит другому сотруднику");
}

function pagedRun(run: RunState, url: URL): RunState & { observationPage: { offset: number; limit: number; total: number } } {
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset") ?? 0)) || 0);
  const limit = Math.max(1, Math.min(250, Math.trunc(Number(url.searchParams.get("limit") ?? 200)) || 200));
  return { ...run, observations: run.observations.slice(offset, offset + limit), observationPage: { offset, limit, total: run.observations.length } };
}

async function repositoryRpc(request: Request, env: Record<string, string | undefined>, repository: BlobRepository): Promise<Response> {
  const configured = env.INTERNAL_AGENT_TOKEN?.trim() ?? "";
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (configured.length < 32 || !secureEqual(configured, supplied)) return json({ error: "Internal authorization failed" }, 401);
  const body = await request.json() as RepositoryRpc;
  let result: unknown;
  switch (body.action) {
    case "getRun": result = await repository.getRun(body.id); break;
    case "saveRun": {
      const previous = await repository.getRun(body.run.id);
      if (previous?.ownerEmail && body.run.ownerEmail !== previous.ownerEmail) throw new Error("Нельзя изменить владельца запуска");
      await repository.saveRun(body.run); result = null; break;
    }
    case "getProfile": result = await repository.getProfile(body.domain); break;
    case "saveProfile": await repository.saveProfile(body.profile); result = null; break;
    case "listProducts": result = await repository.listProducts(body.spreadsheetId); break;
    case "saveProducts": await repository.saveProducts(body.spreadsheetId, body.records); result = null; break;
    case "replaceProducts": await repository.replaceProducts(body.spreadsheetId, body.records); result = null; break;
    case "getSnapshots": result = await repository.getSnapshots(body.spreadsheetId); break;
    case "saveSnapshot": await repository.saveSnapshot(body.spreadsheetId, body.month, body.observations); result = null; break;
    case "replaceSnapshots": await repository.replaceSnapshots(body.spreadsheetId, body.snapshots); result = null; break;
    case "getPublication": result = await repository.getPublication(body.key); break;
    case "savePublication": await repository.savePublication(body.key, body.publication); result = null; break;
    case "reserveUsage": result = await repository.reserveUsage(body.key, body.amount, body.limit); break;
    case "releaseUsage": result = await repository.releaseUsage(body.key, body.amount); break;
    case "acquireLease": result = await repository.acquireLease(body.scope, body.leaseMs, 1); break;
    case "releaseLease": await repository.releaseLease(body.lease); result = null; break;
    case "putEvidence": result = await new BlobEvidenceStore().put(body.payload); break;
    default: return json({ error: "Unknown repository action" }, 400);
  }
  return json({ result });
}

export async function staticReviewFetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
  const configured = env.INTERNAL_AGENT_TOKEN?.trim() ?? "";
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (configured.length < 32 || !secureEqual(configured, supplied)) return json({ error: "Internal authorization failed" }, 401);
  const body = await request.json() as { url?: string };
  const target = new URL(String(body.url ?? ""));
  const host = target.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  const irecommendTarget = parseIrecommendTarget(target);
  const ruOtzyvTarget = parseRuOtzyvTarget(target);
  const utekaReviewsTarget = parseUtekaReviewsTarget(target);
  const utekaSitemapTarget = target.protocol === "https:" && target.hostname === "uteka.ru" &&
    !target.port && !target.username && !target.password && !target.search && !target.hash &&
    target.pathname === "/sitemaps/sitemap-reviews.xml";
  const reviewTarget = new Set([
    "megapteka.ru",
    "otzovik.com",
    "pravogolosa.net"
  ]).has(host) || Boolean(irecommendTarget) || Boolean(ruOtzyvTarget) || Boolean(utekaReviewsTarget) || utekaSitemapTarget;
  const medOtzyvSearchTarget = target.protocol === "https:" && host === "med-otzyv.ru" &&
    target.pathname === "/__external_search__" && !target.port && !target.username && !target.password && !target.hash &&
    [...target.searchParams.keys()].every((key) => key === "brand") && target.searchParams.getAll("brand").length === 1 &&
    (target.searchParams.get("brand")?.trim().length ?? 0) >= 2 && (target.searchParams.get("brand")?.trim().length ?? 0) <= 160;
  const medOtzyvProductTarget = target.protocol === "https:" && host === "med-otzyv.ru" &&
    !target.port && !target.username && !target.password && !target.search && !target.hash &&
    /^\/lekarstva\/\d+-[a-z0-9-]+\/\d+-[a-z0-9-]+\/?$/i.test(target.pathname);
  const megamarketTranslatedTarget = target.protocol === "https:" && target.hostname === "megamarket-ru.translate.goog" &&
    !target.port && !target.username && !target.password && !target.hash && (
      target.pathname === "/catalog/" || /^\/catalog\/details\/[a-z0-9-]+-\d{6,18}\/?$/i.test(target.pathname)
    ) && [...target.searchParams.keys()].every((key) => ["q", "page", "_x_tr_sl", "_x_tr_tl", "_x_tr_hl"].includes(key)) &&
    target.searchParams.getAll("_x_tr_sl").length === 1 && target.searchParams.get("_x_tr_sl") === "ru" &&
    target.searchParams.getAll("_x_tr_tl").length === 1 && target.searchParams.get("_x_tr_tl") === "en" &&
    target.searchParams.getAll("_x_tr_hl").length === 1 && target.searchParams.get("_x_tr_hl") === "en" &&
    (target.pathname !== "/catalog/" || (
      target.searchParams.getAll("q").length === 1 && (target.searchParams.get("q")?.trim().length ?? 0) >= 2 &&
      (target.searchParams.get("q")?.trim().length ?? 0) <= 160 &&
      (!target.searchParams.has("page") || target.searchParams.getAll("page").length === 1 &&
        /^\d+$/.test(target.searchParams.get("page") ?? "") && Number(target.searchParams.get("page")) >= 2 && Number(target.searchParams.get("page")) <= 20)
    ));
  const wildberriesTarget = (
    target.hostname === "search.wb.ru" && [
      "/exactmatch/ru/common/v14/search",
      "/exactmatch/ru/common/v18/search"
    ].includes(target.pathname) ||
    target.hostname === "card.wb.ru" && target.pathname === "/cards/v4/detail"
  );
  const yandexTarget = target.protocol === "https:" && target.hostname === "reviews.yandex.ru" &&
    !target.port && !target.username && !target.password && !target.hash && !target.search && (
      target.pathname === "/ugcpub/sitemap.xml" ||
      /^\/ugcpub\/sitemap_model_\d+-\d+-\d+\.xml$/i.test(target.pathname) ||
      /^\/product\/(?:[a-z0-9_-]+--)?\d+$/i.test(target.pathname)
    );
  const zdravcityTarget = target.protocol === "https:" && target.hostname === "zdravcity.ru" &&
    !target.port && !target.username && !target.password && !target.hash && !target.search && (
      /^\/g_[a-z0-9-]+\/$/i.test(target.pathname) ||
      /^\/p_[a-z0-9][a-z0-9-]*-\d+\.html$/i.test(target.pathname)
    );
  const ozonTranslatedTarget = parseOzonTranslateTarget(target);
  const ozonTranslatedComposerTarget = parseOzonTranslatedComposerTarget(target);
  const ozonYandexComposerTarget = parseOzonYandexComposerTarget(target);
  const pharmacyTranslatedTarget = parsePharmacyTranslateTarget(target);
  const aptekaRuTarget = parseAptekaRuTarget(target);
  let ozonTarget = false;
  if (target.hostname === "www.ozon.ru" && target.pathname === "/api/composer-api.bx/page/json/v2") {
    const nested = target.searchParams.get("url") ?? "";
    try {
      const search = new URL(nested, "https://www.ozon.ru");
      const page = search.searchParams.get("page") ?? "1";
      const safeSearch = search.origin === "https://www.ozon.ru" &&
        search.pathname === "/search/" &&
        (search.searchParams.get("text")?.trim().length ?? 0) > 0 &&
        (search.searchParams.get("text")?.trim().length ?? 0) <= 200 &&
        search.searchParams.get("from_global") === "true" &&
        [...search.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key)) &&
        /^\d+$/.test(page) && Number(page) >= 1 && Number(page) <= 100;
      const safeProduct = search.origin === "https://www.ozon.ru" && !search.hash && !search.search &&
        /^\/product\/[a-z0-9-]*\d{5,}\/$/i.test(search.pathname);
      ozonTarget = target.searchParams.getAll("url").length === 1 &&
        [...target.searchParams.keys()].every((key) => key === "url") && (safeSearch || safeProduct);
    } catch { /* invalid nested Ozon search URL */ }
  }
  if (target.protocol !== "https:" || !(reviewTarget || medOtzyvSearchTarget || medOtzyvProductTarget || megamarketTranslatedTarget || wildberriesTarget || yandexTarget || zdravcityTarget || ozonTarget || ozonTranslatedTarget || ozonTranslatedComposerTarget || ozonYandexComposerTarget || pharmacyTranslatedTarget || aptekaRuTarget)) {
    return json({ error: "Static review fetch destination is not allowed" }, 400);
  }
  if (ozonTranslatedComposerTarget) {
    await assertSafePublicDestination(target.toString());
    let upstream = await fetch(target.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, text/plain, */*", "accept-language": "ru-RU,ru;q=0.9" },
      signal: AbortSignal.timeout(60_000)
    });
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      if (ozonTranslatedComposerTarget.kind !== "search") {
        return json({ error: "Ozon translated product composer redirected unexpectedly" }, 502);
      }
      let redirected: URL;
      try { redirected = new URL(upstream.headers.get("location") ?? ""); }
      catch { return json({ error: "Ozon translated composer returned an invalid category redirect" }, 502); }
      const nestedCategory = singleSearchParameter(redirected, "url") ?? "";
      let categorySource: URL;
      try { categorySource = new URL(nestedCategory, `https://${OZON_SOURCE_HOST}`); }
      catch { return json({ error: "Ozon translated composer returned an invalid category source" }, 502); }
      const allowedOuterKeys = new Set(["page_changed", "url", "_x_tr_sl", "_x_tr_tl", "_x_tr_hl"]);
      const allowedCategoryKeys = new Set([
        "brand_was_predicted", "category_was_predicted", "deny_category_prediction",
        "from_global", "page", "text"
      ]);
      const requestedPage = ozonTranslatedComposerTarget.source.searchParams.get("page") ?? "1";
      const categoryPage = categorySource.searchParams.get("page") ?? "1";
      const safeCategoryRedirect = redirected.origin === target.origin && redirected.pathname === target.pathname &&
        !redirected.username && !redirected.password && !redirected.hash &&
        singleSearchParameter(redirected, "page_changed") === "true" &&
        singleSearchParameter(redirected, "_x_tr_sl") === "ru" &&
        singleSearchParameter(redirected, "_x_tr_tl") === "en" &&
        singleSearchParameter(redirected, "_x_tr_hl") === "en" &&
        redirected.searchParams.getAll("url").length === 1 &&
        [...redirected.searchParams.keys()].every((key) => allowedOuterKeys.has(key)) &&
        [...redirected.searchParams.keys()].every((key) => redirected.searchParams.getAll(key).length === 1) &&
        categorySource.origin === `https://${OZON_SOURCE_HOST}` &&
        /^\/category\/[a-z0-9-]+-\d{2,}(?:\/[a-z0-9-]+-\d{2,})?\/$/i.test(categorySource.pathname) &&
        !categorySource.hash && [...categorySource.searchParams.keys()].every((key) => allowedCategoryKeys.has(key)) &&
        [...categorySource.searchParams.keys()].every((key) => categorySource.searchParams.getAll(key).length === 1) &&
        categorySource.searchParams.get("brand_was_predicted") === "true" &&
        categorySource.searchParams.get("category_was_predicted") === "true" &&
        categorySource.searchParams.get("deny_category_prediction") === "true" &&
        categorySource.searchParams.get("from_global") === "true" &&
        categorySource.searchParams.get("text") === ozonTranslatedComposerTarget.source.searchParams.get("text") &&
        /^\d+$/.test(categoryPage) && categoryPage === requestedPage;
      if (!safeCategoryRedirect) {
        return json({ error: "Ozon translated composer category redirect changed the requested brand or page" }, 502);
      }
      await assertSafePublicDestination(redirected.toString());
      upstream = await fetch(redirected.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json, text/plain, */*", "accept-language": "ru-RU,ru;q=0.9" },
        signal: AbortSignal.timeout(60_000)
      });
    }
    const body = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok || !/json/i.test(upstream.headers.get("content-type") ?? "")) {
      return json({ error: `Ozon translated composer did not return exact JSON (HTTP ${upstream.status})` }, 502);
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-ozon-composer"
      }
    });
  }
  if (ozonYandexComposerTarget) {
    await assertSafePublicDestination(target.toString());
    const redirectResponse = await fetch(target.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, text/plain, */*", "accept-language": "ru-RU,ru;q=0.9" },
      signal: AbortSignal.timeout(60_000)
    });
    if (![301, 302, 303, 307, 308].includes(redirectResponse.status)) {
      return json({ error: `Yandex Ozon composer did not return its fixed redirect (HTTP ${redirectResponse.status})` }, 502);
    }
    const location = redirectResponse.headers.get("location");
    let redirected: URL;
    try { redirected = new URL(location ?? ""); }
    catch { return json({ error: "Yandex Ozon composer returned an invalid redirect" }, 502); }
    const redirectedNested = singleSearchParameter(redirected, "url") ?? "";
    let redirectedSource: URL;
    try { redirectedSource = new URL(redirectedNested, `https://${OZON_SOURCE_HOST}`); }
    catch { return json({ error: "Yandex Ozon composer returned an invalid source redirect" }, 502); }
    const expectedPath = /^\/proxy_u\/[a-z0-9.-]+\/https\/www\.ozon\.ru\/api\/composer-api\.bx\/page\/json\/v2$/i;
    const requestedPage = ozonYandexComposerTarget.source.searchParams.get("page") ?? "1";
    const redirectedPage = redirectedSource.searchParams.get("page") ?? "1";
    const sameSearch = ozonYandexComposerTarget.source.pathname === "/search/" &&
      redirectedSource.origin === `https://${OZON_SOURCE_HOST}` && redirectedSource.pathname === "/search/" &&
      !redirectedSource.hash && [...redirectedSource.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key)) &&
      [...redirectedSource.searchParams.keys()].every((key) => redirectedSource.searchParams.getAll(key).length === 1) &&
      redirectedSource.searchParams.get("text") === ozonYandexComposerTarget.source.searchParams.get("text") &&
      redirectedSource.searchParams.get("from_global") === "true" && redirectedPage === requestedPage;
    const sameProduct = Boolean(ozonYandexComposerTarget.sku) &&
      redirectedSource.origin === `https://${OZON_SOURCE_HOST}` &&
      redirectedSource.pathname === ozonYandexComposerTarget.source.pathname &&
      !redirectedSource.search && !redirectedSource.hash;
    if (
      redirected.protocol !== "https:" || redirected.hostname !== "translated.turbopages.org" ||
      redirected.port || redirected.username || redirected.password || redirected.hash ||
      !expectedPath.test(redirected.pathname) || redirected.searchParams.getAll("url").length !== 1 ||
      [...redirected.searchParams.keys()].some((key) => key !== "url") ||
      (!sameSearch && !sameProduct)
    ) return json({ error: "Yandex Ozon composer redirect is outside the exact requested product or search" }, 502);
    await assertSafePublicDestination(redirected.toString());
    let upstream = await fetch(redirected.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, text/plain, */*", "accept-language": "ru-RU,ru;q=0.9" },
      signal: AbortSignal.timeout(60_000)
    });
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const categoryLocation = upstream.headers.get("location");
      let categoryRedirect: URL;
      try { categoryRedirect = new URL(categoryLocation ?? ""); }
      catch { return json({ error: "Yandex Ozon composer returned an invalid category redirect" }, 502); }
      const nestedCategory = singleSearchParameter(categoryRedirect, "url") ?? "";
      let categorySource: URL;
      try { categorySource = new URL(nestedCategory, `https://${OZON_SOURCE_HOST}`); }
      catch { return json({ error: "Yandex Ozon composer returned an invalid category source" }, 502); }
      const allowedCategoryKeys = new Set([
        "brand_was_predicted", "category_was_predicted", "deny_category_prediction",
        "from_global", "page", "text"
      ]);
      const categoryPage = categorySource.searchParams.get("page") ?? "1";
      const safeCategoryRedirect = ozonYandexComposerTarget.source.pathname === "/search/" &&
        categoryRedirect.origin === redirected.origin && categoryRedirect.pathname === redirected.pathname &&
        !categoryRedirect.username && !categoryRedirect.password && !categoryRedirect.hash &&
        singleSearchParameter(categoryRedirect, "page_changed") === "true" &&
        categoryRedirect.searchParams.getAll("url").length === 1 &&
        [...categoryRedirect.searchParams.keys()].every((key) => ["page_changed", "url"].includes(key)) &&
        [...categoryRedirect.searchParams.keys()].every((key) => categoryRedirect.searchParams.getAll(key).length === 1) &&
        categorySource.origin === `https://${OZON_SOURCE_HOST}` &&
        /^\/category\/[a-z0-9-]+-\d{2,}(?:\/[a-z0-9-]+-\d{2,})?\/$/i.test(categorySource.pathname) &&
        !categorySource.hash && [...categorySource.searchParams.keys()].every((key) => allowedCategoryKeys.has(key)) &&
        [...categorySource.searchParams.keys()].every((key) => categorySource.searchParams.getAll(key).length === 1) &&
        categorySource.searchParams.get("brand_was_predicted") === "true" &&
        categorySource.searchParams.get("category_was_predicted") === "true" &&
        categorySource.searchParams.get("deny_category_prediction") === "true" &&
        categorySource.searchParams.get("from_global") === "true" &&
        categorySource.searchParams.get("text") === ozonYandexComposerTarget.source.searchParams.get("text") &&
        /^\d+$/.test(categoryPage) && categoryPage === requestedPage;
      if (!safeCategoryRedirect) {
        return json({ error: "Yandex Ozon composer category redirect changed the requested brand or page" }, 502);
      }
      await assertSafePublicDestination(categoryRedirect.toString());
      upstream = await fetch(categoryRedirect.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json, text/plain, */*", "accept-language": "ru-RU,ru;q=0.9" },
        signal: AbortSignal.timeout(60_000)
      });
    }
    const body = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok || !/json/i.test(upstream.headers.get("content-type") ?? "")) {
      return json({ error: `Yandex Ozon composer did not return exact JSON (HTTP ${upstream.status})` }, 502);
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "yandex-translate-ozon-composer"
      }
    });
  }
  if (medOtzyvProductTarget) {
    try {
      const upstream = await safeFetch(target.toString(), {
        method: "GET", redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
      }, fetch, 4, 60_000);
      const html = await readTextBounded(upstream, 12_000_000, 60_000);
      const compact = upstream.ok ? compactMedOtzyvProductHtml(html, target) : undefined;
      if (compact) return new Response(compact, { status: 200, headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-ratings-source": "med-otzyv-first-party-compact"
      } });
    } catch { /* exact public page remains unavailable */ }
    return json({ error: "Med-otzyv product page did not prove the exact aggregate" }, 502);
  }
  if (medOtzyvSearchTarget) {
    const brand = target.searchParams.get("brand")!.trim();
    const discovery = new URL("https://html.duckduckgo.com/html/");
    discovery.searchParams.set("q", `site:med-otzyv.ru/lekarstva/ "${brand}"`);
    try {
      const upstream = await safeFetch(discovery.toString(), {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
      }, fetch, 4, 45_000);
      const html = await readTextBounded(upstream, 2_000_000, 45_000);
      if (upstream.status === 200 && !/anomaly-modal|captcha|access denied/iu.test(html.slice(0, 150_000))) {
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-ratings-source": "duckduckgo-exact-med-otzyv-index"
          }
        });
      }
    } catch { /* try the fixed translated egress below */ }

    const translated = new URL(discovery.pathname, "https://html-duckduckgo-com.translate.goog");
    translated.searchParams.set("q", discovery.searchParams.get("q")!);
    translated.searchParams.set("_x_tr_sl", "auto");
    translated.searchParams.set("_x_tr_tl", "ru");
    translated.searchParams.set("_x_tr_hl", "ru");
    try {
      const fallback = await safeFetch(translated.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
      }, fetch, 0, 60_000);
      const fallbackBody = await readTextBounded(fallback, 3_000_000, 60_000);
      const compact = fallback.ok
        ? compactTranslatedMedOtzyvSearch(fallbackBody, translated, discovery, brand)
        : undefined;
      if (compact) return new Response(compact, { status: 200, headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-ratings-source": "google-translate-duckduckgo-med-otzyv"
      } });
    } catch { /* no exact translated result proof */ }
    return json({ error: "Med-otzyv discovery did not prove an exact product aggregate" }, 502);
  }
  if (utekaReviewsTarget) {
    let fallbackAllowed = false;
    try {
      const direct = await safeFetch(utekaReviewsTarget.source.toString(), {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
      }, fetch, 4, 60_000);
      const directBody = await readTextBounded(direct, 12_000_000, 60_000);
      if (direct.ok) {
        const compact = /(?:text\/html|application\/xhtml\+xml)/i.test(direct.headers.get("content-type") ?? "")
          ? compactUtekaReviewsHtml(directBody, utekaReviewsTarget)
          : undefined;
        if (compact && compact.length <= 100_000) {
          return new Response(compact, { status: 200, headers: {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "x-ratings-source": "uteka-first-party-compact",
            "x-ratings-original-bytes": String(new TextEncoder().encode(directBody).byteLength),
            "x-ratings-proof-bytes": String(new TextEncoder().encode(compact).byteLength)
          } });
        }
        // A CDN shell can return HTTP 200 without the requested aggregate.
        // It is not product proof, but it is safe to try the independently
        // source-bound reader before failing closed.
        fallbackAllowed = true;
      } else if ([404, 410].includes(direct.status)) {
        return new Response(directBody, { status: direct.status, headers: {
          "content-type": direct.headers.get("content-type") ?? "text/html; charset=utf-8",
          "cache-control": "no-store"
        } });
      } else {
        fallbackAllowed = [403, 408, 425, 429, 499, 500, 502, 503, 504].includes(direct.status);
      }
      if (!direct.ok && !fallbackAllowed) {
        return new Response(directBody, { status: direct.status, headers: {
          "content-type": direct.headers.get("content-type") ?? "text/html; charset=utf-8",
          "cache-control": "no-store"
        } });
      }
    } catch {
      fallbackAllowed = true;
    }

    if (fallbackAllowed) {
      try {
        const reader = await safeFetch(readerProxyUrl(utekaReviewsTarget.source).toString(), {
          method: "GET",
          redirect: "follow",
          headers: { accept: "text/html,application/xhtml+xml", "x-return-format": "html", "x-no-cache": "true", dnt: "1" }
        }, fetch, 4, 60_000);
        const readerBody = await readTextBounded(reader, 12_000_000, 60_000);
        const compact = reader.ok ? compactUtekaReviewsHtml(readerBody, utekaReviewsTarget) : undefined;
        if (compact && compact.length <= 100_000) {
          return new Response(compact, { status: 200, headers: {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "x-ratings-source": "uteka-reader-compact",
            "x-ratings-original-bytes": String(new TextEncoder().encode(readerBody).byteLength),
            "x-ratings-proof-bytes": String(new TextEncoder().encode(compact).byteLength)
          } });
        }
      } catch { /* the exact reader proof remains unavailable */ }
    }
    return json({ error: "Uteka access fallback did not prove the exact requested product aggregate" }, 502);
  }
  if (megamarketTranslatedTarget) {
    const upstream = await safeFetch(target.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    }, fetch, 0, 60_000);
    const html = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok) {
      return new Response(html, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8" }
      });
    }
    if (!/(?:text\/html|application\/xhtml\+xml)/i.test(upstream.headers.get("content-type") ?? "")) {
      return json({ error: "Megamarket translated response is not HTML" }, 502);
    }
    const compactHtml = compactMegamarketTranslateHtml(html, target);
    if (!compactHtml || compactHtml.length > 350_000) {
      return json({ error: "Megamarket page did not prove the exact requested source and aggregate" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-megamarket-compact",
        "x-ratings-original-bytes": String(new TextEncoder().encode(html).byteLength),
        "x-ratings-proof-bytes": String(new TextEncoder().encode(compactHtml).byteLength)
      }
    });
  }
  if (aptekaRuTarget) {
    const upstream = await safeFetch(aptekaRuTarget.source.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: aptekaRuTarget.kind === "sitemap" ? "application/xml,text/xml" : "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    }, fetch, 0, 60_000);
    const html = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok) {
      return new Response(html, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8" }
      });
    }
    if (aptekaRuTarget.kind === "sitemap") {
      if (!/<urlset\b/i.test(html)) return json({ error: "Apteka.ru product sitemap is invalid" }, 502);
      const locations: string[] = [];
      for (const match of html.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        let product: URL;
        try { product = new URL(match[1].replace(/&amp;/gi, "&")); }
        catch { continue; }
        const productSlug = product.pathname.match(/^\/product\/([a-z0-9-]+)-[a-f0-9]{24}\/?$/i)?.[1];
        if (product.protocol !== "https:" || product.hostname !== "apteka.ru" || !productSlug ||
          !aptekaRuTarget.slugs!.some((slug) => productSlug === slug || productSlug.startsWith(`${slug}-`))) continue;
        locations.push(product.toString());
      }
      if (locations.length > 100) return json({ error: "Apteka.ru sitemap filter is too broad" }, 400);
      const compactXml = `<?xml version="1.0" encoding="UTF-8"?><urlset data-source-url="${escapeHtml(target.toString())}">` +
        locations.map((location) => `<url><loc>${escapeHtml(location)}</loc></url>`).join("") + `</urlset>`;
      return new Response(compactXml, {
        status: 200,
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "no-store",
          "x-ratings-source": "apteka-first-party-product-sitemap"
        }
      });
    }
    if (!/(?:text\/html|application\/xhtml\+xml)/i.test(upstream.headers.get("content-type") ?? "")) {
      return json({ error: "Apteka.ru response is not HTML" }, 502);
    }
    const compactHtml = compactAptekaRuHtml(html, aptekaRuTarget);
    if (!compactHtml || compactHtml.length > 350_000) {
      return json({ error: "Apteka.ru page did not prove the requested source and metrics" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "apteka-first-party-ssr",
        "x-ratings-original-bytes": String(new TextEncoder().encode(html).byteLength),
        "x-ratings-proof-bytes": String(new TextEncoder().encode(compactHtml).byteLength)
      }
    });
  }
  if (pharmacyTranslatedTarget) {
    const upstream = await safeFetch(target.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    }, fetch, 0, 60_000);
    let html = await readTextBounded(upstream, 12_000_000, 60_000);
    let compactHtml = upstream.ok && /(?:text\/html|application\/xhtml\+xml)/i.test(upstream.headers.get("content-type") ?? "")
      ? compactPharmacyTranslateHtml(html, pharmacyTranslatedTarget)
      : undefined;
    let source = "google-translate-pharmacy-ssr";
    // ASNA's first-party card is public and source-bound, while Google
    // Translate intermittently answers 502 for the same card. Use the exact
    // canonical product page as a free fallback and still pass it through the
    // same strict SKU/aggregate compactor. No recommendation card can enter.
    if (!compactHtml && pharmacyTranslatedTarget.kind === "asna-product") {
      try {
        const direct = await safeFetch(pharmacyTranslatedTarget.source.toString(), {
          method: "GET",
          redirect: "follow",
          headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
        }, fetch, 4, 60_000);
        const directHtml = await readTextBounded(direct, 12_000_000, 60_000);
        if (direct.ok && /(?:text\/html|application\/xhtml\+xml)/i.test(direct.headers.get("content-type") ?? "text/html")) {
          const sourceBoundHtml = directHtml.replace(/<head([^>]*)>/i,
            `<head$1><base href="${escapeHtml(pharmacyTranslatedTarget.source.toString())}">`);
          compactHtml = compactPharmacyTranslateHtml(sourceBoundHtml, pharmacyTranslatedTarget);
          if (compactHtml) {
            html = directHtml;
            source = "asna-first-party-ssr";
          }
        }
      } catch { /* exact ASNA aggregate remains unavailable */ }
    }
    if (!upstream.ok && !compactHtml && pharmacyTranslatedTarget.kind !== "asna-product") {
      return new Response(html, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8" }
      });
    }
    if (!compactHtml || compactHtml.length > 350_000) {
      return json({ error: "Translated pharmacy page did not prove the requested source and metrics" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": source,
        "x-ratings-original-bytes": String(new TextEncoder().encode(html).byteLength),
        "x-ratings-proof-bytes": String(new TextEncoder().encode(compactHtml).byteLength)
      }
    });
  }
  if (zdravcityTarget) {
    const translated = new URL(target.pathname, `https://${ZDRAVCITY_TRANSLATE_HOST}`);
    translated.searchParams.set("_x_tr_sl", "ru");
    translated.searchParams.set("_x_tr_tl", "en");
    translated.searchParams.set("_x_tr_hl", "en");
    const upstream = await safeFetch(translated.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    }, fetch, 0, 60_000);
    const html = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok) {
      return new Response(html, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8" }
      });
    }
    if (!/(?:text\/html|application\/xhtml\+xml)/i.test(upstream.headers.get("content-type") ?? "")) {
      return json({ error: "Translated Zdravcity response is not HTML" }, 502);
    }
    const compactHtml = compactZdravcityTranslateHtml(html, target);
    if (!compactHtml || compactHtml.length > 350_000) {
      return json({ error: "Translated Zdravcity page did not prove the exact requested product data" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-zdravcity-ssr",
        "x-ratings-original-bytes": String(new TextEncoder().encode(html).byteLength),
        "x-ratings-proof-bytes": String(new TextEncoder().encode(compactHtml).byteLength)
      }
    });
  }
  if (ozonTranslatedTarget) {
    const upstream = await safeFetch(target.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    }, fetch, 0, 60_000);
    const html = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok) {
      return new Response(html, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8" }
      });
    }
    if (!/(?:text\/html|application\/xhtml\+xml)/i.test(upstream.headers.get("content-type") ?? "") ||
      /(?:incidentId|Antibot Captcha|abt-challenge|Target URL returned error 403)/i.test(html) ||
      !provesOzonTranslateHtml(html, ozonTranslatedTarget)) {
      return json({ error: "Ozon translated page did not prove the requested source and product semantics" }, 502);
    }
    const compactHtml = compactOzonTranslateHtml(html, ozonTranslatedTarget);
    if (compactHtml.length > 350_000) {
      return json({ error: "Ozon translated proof exceeded the internal transfer safety limit" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-ozon-ssr",
        "x-ratings-original-bytes": String(new TextEncoder().encode(html).byteLength),
        "x-ratings-proof-bytes": String(new TextEncoder().encode(compactHtml).byteLength)
      }
    });
  }
  if (ruOtzyvTarget) {
    const upstream = await safeFetch(ruOtzyvTarget.translated.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    }, fetch, 0, 60_000);
    const html = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok) {
      return new Response(html, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8" }
      });
    }
    if (!/(?:text\/html|application\/xhtml\+xml)/i.test(upstream.headers.get("content-type") ?? "")) {
      return json({ error: "Translated ru.otzyv.com response is not HTML" }, 502);
    }
    const compactHtml = compactRuOtzyvTranslateHtml(html, ruOtzyvTarget);
    if (!compactHtml || compactHtml.length > 100_000) {
      return json({ error: "Translated ru.otzyv.com page did not prove the exact product aggregate" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-ru-otzyv-ssr"
      }
    });
  }
  if (irecommendTarget) {
    try {
      const direct = await safeFetch(target.toString(), {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
      }, fetch, 0, 60_000);
      const directBody = await readTextBounded(direct, 12_000_000, 60_000);
      if (direct.ok && /(?:text\/html|application\/xhtml\+xml)/i.test(direct.headers.get("content-type") ?? "") &&
        validIrecommendProof(directBody, target, irecommendTarget)) {
        return new Response(directBody, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-ratings-source": "irecommend-direct" }
        });
      }
    } catch { /* fall back to the bounded cached reader */ }

    // Jina's HTML rendering intermittently preserves iRecommend's CAPTCHA
    // shell. Markdown is source-bound, contains the same visible aggregate
    // proof and remains consumable by the strict compact parser below.
    const readerHeaders = { accept: "text/plain; charset=utf-8", "x-return-format": "markdown", dnt: "1" };
    const reader = await safeFetch(readerProxyUrl(target).toString(), {
      method: "GET",
      redirect: "follow",
      headers: readerHeaders
    });
    const readerBody = await readTextBounded(reader, 12_000_000, 60_000);
    if (reader.ok && irecommendTarget.kind === "search") {
      const compact = compactIrecommendReaderSearch(readerBody, target, irecommendTarget.brand!);
      if (compact && validIrecommendProof(compact, target, irecommendTarget)) {
        return new Response(compact, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-ratings-source": "irecommend-reader-compact"
          }
        });
      }
    }
    const html = reader.ok && /^\s*(?:<!doctype\s+html|<html\b)/i.test(readerBody)
      ? readerBody
      : reader.ok ? readerMarkdownToHtml(readerBody, target.toString()) : "";
    if (html && validIrecommendProof(html, target, irecommendTarget)) {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-ratings-source": "reader-fallback" }
      });
    }

    // Jina occasionally holds a CAPTCHA shell under the canonical cache key
    // while the same first-party page is available under iRecommend's inert
    // `new=1` view. Derive that key internally (never from user input), bind
    // URL Source exactly, and still emit proof for the canonical requested URL.
    const refreshedTarget = new URL(target.toString());
    refreshedTarget.searchParams.set("new", "1");
    const refreshed = await safeFetch(readerProxyUrl(refreshedTarget).toString(), {
      method: "GET", redirect: "follow", headers: readerHeaders
    });
    const refreshedBody = await readTextBounded(refreshed, 12_000_000, 60_000);
    if (refreshed.ok && exactIrecommendReaderSource(refreshedBody, refreshedTarget)) {
      if (irecommendTarget.kind === "search") {
        const compact = compactIrecommendReaderSearch(
          refreshedBody, target, irecommendTarget.brand!, refreshedTarget
        );
        if (compact && validIrecommendProof(compact, target, irecommendTarget)) {
          return new Response(compact, { status: 200, headers: {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "x-ratings-source": "irecommend-reader-refreshed"
          } });
        }
      } else {
        const refreshedHtml = readerMarkdownToHtml(refreshedBody, target.toString());
        if (validIrecommendProof(refreshedHtml, target, irecommendTarget)) {
          return new Response(refreshedHtml, { status: 200, headers: {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "x-ratings-source": "irecommend-reader-refreshed"
          } });
        }
      }
    }
    return json({ error: "iRecommend response did not prove the requested product or search result" }, 502);
  }
  if (host === "otzovik.com" && /^\/reviews\/[a-z0-9_-]+\/?$/i.test(target.pathname)) {
    if (target.search || target.hash || !["otzovik.com", "www.otzovik.com"].includes(target.hostname)) {
      return json({ error: "Invalid Otzovik product source URL" }, 400);
    }
    // Search indexes and old Sheets may retain www. The proof gateway always
    // binds the translated response to the same apex-host product path.
    target.hostname = "otzovik.com";
    const translated = new URL(`https://otzovik-com.translate.goog${target.pathname}`);
    translated.searchParams.set("_x_tr_sl", "ru");
    translated.searchParams.set("_x_tr_tl", "en");
    translated.searchParams.set("_x_tr_hl", "en");
    const upstream = await safeFetch(translated.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
    });
    const html = await readTextBounded(upstream, 12_000_000, 60_000);
    if (!upstream.ok) return new Response(html, { status: upstream.status, headers: { "content-type": "text/html; charset=utf-8" } });
    const sourceMatches = (value: string | undefined): boolean => {
      if (!value) return false;
      try {
        const source = new URL(value);
        return source.protocol === "https:" && source.hostname === "otzovik.com" &&
          source.pathname === target.pathname && !source.search && !source.hash;
      } catch { return false; }
    };
    const attribute = (tag: string, name: string): string | undefined =>
      tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1];
    const baseTag = html.match(/<base\b[^>]*>/i)?.[0];
    const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)]
      .find((match) => /\brel=["'][^"']*\bcanonical\b[^"']*["']/i.test(match[0]))?.[0];
    const productAggregate = /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(html) &&
      /itemprop=["']aggregateRating["']/i.test(html) &&
      /itemprop=["']ratingValue["'][^>]*content=["'][\d.,]+["']/i.test(html) &&
      /itemprop=["']reviewCount["'][^>]*content=["'][\d\s\u00a0]+["']/i.test(html);
    if (!sourceMatches(baseTag ? attribute(baseTag, "href") : undefined) ||
      !sourceMatches(canonicalTag ? attribute(canonicalTag, "href") : undefined) || !productAggregate) {
      return json({ error: "Otzovik translated page did not prove the requested product aggregate" }, 502);
    }
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-ssr"
      }
    });
  }
  if (host === "megapteka.ru" || host === "otzovik.com") {
    let readerTarget = target;
    if (host === "otzovik.com" && target.pathname === "/__external_search__") {
      const brand = target.searchParams.get("brand")?.trim() ?? "";
      if (brand.length < 2 || brand.length > 160 || [...target.searchParams.keys()].some((key) => key !== "brand")) {
        return json({ error: "Invalid Otzovik external discovery query" }, 400);
      }
      const sourceSearch = new URL("https://otzovik.com/");
      sourceSearch.searchParams.set("search_text", brand);
      const translatedSearch = new URL(sourceSearch.pathname, "https://otzovik-com.translate.goog");
      for (const [key, value] of sourceSearch.searchParams) translatedSearch.searchParams.set(key, value);
      translatedSearch.searchParams.set("_x_tr_sl", "ru");
      translatedSearch.searchParams.set("_x_tr_tl", "en");
      translatedSearch.searchParams.set("_x_tr_hl", "en");
      const translated = await safeFetch(translatedSearch.toString(), {
        method: "GET", redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9" }
      });
      const translatedBody = await readTextBounded(translated, 12_000_000, 60_000);
      const compact = translated.ok ? compactOtzovikSearchHtml(translatedBody, sourceSearch, brand) : undefined;
      if (compact) {
        return new Response(compact, { status: 200, headers: {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "x-ratings-source": "google-translate-otzovik-search"
        } });
      }
      readerTarget = new URL("https://html.duckduckgo.com/html/");
      readerTarget.searchParams.set("q", `site:otzovik.com/reviews/ "${brand}"`);
    }
    const reader = await safeFetch(readerProxyUrl(readerTarget).toString(), {
      method: "GET",
      redirect: "follow",
      headers: { accept: "text/plain; charset=utf-8", "x-no-cache": "true", "x-return-format": "html", dnt: "1" }
    });
    const readerBody = await readTextBounded(reader, 12_000_000, 60_000);
    if (!reader.ok) return new Response(readerBody, { status: reader.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    const html = /^\s*(?:<!doctype\s+html|<html\b)/i.test(readerBody)
      ? readerBody
      : readerMarkdownToHtml(readerBody, target.toString());
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "reader-fallback"
      }
    });
  }
  const upstream = await safeFetch(target.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      accept: wildberriesTarget || ozonTarget || ozonTranslatedComposerTarget
        ? "application/json, text/plain, */*"
        : yandexTarget && target.pathname.startsWith("/ugcpub/")
          ? "application/xml,text/xml"
          : "text/html,application/xhtml+xml",
      "accept-language": "ru-RU,ru;q=0.9",
      ...(wildberriesTarget ? {
        origin: "https://www.wildberries.ru",
        referer: "https://www.wildberries.ru/"
      } : {})
    }
  }, fetch, ozonTranslatedComposerTarget ? 0 : 4);
  const text = await readTextBounded(upstream, 12_000_000, 60_000);
  if (upstream.ok && ozonTranslatedComposerTarget && !/json/i.test(upstream.headers.get("content-type") ?? "")) {
    return json({ error: "Ozon translated composer did not return exact JSON" }, 502);
  }
  if (upstream.ok && yandexTarget && YANDEX_MODEL_SITEMAP_PATH.test(target.pathname)) {
    const compact = compactYandexModelSitemap(text, target);
    if (!compact) return json({ error: "Yandex model sitemap did not prove a complete exact shard" }, 502);
    return new Response(compact, {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "yandex-model-sitemap-compact",
        "x-ratings-original-bytes": String(new TextEncoder().encode(text).byteLength),
        "x-ratings-proof-bytes": String(new TextEncoder().encode(compact).byteLength)
      }
    });
  }
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(ozonTranslatedComposerTarget ? { "x-ratings-source": "google-translate-ozon-composer" } : {})
    }
  });
}

export default async function onRequest(context: Context): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname === "/api/config") return json({
    domains: INITIAL_DOMAINS, brands: INITIAL_BRANDS, companyBrands: COMPANY_BRANDS,
    googleClientId: null,
    authRequired: context.env.RATINGS_ALLOW_UNAUTHENTICATED !== "true", agentMode: true
  });
  if (url.pathname === "/api/health") return json({ ok: true, service: "ratings-collector", runtime: "edgeone" });
  const repository = new BlobRepository();
  if (url.pathname === "/api/internal/repository" && context.request.method === "POST") {
    try { return await repositoryRpc(context.request, context.env, repository); }
    catch (error) { return json({ error: safeErrorMessage(error) }, 400); }
  }
  if (url.pathname === "/api/internal/static-review-fetch" && context.request.method === "POST") {
    try { return await staticReviewFetch(context.request, context.env); }
    catch (error) { return json({ error: safeErrorMessage(error) }, 502); }
  }
  let user: AuthUser;
  try { user = await authenticate(context.request.headers, authConfig(context.env)); }
  catch (error) { return json({ error: safeErrorMessage(error) }, 401); }
  const service = new RatingsService(repository, async () => { throw new Error("Адаптеры выполняются только в изолированном Agent"); });
  try {
    if (context.request.method === "POST" && url.pathname === "/api/runs") {
      const input = await context.request.json();
      // Normal runs use only free marketplace adapters. An explicitly enabled
      // paid fallback checks its quota lazily inside the Agent, so run creation
      // never depends on Apify availability or credit.
      const run = await service.createRun(input, user.email);
      return json(pagedRun(run, url), 202);
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    const publishMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/publish$/);
    const reviewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review$/);
    const companionSessionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/companion\/ozon\/session$/);
    const companionImportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/companion\/ozon$/);
    const profileGetMatch = url.pathname.match(/^\/api\/site-profiles\/([^/]+)$/);
    const profileMatch = url.pathname.match(/^\/api\/site-profiles\/([^/]+)\/approve$/);
    if (context.request.method === "GET" && runMatch) {
      let run = await service.getRun(decodeURIComponent(runMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      if (reconcileStaleCollectionCheckpoint(run)) await repository.saveRun(run);
      if (run.status !== "published") run = await reconcileBrowserPublication(repository, run);
      return json(pagedRun(run, url));
    }
    if (context.request.method === "POST" && publishMatch) {
      let run = await service.getRun(decodeURIComponent(publishMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const body = await context.request.json().catch(() => ({})) as { excludeFailedPartitions?: boolean };
      if (body.excludeFailedPartitions === true) {
        run = await service.excludeFailedPartitionsFromPublication(run.id);
      }
      const intent = await prepareBrowserPublication(repository, service, run);
      return json(pagedRun(intent.run, url), intent.shouldPublish ? 202 : 200);
    }
    if (context.request.method === "POST" && reviewMatch) {
      const run = await service.getRun(decodeURIComponent(reviewMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const body = await context.request.json() as { acceptedKeys?: string[]; productLabels?: Record<string, string> };
      return json(pagedRun(await service.approveObservations(
        run.id,
        body.acceptedKeys ?? [],
        body.productLabels ?? {}
      ), url));
    }
    if (context.request.method === "POST" && companionSessionMatch) {
      const runId = decodeURIComponent(companionSessionMatch[1]);
      const run = await service.getRun(runId);
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      return json(await issueOzonCompanionSession(repository, runId, user.email));
    }
    if (context.request.method === "POST" && companionImportMatch) {
      const runId = decodeURIComponent(companionImportMatch[1]);
      const run = await service.getRun(runId);
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const body = await context.request.json();
      return json(pagedRun(await importOzonCompanionResult(repository, runId, user.email, body), url));
    }
    if (context.request.method === "GET" && profileGetMatch) {
      const profile = await repository.getProfile(decodeURIComponent(profileGetMatch[1]));
      return profile ? json(profile) : json({ error: "Профиль площадки не найден" }, 404);
    }
    if (context.request.method === "POST" && profileMatch) {
      const body = await context.request.json() as {
        examples?: Array<{ url: string; title?: string }>;
        reviewCountMeaning?: "reviews" | "ratings" | "feedback" | "unknown";
      };
      return json(await service.approveProfile(
        decodeURIComponent(profileMatch[1]), body.examples ?? [], body.reviewCountMeaning ?? "unknown"
      ));
    }
    return json({ error: "API route not found" }, 404);
  } catch (error) {
    return json({ error: safeErrorMessage(error) }, 400);
  }
}
