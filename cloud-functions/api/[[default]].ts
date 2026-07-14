import { timingSafeEqual } from "node:crypto";
import { load } from "cheerio";
import { INITIAL_BRANDS, INITIAL_DOMAINS } from "../../src/shared/constants.js";
import type { RunState } from "../../src/shared/types.js";
import { authenticate, authConfig, type AuthUser } from "../../src/server/auth.js";
import { BlobEvidenceStore, BlobRepository } from "../../src/server/blob-repository.js";
import { RatingsService } from "../../src/server/orchestrator.js";
import type { RepositoryRpc } from "../../src/server/remote-repository.js";
import { prepareBrowserPublication, reconcileBrowserPublication } from "../../src/server/sheets/publication-state.js";
import { safeErrorMessage } from "../../src/server/utils/error-message.js";
import { readTextBounded, safeFetch } from "../../src/server/utils/safe-fetch.js";
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

type PharmacyTranslateTarget = {
  kind: "farmlend-search" | "farmlend-product" | "okapteka-group" | "okapteka-reviews" | "asna-product";
  source: URL;
  productId?: string;
};

type OzonTranslateTarget = {
  kind: "search" | "category" | "product";
  source: URL;
  sku?: string;
};

type IrecommendTarget = {
  kind: "search" | "product";
  brand?: string;
};

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
      : target.hostname === ASNA_TRANSLATE_HOST ? "www.asna.ru" : undefined;
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

function translatedSourceMatches(value: string | undefined, requested: URL): boolean {
  if (!value) return false;
  try {
    return exactUrlSignature(new URL(value)) === exactUrlSignature(requested);
  } catch {
    return false;
  }
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

function compactPharmacyTranslateHtml(html: string, requested: PharmacyTranslateTarget): string | undefined {
  if (!/(?:<\/html>|<\/body>)\s*$/i.test(html)) return undefined;
  const $ = load(html);
  const title = $("title").first().text().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (/(?:captcha|access denied|unusual traffic|подозрительн\w*\s+активност|проверка\s+браузера|Target URL returned error)/i.test(title) ||
    /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/i.test(html.slice(0, 150_000))) return undefined;
  const baseValue = $("base[href]").first().attr("href");
  if (!translatedSourceMatches(baseValue, requested.source)) return undefined;
  const base = `<base href="${escapeHtml(baseValue!)}">`;

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
    return `<html><head>${base}<link rel="canonical" href="${escapeHtml(canonicalValue!)}"></head><body>` +
      `<script data-source-url="${escapeHtml(requested.source.toString())}"></script>` +
      `<div class="productPage__content product__item" itemscope itemtype="http://schema.org/Product">` +
      `<meta itemprop="sku" content="${escapeHtml(sku)}"><div itemprop="aggregateRating" itemscope>` +
      `${rating ? `<meta itemprop="ratingValue" content="${escapeHtml(rating)}">` : ""}` +
      `<meta itemprop="reviewCount" content="${escapeHtml(reviews!)}"></div></div></body></html>`;
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
  if (!reviews.length && !empty) return undefined;
  return `<html><head>${base}</head><body>${reviews.join("")}<nav class="pagination">${pages.join("")}</nav>` +
    `${empty ? `<p>${escapeHtml(empty)}</p>` : ""}</body></html>`;
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
  if (isSearch && (
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
    if (
      redirected.protocol !== "https:" || redirected.hostname !== OZON_SOURCE_HOST || redirected.port ||
      redirected.username || redirected.password || redirected.hash ||
      !/^\/category\/[a-z0-9-]+(?:\/[a-z0-9-]+)?\/$/i.test(redirected.pathname)
    ) return false;
    if ([...redirected.searchParams.keys()].some((key) => !OZON_SEARCH_PARAMETERS.has(key))) return false;
    if ([...redirected.searchParams.keys()].some((key) => redirected.searchParams.getAll(key).length !== 1)) return false;
    return redirected.searchParams.get("text") === requested.source.searchParams.get("text") &&
      redirected.searchParams.get("from_global") === "true" &&
      (redirected.searchParams.get("page") ?? "1") === (requested.source.searchParams.get("page") ?? "1") &&
      redirected.searchParams.get("category_was_predicted") === "true" &&
      redirected.searchParams.get("deny_category_prediction") === "true" &&
      (!redirected.searchParams.has("brand_was_predicted") ||
        redirected.searchParams.get("brand_was_predicted") === "true");
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
  return `<html><head><base href="${escapeHtml(baseValue)}">` +
    `<script type="application/ld+json">${JSON.stringify(product).replace(/</g, "\\u003c")}</script></head><body>` +
    `<div id="state-webSingleProductScore-proof" data-state="${escapeHtml(scoreValue)}"></div>` +
    `<script>window.__NUXT__={};window.__NUXT__.state={}</script></body></html>`;
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
  const reviewTarget = new Set([
    "uteka.ru",
    "megapteka.ru",
    "otzovik.com",
    "pravogolosa.net"
  ]).has(host) || Boolean(irecommendTarget);
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
  const pharmacyTranslatedTarget = parsePharmacyTranslateTarget(target);
  let ozonTarget = false;
  if (target.hostname === "www.ozon.ru" && target.pathname === "/api/composer-api.bx/page/json/v2") {
    const nested = target.searchParams.get("url") ?? "";
    try {
      const search = new URL(nested, "https://www.ozon.ru");
      const page = search.searchParams.get("page") ?? "1";
      ozonTarget = search.origin === "https://www.ozon.ru" &&
        search.pathname === "/search/" &&
        (search.searchParams.get("text")?.trim().length ?? 0) > 0 &&
        (search.searchParams.get("text")?.trim().length ?? 0) <= 200 &&
        [...search.searchParams.keys()].every((key) => ["text", "from_global", "page"].includes(key)) &&
        /^\d+$/.test(page) && Number(page) >= 1 && Number(page) <= 100;
    } catch { /* invalid nested Ozon search URL */ }
  }
  if (target.protocol !== "https:" || !(reviewTarget || wildberriesTarget || yandexTarget || zdravcityTarget || ozonTarget || ozonTranslatedTarget || pharmacyTranslatedTarget)) {
    return json({ error: "Static review fetch destination is not allowed" }, 400);
  }
  if (pharmacyTranslatedTarget) {
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
      return json({ error: "Translated pharmacy response is not HTML" }, 502);
    }
    const compactHtml = compactPharmacyTranslateHtml(html, pharmacyTranslatedTarget);
    if (!compactHtml || compactHtml.length > 350_000) {
      return json({ error: "Translated pharmacy page did not prove the requested source and metrics" }, 502);
    }
    return new Response(compactHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-ratings-source": "google-translate-pharmacy-ssr",
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

    const reader = await safeFetch(readerProxyUrl(target).toString(), {
      method: "GET",
      redirect: "follow",
      headers: { accept: "text/plain; charset=utf-8", "x-return-format": "html", dnt: "1" }
    });
    const readerBody = await readTextBounded(reader, 12_000_000, 60_000);
    if (!reader.ok) return new Response(readerBody, { status: reader.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    const html = /^\s*(?:<!doctype\s+html|<html\b)/i.test(readerBody)
      ? readerBody
      : readerMarkdownToHtml(readerBody, target.toString());
    if (!validIrecommendProof(html, target, irecommendTarget)) {
      return json({ error: "iRecommend response did not prove the requested product or search result" }, 502);
    }
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-ratings-source": "reader-fallback" }
    });
  }
  if (host === "otzovik.com" && /^\/reviews\/[a-z0-9_]+\/?$/i.test(target.pathname)) {
    if (target.search || target.hash || target.hostname !== "otzovik.com") {
      return json({ error: "Invalid Otzovik product source URL" }, 400);
    }
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
      accept: wildberriesTarget || ozonTarget
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
  });
  const text = await readTextBounded(upstream, 12_000_000, 60_000);
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default async function onRequest(context: Context): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname === "/api/config") return json({
    domains: INITIAL_DOMAINS, brands: INITIAL_BRANDS,
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
      if (run.status !== "published") run = await reconcileBrowserPublication(repository, run);
      return json(pagedRun(run, url));
    }
    if (context.request.method === "POST" && publishMatch) {
      const run = await service.getRun(decodeURIComponent(publishMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const intent = await prepareBrowserPublication(repository, service, run);
      return json(pagedRun(intent.run, url), intent.shouldPublish ? 202 : 200);
    }
    if (context.request.method === "POST" && reviewMatch) {
      const run = await service.getRun(decodeURIComponent(reviewMatch[1]));
      if (!run) return json({ error: "Запуск не найден" }, 404);
      assertOwner(run, user);
      const body = await context.request.json() as { acceptedKeys?: string[] };
      return json(pagedRun(await service.approveObservations(run.id, body.acceptedKeys ?? []), url));
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
