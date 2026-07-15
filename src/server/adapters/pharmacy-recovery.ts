import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { aliasesForBrand } from "../utils/normalize.js";
import { titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const MAX_DOCUMENT_BYTES = 12_000_000;
const TRANSLATE_PARAMETERS = { _x_tr_sl: "ru", _x_tr_tl: "en", _x_tr_hl: "en" } as const;
const BLOCK_MARKERS = /captcha|access denied|forbidden|доступ (?:ограничен|запрещен)|проверка браузера|слишком много запросов/i;

type PharmacyDomain = "polza.ru" | "asna.ru";

type ParsedProduct = {
  listingId: string;
  canonicalUrl: string;
  reviews: number;
  rating: number | null;
};

function normalizeHost(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./, "");
}

function sameSource(left: URL, right: URL): boolean {
  if (left.protocol !== "https:" || right.protocol !== "https:") return false;
  if (normalizeHost(left.hostname) !== normalizeHost(right.hostname) || left.pathname !== right.pathname) return false;
  const leftParams = [...left.searchParams.entries()].sort();
  const rightParams = [...right.searchParams.entries()].sort();
  return JSON.stringify(leftParams) === JSON.stringify(rightParams);
}

function translatedUrl(source: URL, translatedHost: string): URL {
  const result = new URL(`${source.pathname}${source.search}`, `https://${translatedHost}`);
  for (const [key, value] of Object.entries(TRANSLATE_PARAMETERS)) result.searchParams.set(key, value);
  return result;
}

function translateLauncherUrl(source: URL): URL {
  const result = new URL("https://translate.google.com/website");
  result.searchParams.set("sl", "ru");
  result.searchParams.set("tl", "en");
  result.searchParams.set("hl", "en");
  result.searchParams.set("u", source.toString());
  return result;
}

function exactTranslatedFinal(value: string, source: URL, translatedHost: string): boolean {
  try {
    const final = new URL(value);
    if (final.protocol !== "https:" || final.hostname !== translatedHost || final.port || final.username || final.password || final.hash) {
      return false;
    }
    if (final.pathname !== source.pathname) return false;
    const sourceEntries = [...source.searchParams.entries()].sort();
    const finalSourceEntries = [...final.searchParams.entries()]
      .filter(([key]) => !(key in TRANSLATE_PARAMETERS) && key !== "_x_tr_sch")
      .sort();
    return JSON.stringify(sourceEntries) === JSON.stringify(finalSourceEntries) &&
      final.searchParams.get("_x_tr_sl") === "ru" && final.searchParams.get("_x_tr_tl") === "en";
  } catch {
    return false;
  }
}

function assertTranslatedSource(html: string, source: URL): CheerioAPI {
  const $ = load(html);
  const base = $("base[href]").first().attr("href");
  const proof = $("[data-source-url]").first().attr("data-source-url");
  let baseUrl: URL;
  let proofUrl: URL;
  try {
    baseUrl = new URL(base ?? "");
    proofUrl = new URL(proof ?? "");
  } catch {
    throw new ParserChangedError(`Translated ${source.hostname} page has no valid source proof`);
  }
  if (!sameSource(baseUrl, source) || !sameSource(proofUrl, source)) {
    throw new ParserChangedError(`Translated ${source.hostname} page returned a different source URL`);
  }
  return $;
}

function exactInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\s\u00a0]/g, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function exactRating(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!/^\d(?:\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

function blockPage(html: string): boolean {
  const $ = load(html);
  const title = $("title").text().replace(/\s+/g, " ").trim();
  const hasAggregate = /itemprop=["']reviewCount["']/i.test(html) || /"reviewCount"\s*:/i.test(html);
  return BLOCK_MARKERS.test(title) && !hasAggregate;
}

async function translatedPage(
  source: URL,
  translatedHost: string,
  context: AdapterContext,
  fallbackFetch: typeof fetch,
  allowLauncherFallback = false
): Promise<{ html: string; $: CheerioAPI }> {
  const endpoint = translatedUrl(source, translatedHost);
  let response: Response;
  try {
    response = await safeFetch(endpoint.toString(), { signal: context.signal, headers: { accept: "text/html,application/xhtml+xml" } }, context.fetch ?? fallbackFetch);
  } catch (error) {
    if (allowLauncherFallback) {
      return translatedPageViaLauncher(source, translatedHost, context, fallbackFetch);
    }
    throw new AdapterBlockedError(`${normalizeHost(source.hostname)} translated request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, MAX_DOCUMENT_BYTES);
  if (!response.ok || blockPage(html)) {
    if (allowLauncherFallback && [403, 408, 425, 429, 498, 502, 503, 504].includes(response.status)) {
      return translatedPageViaLauncher(source, translatedHost, context, fallbackFetch);
    }
    throw new AdapterBlockedError(`${normalizeHost(source.hostname)} translated request is blocked (HTTP ${response.status})`);
  }
  if (!/text\/html/i.test(response.headers.get("content-type") ?? "text/html")) {
    throw new ParserChangedError(`${normalizeHost(source.hostname)} translated request returned non-HTML data`);
  }
  return { html, $: assertTranslatedSource(html, source) };
}

async function translatedPageViaLauncher(
  source: URL,
  translatedHost: string,
  context: AdapterContext,
  fallbackFetch: typeof fetch
): Promise<{ html: string; $: CheerioAPI }> {
  // The fixed Function route is preferred. This second path is used only when
  // that route is transiently unavailable or for the bounded ASNA family page
  // that the Function intentionally does not expose. Google controls the only
  // redirect, and the final renderer URL plus both in-document source proofs
  // must bind back to the exact requested first-party URL.
  let response: Response;
  try {
    response = await (context.fetch ?? fallbackFetch)(translateLauncherUrl(source), {
      signal: context.signal,
      redirect: "follow",
      headers: { accept: "text/html,application/xhtml+xml" }
    });
  } catch (error) {
    throw new AdapterBlockedError(`${normalizeHost(source.hostname)} translated launcher failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const finalUrl = response.headers.get("x-ratings-final-url") ?? response.url;
  const html = await readTextBounded(response, MAX_DOCUMENT_BYTES);
  if (!response.ok || blockPage(html)) {
    throw new AdapterBlockedError(`${normalizeHost(source.hostname)} translated launcher is blocked (HTTP ${response.status})`);
  }
  if (!exactTranslatedFinal(finalUrl, source, translatedHost)) {
    throw new ParserChangedError(`Translated ${source.hostname} launcher returned an unbound final URL`);
  }
  if (!/text\/html/i.test(response.headers.get("content-type") ?? "text/html")) {
    throw new ParserChangedError(`${normalizeHost(source.hostname)} translated launcher returned non-HTML data`);
  }
  return { html, $: assertTranslatedSource(html, source) };
}

async function sitemap(url: string, context: AdapterContext, fallbackFetch: typeof fetch, maximumBytes = MAX_DOCUMENT_BYTES): Promise<string> {
  let response: Response;
  try {
    response = await safeFetch(url, { signal: context.signal, headers: { accept: "application/xml,text/xml" } }, context.fetch ?? fallbackFetch);
  } catch (error) {
    throw new AdapterBlockedError(`${new URL(url).hostname} sitemap request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await readTextBounded(response, maximumBytes);
  if (!response.ok || !/<(?:urlset|sitemapindex)\b/i.test(body)) {
    throw new AdapterBlockedError(`${new URL(url).hostname} sitemap is unavailable (HTTP ${response.status})`);
  }
  return body;
}

function transliterate(value: string, tse = false, kha: "h" | "kh" | "x" = "h"): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: kha, ц: tse ? "ts" : "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value.toLocaleLowerCase("ru-RU").split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function brandSlugs(brand: string): string[] {
  return [...new Set(aliasesForBrand(brand).flatMap((alias) =>
    (["h", "kh", "x"] as const).flatMap((kha) => [transliterate(alias, false, kha), transliterate(alias, true, kha)])
  ).filter(Boolean))];
}

function slugMatches(pathSlug: string, slugs: readonly string[]): boolean {
  return slugs.some((slug) => pathSlug === slug || new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-_]`).test(pathSlug));
}

function previousRefs(
  domain: PharmacyDomain,
  brand: string,
  context: AdapterContext,
  parseUrl: (value: string | URL) => { listingId: string; canonicalUrl: string } | undefined
): ProductRef[] {
  const refs = new Map<string, ProductRef>();
  for (const previous of context.previousRefs ?? []) {
    const parsed = parseUrl(previous.url);
    if (!parsed) continue;
    refs.set(parsed.listingId, {
      domain, platform: domain, listingId: parsed.listingId, brand, url: parsed.canonicalUrl,
      metadata: { discovery: "registry" }
    });
  }
  return [...refs.values()];
}

function observation(
  domain: PharmacyDomain,
  ref: ProductRef,
  parsed: ParsedProduct,
  html: string,
  evidence: EvidenceStore,
  capturedAt: string,
  source: string
): Promise<Observation> {
  const product = ref.title?.trim() || ref.brand;
  const productEvidence = titleProductEvidence(product, { type: "product_id", value: parsed.listingId }, parsed.canonicalUrl);
  return evidence.put({
    capturedAt,
    url: parsed.canonicalUrl,
    status: 200,
    bodyDigest: createHash("sha256").update(html).digest("hex"),
    parsed,
    productEvidence,
    source
  }).then((evidenceRef) => ({
    domain,
    platform: domain,
    listingId: parsed.listingId,
    brand: ref.brand,
    canonicalUrl: parsed.canonicalUrl,
    // The fixed renderer can replace source Cyrillic with question marks.
    // The canonical product slug is retained and the shared product-name
    // analyzer converts it into the human form/dose/pack label.
    product,
    reviews: parsed.reviews,
    rating: parsed.reviews === 0 ? null : parsed.rating,
    rawRating: parsed.rating,
    rawRatingScale: 5,
    ratingCount: null,
    status: parsed.reviews === 0 ? "no_reviews" : "ok",
    capturedAt,
    evidenceRef,
    productEvidence,
    source
  }));
}

function polzaRef(value: string | URL): { listingId: string; canonicalUrl: string } | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || normalizeHost(url.hostname) !== "polza.ru") return undefined;
    const match = url.pathname.match(/^\/catalog\/[a-z0-9-]+_(\d+)\/?$/i);
    if (!match) return undefined;
    return { listingId: match[1], canonicalUrl: `https://polza.ru${url.pathname.replace(/\/?$/, "/")}` };
  } catch {
    return undefined;
  }
}

// Polza product titles are recovered from canonical first-party slugs when the
// translated family page does not expose a reliable Cyrillic name.  Translate
// only this bounded pharmacy vocabulary: an arbitrary Latin token must remain
// visible and therefore cannot accidentally prove a dosage form.
const POLZA_PRODUCT_SLUG_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  granuly: "гранулы",
  gomeopaticheskie: "гомеопатические",
  tabletki: "таблетки",
  kapsuly: "капсулы",
  poroshok: "порошок",
  maz: "мазь",
  gel: "гель",
  krem: "крем",
  rastvor: "раствор",
  sirop: "сироп",
  sprei: "спрей",
  sprey: "спрей",
  kapli: "капли",
  suspenziya: "суспензия",
  suspenziia: "суспензия",
  suppozitorii: "суппозитории",
  liofilizat: "лиофилизат",
  ampuly: "ампулы",
  flakony: "флаконы",
  mg: "мг",
  ml: "мл",
  g: "г",
  sht: "шт.",
  doz: "доз"
});

function polzaProductTitle(canonicalUrl: string, brand: string): string {
  const slug = new URL(canonicalUrl).pathname.split("/").filter(Boolean).at(-1)?.replace(/_\d+$/, "") ?? "";
  const brandSlug = [...brandSlugs(brand)].sort((left, right) => right.length - left.length)
    .find((candidate) => slug === candidate || slug.startsWith(`${candidate}-`));
  const detail = (brandSlug ? slug.slice(brandSlug.length).replace(/^-+/, "") : slug)
    .split("-")
    .filter(Boolean)
    .map((token) => POLZA_PRODUCT_SLUG_TOKENS[token] ?? token)
    .join(" ");
  return `${brand}${detail ? ` ${detail}` : ""}`.replace(/\s+/g, " ").trim();
}

function polzaProduct($: CheerioAPI, expectedId?: string): ParsedProduct | undefined {
  const roots = expectedId
    ? $(`meta[itemprop='sku'][content='${expectedId}']`).closest("[itemscope]")
    : $(".catalog__block--cards .catalog-block__items > .catalog-card[itemscope]");
  let result: ParsedProduct | undefined;
  roots.each((_index, node) => {
    if (result) return;
    const root = $(node);
    const sku = exactInteger(root.find("meta[itemprop='sku']").first().attr("content"));
    const path = root.find("link[itemprop='url']").first().attr("href");
    const parsedRef = path ? polzaRef(new URL(path, "https://polza.ru")) : undefined;
    const listingId = sku === undefined ? undefined : String(sku);
    if (!listingId || expectedId && listingId !== expectedId) return;
    const canonicalUrl = parsedRef?.listingId === listingId
      ? parsedRef.canonicalUrl
      : expectedId ? undefined : undefined;
    if (!canonicalUrl && !expectedId) return;
    const aggregate = root.find("[itemprop='aggregateRating']").first();
    const reviews = exactInteger(aggregate.find("meta[itemprop='reviewCount']").first().attr("content"));
    const rating = exactRating(aggregate.find("meta[itemprop='ratingValue']").first().attr("content"));
    if (reviews === undefined || reviews > 0 && rating === undefined) return;
    result = {
      listingId,
      canonicalUrl: canonicalUrl ?? "",
      reviews,
      rating: reviews === 0 ? null : rating!
    };
  });
  return result;
}

function polzaProductMetrics(
  root: ReturnType<CheerioAPI>,
  $: CheerioAPI
): Pick<ParsedProduct, "reviews" | "rating"> | undefined {
  const aggregate = root.find("[itemprop='aggregateRating']").first();
  const reviews = exactInteger(aggregate.find("meta[itemprop='reviewCount']").first().attr("content"));
  const rating = exactRating(aggregate.find("meta[itemprop='ratingValue']").first().attr("content"));
  if (reviews === undefined || reviews > 0 && rating === undefined) return undefined;
  if (reviews === 0) return { reviews: 0, rating: null };

  // Polza can leave a stale AggregateRating on a product that has no review
  // section at all. Accept a positive total only when the same product root
  // exposes the visible review block, its total and at least one review item.
  const reviewBlocks = $("#review_block");
  const reviewBlock = reviewBlocks.first();
  const reviewItems = reviewBlock.find(".reviews__item.review-item");
  const explicitEmpty = reviewBlocks.length === 1 && reviewBlock.find(
    ".reviews__empty, .reviews-empty, [data-empty-reviews]"
  ).length === 1 && /(?:отзывов\s+(?:пока\s+)?нет|нет\s+отзывов)/iu.test(reviewBlock.text());
  if (explicitEmpty) return { reviews: 0, rating: null };
  if (!reviewBlocks.length && !reviewItems.length) return undefined;
  if (reviewBlocks.length !== 1) return undefined;
  const visibleTotal = exactInteger(reviewBlock.find(".reviews__amount").first().text());
  if (visibleTotal !== reviews || reviewItems.length === 0) return undefined;
  return { reviews, rating: rating! };
}

export class PolzaAdapter implements SiteAdapter {
  readonly id = "polza.ru:translate-v1";
  readonly supportedDomains = ["polza.ru", "www.polza.ru"] as const;

  constructor(private readonly evidence: EvidenceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const source = new URL("https://polza.ru/product/kagocel/");
      const { $ } = await translatedPage(source, "polza-ru.translate.goog", context, this.fetchImpl);
      if (!polzaProduct($)) throw new ParserChangedError("polza.ru canary has no exact aggregate card");
      return { ok: true, checkedAt, message: "polza.ru: fixed translated family canary is healthy" };
    } catch (error) {
      // A transient renderer 5xx on the unrelated Kagocel canary must not
      // prevent collection of another requested family. Keep parser changes
      // fail-closed, but allow discovery to proceed when the current official
      // sitemap still proves the exact canary family route. discover() and
      // collect() then source-bind and validate every requested page/metric.
      if (error instanceof AdapterBlockedError) {
        try {
          const xml = await sitemap("https://polza.ru/sitemap-iblock-33.xml", context, this.fetchImpl);
          const hasCanary = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].some((match) => {
            try {
              const url = new URL(match[1].replace(/&amp;/gi, "&"));
              return url.protocol === "https:" && normalizeHost(url.hostname) === "polza.ru" &&
                url.pathname === "/product/kagocel/" && !url.search && !url.hash;
            } catch {
              return false;
            }
          });
          if (hasCanary) {
            return {
              ok: true,
              checkedAt,
              message: "polza.ru: current sitemap canary is healthy; requested family metrics remain strictly verified"
            };
          }
        } catch {
          // Preserve the original renderer failure below. Neither an invalid
          // nor an unavailable sitemap is sufficient proof of health.
        }
      }
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map(previousRefs("polza.ru", brand, context, polzaRef).map((ref) => [ref.listingId, ref]));
    const slugs = brandSlugs(brand);
    const xml = await sitemap("https://polza.ru/sitemap-iblock-33.xml", context, this.fetchImpl);
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => match[1].replace(/&amp;/gi, "&"));
    const familyUrls = locations.flatMap((location) => {
      try {
        const url = new URL(location);
        const slug = url.pathname.match(/^\/product\/([a-z0-9-]+)\/?$/i)?.[1];
        return normalizeHost(url.hostname) === "polza.ru" && slug && slugMatches(slug, slugs) ? [url] : [];
      } catch { return []; }
    });
    if (familyUrls.length === 0) {
      throw new AdapterBlockedError(`polza.ru: current product sitemap has no provable family page for ${brand}`);
    }
    for (const familyUrl of familyUrls) {
      const { $ } = await translatedPage(familyUrl, "polza-ru.translate.goog", context, this.fetchImpl);
      const roots = $(".catalog__block--cards .catalog-block__items > .catalog-card[itemscope]");
      roots.each((_index, node) => {
        const root = $(node);
        const path = root.find("link[itemprop='url']").first().attr("href");
        const parsed = path ? polzaRef(new URL(path, familyUrl)) : undefined;
        if (!parsed) return;
        const productSlug = new URL(parsed.canonicalUrl).pathname.split("/").filter(Boolean)[1]?.replace(/_\d+$/, "") ?? "";
        if (!slugMatches(productSlug, slugs)) return;
        refs.set(parsed.listingId, {
          domain: "polza.ru", platform: "polza.ru", listingId: parsed.listingId, brand,
          url: parsed.canonicalUrl, title: polzaProductTitle(parsed.canonicalUrl, brand),
          metadata: { discovery: "polza-current-sitemap-family", familyUrl: familyUrl.toString() }
        });
      });
    }
    if (refs.size === 0) throw new ParserChangedError(`polza.ru: family page for ${brand} has no exact product cards`);
    return [...refs.values()].sort((left, right) => Number(left.listingId) - Number(right.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = polzaRef(ref.url);
    if (!parsedRef || parsedRef.listingId !== ref.listingId) throw new ParserChangedError(`polza.ru: invalid product ref ${ref.listingId}`);
    const capturedAt = new Date().toISOString();
    const { html, $ } = await translatedPage(new URL(parsedRef.canonicalUrl), "polza-ru.translate.goog", context, this.fetchImpl);
    const root = $(`meta[itemprop='sku'][content='${parsedRef.listingId}']`).closest("[itemscope]").first();
    const metrics = root.length === 1 ? polzaProductMetrics(root, $) : undefined;
    if (!metrics) {
      throw new ParserChangedError(`polza.ru:${ref.listingId}: product aggregate is incomplete`);
    }
    return observation("polza.ru", { ...ref, title: ref.title || polzaProductTitle(parsedRef.canonicalUrl, ref.brand) }, {
      listingId: parsedRef.listingId,
      canonicalUrl: parsedRef.canonicalUrl,
      reviews: metrics.reviews,
      rating: metrics.rating
    }, html, this.evidence, capturedAt, "polza-product-microdata:google-translate");
  }
}

function asnaRef(value: string | URL, listingId?: string): { listingId: string; canonicalUrl: string } | undefined {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "https:" || normalizeHost(url.hostname) !== "asna.ru" || !/^\/cards\/[a-z0-9_.-]+\.html$/i.test(url.pathname)) return undefined;
    const stableId = listingId ?? createHash("sha256").update(url.pathname).digest("hex").slice(0, 20);
    return { listingId: stableId, canonicalUrl: `https://www.asna.ru${url.pathname}` };
  } catch {
    return undefined;
  }
}

function asnaPreviousRefs(brand: string, context: AdapterContext): ProductRef[] {
  const refs = new Map<string, ProductRef>();
  for (const previous of context.previousRefs ?? []) {
    // Preserve historical-only URLs fail-closed, including legacy URL hashes.
    // A current sitemap card below replaces a legacy ID only after its exact
    // canonical URL and numeric SKU are proved from product microdata.
    if (!/^(?:\d+|[a-f0-9]{20})$/i.test(previous.listingId)) continue;
    const parsed = asnaRef(previous.url, previous.listingId);
    if (!parsed) continue;
    refs.set(parsed.listingId, {
      domain: "asna.ru",
      platform: "asna.ru",
      listingId: parsed.listingId,
      brand,
      url: parsed.canonicalUrl,
      metadata: { discovery: "registry" }
    });
  }
  return [...refs.values()];
}

function asnaTitle(url: string, brand: string, slugs: readonly string[]): string {
  const pathSlug = new URL(url).pathname.match(/^\/cards\/([a-z0-9_.-]+)\.html$/i)?.[1] ?? "";
  const brandSlug = [...slugs].sort((left, right) => right.length - left.length).find((slug) =>
    pathSlug === slug || pathSlug.startsWith(`${slug}_`)
  );
  const withoutBrand = brandSlug ? pathSlug.slice(brandSlug.length).replace(/^_+/, "") : pathSlug;
  const parts = withoutBrand.split("_").filter(Boolean);
  const granulesIndex = parts.findIndex((part) => /^granuly$/i.test(part));
  if (granulesIndex >= 0) {
    const dose = parts.slice(0, granulesIndex).join("_").match(/(?:^|_)(\d+(?:[.,]\d+)?)_doza(?:_|$)/i)?.[1];
    const count = parts.slice(0, granulesIndex).map((part) => part.match(/^n(\d+)$/i)?.[1]).find(Boolean);
    const homeopathic = /^gomeopaticheskie$/i.test(parts[granulesIndex + 1] ?? "");
    return [
      brand,
      homeopathic ? "гранулы гомеопатические" : "гранулы",
      dose ? `${dose.replace(".", ",")} доза` : undefined,
      count ? `№${count}` : undefined
    ].filter(Boolean).join(" ");
  }
  const formIndex = parts.findIndex((part) => /^(?:tab|tabl|kaps|por|poroshok|rastvor|sirop|sprey|maz|gel|supp|susp)$/i.test(part));
  const productParts = (formIndex >= 0 ? parts.slice(0, formIndex + 1) : parts.slice(0, 3)).map((part) => part
    .replace(/^(\d+(?:[.,]\d+)?)(mg|ml|g)$/i, (_full, value: string, unit: string) => `${value} ${unit.toLowerCase() === "mg" ? "мг" : unit.toLowerCase() === "ml" ? "мл" : "г"}`)
    .replace(/^n(\d+)$/i, "№$1")
    .replace(/^tabl?$/i, "таблетки")
    .replace(/^kaps$/i, "капсулы")
    .replace(/^(?:por|poroshok)$/i, "порошок")
    .replace(/^rastvor$/i, "раствор")
    .replace(/^sirop$/i, "сироп")
    .replace(/^sprey$/i, "спрей")
    .replace(/^maz$/i, "мазь")
    .replace(/^gel$/i, "гель")
    .replace(/^supp$/i, "суппозитории")
    .replace(/^susp$/i, "суспензия"));
  return `${brand} ${productParts.join(" ")}`.replace(/\s+/g, " ").trim();
}

function asnaProduct($: CheerioAPI): ParsedProduct | undefined {
  const root = $(".productPage__content.product__item[itemscope]").first();
  const listingId = root.find("meta[itemprop='sku']").first().attr("content");
  const canonical = $("link[rel='canonical']").first().attr("href");
  const parsedRef = canonical && listingId ? asnaRef(canonical, listingId) : undefined;
  const aggregate = root.find("[itemprop='aggregateRating']").first();
  const reviews = exactInteger(aggregate.find("meta[itemprop='reviewCount']").first().attr("content"));
  const rating = exactRating(aggregate.find("meta[itemprop='ratingValue']").first().attr("content"));
  if (!parsedRef || reviews === undefined || reviews > 0 && rating === undefined) return undefined;
  if (reviews > 0) {
    // ASNA also publishes stale positive microdata for some products while the
    // visible feedback area contains only the "leave a review" form. A real
    // positive total is accepted only with a source-bound list and review item.
    const feedbackList = root.find("#feedbackListContainer.product__feedbackList").first();
    const feedbackItems = feedbackList.find(".product__feedbackItem[itemtype*='Review']");
    const explicitEmpty = feedbackList.length === 1 && feedbackList.find(
      ".product__feedbackEmpty, .product__feedback-empty, [data-empty-reviews]"
    ).length === 1 && /(?:отзывов\s+(?:пока\s+)?нет|нет\s+отзывов)/iu.test(feedbackList.text());
    if (explicitEmpty) return { ...parsedRef, reviews: 0, rating: null };
    if (!feedbackList.length && !feedbackItems.length) return undefined;
    const visibleTotal = exactInteger(root.find(".product__ratingText").first().text().match(/\((\d[\d\s\u00a0]*)\)/)?.[1]);
    if (visibleTotal !== reviews || feedbackItems.length === 0) return undefined;
  }
  return { ...parsedRef, reviews, rating: reviews === 0 ? null : rating! };
}

export class AsnaAdapter implements SiteAdapter {
  readonly id = "asna.ru:translate-v1";
  readonly supportedDomains = ["asna.ru", "www.asna.ru"] as const;

  constructor(private readonly evidence: EvidenceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const source = new URL("https://www.asna.ru/cards/kagotsel_12mg_n10_tab_niarmedik_plyus_ooo.html");
      const { $ } = await translatedPage(source, "www-asna-ru.translate.goog", context, this.fetchImpl, true);
      if (!asnaProduct($)) throw new ParserChangedError("asna.ru canary has no exact aggregate product");
      return { ok: true, checkedAt, message: "asna.ru: fixed translated product canary is healthy" };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map(asnaPreviousRefs(brand, context).map((ref) => [ref.listingId, ref]));
    const slugs = brandSlugs(brand);
    const maps = await Promise.allSettled([
      sitemap("https://www.asna.ru/sitemap/sitemap_cards.xml", context, this.fetchImpl),
      sitemap("https://www.asna.ru/sitemap/sitemap_cards1.xml", context, this.fetchImpl)
    ]);
    const candidates = new Map<string, { listingId: string; canonicalUrl: string; discovery: string }>();
    for (const map of maps) {
      if (map.status !== "fulfilled") continue;
      const xml = map.value;
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        let url: URL;
        try { url = new URL(match[1].replace(/&amp;/gi, "&")); }
        catch { continue; }
        const slug = url.pathname.match(/^\/cards\/([a-z0-9_.-]+)\.html$/i)?.[1];
        if (!slug || !slugMatches(slug, slugs)) continue;
        const preliminary = asnaRef(url);
        if (!preliminary) continue;
        candidates.set(preliminary.canonicalUrl, { ...preliminary, discovery: "asna-card-sitemap" });
      }
    }
    // ASNA's current card sitemaps can omit an otherwise live medicine family.
    // Its exact `/product/<brand>/` page is a source-bound first-party listing,
    // so use it only to discover card URLs; every card aggregate is still
    // fetched and verified independently below.
    for (const slug of slugs) {
      const family = new URL(`https://www.asna.ru/product/${slug}/`);
      let $: CheerioAPI;
      try {
        ({ $ } = await translatedPageViaLauncher(family, "www-asna-ru.translate.goog", context, this.fetchImpl));
      } catch (error) {
        if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) continue;
        throw error;
      }
      $("a[href*='/cards/']").each((_index, node) => {
        const href = $(node).attr("href");
        if (!href) return;
        let translated: URL;
        try { translated = new URL(href, `https://www-asna-ru.translate.goog/`); }
        catch { return; }
        if (!["www-asna-ru.translate.goog", "www.asna.ru"].includes(translated.hostname)) return;
        const preliminary = asnaRef(`https://www.asna.ru${translated.pathname}`);
        const cardSlug = translated.pathname.match(/^\/cards\/([a-z0-9_.-]+)\.html$/i)?.[1];
        if (!preliminary || !cardSlug || !slugMatches(cardSlug, slugs)) return;
        candidates.set(preliminary.canonicalUrl, { ...preliminary, discovery: "asna-product-family" });
      });
    }
    for (const preliminary of candidates.values()) {
      try {
        const { $ } = await translatedPage(new URL(preliminary.canonicalUrl), "www-asna-ru.translate.goog", context, this.fetchImpl, true);
        const parsed = asnaProduct($);
        if (!parsed || parsed.canonicalUrl !== preliminary.canonicalUrl) continue;
        for (const [existingId, existing] of refs) {
          if (existingId !== parsed.listingId && existing.url === parsed.canonicalUrl) refs.delete(existingId);
        }
        refs.set(parsed.listingId, {
          domain: "asna.ru", platform: "asna.ru", listingId: parsed.listingId, brand,
          url: parsed.canonicalUrl, title: asnaTitle(parsed.canonicalUrl, brand, slugs),
          metadata: { discovery: preliminary.discovery, reviewCount: parsed.reviews, rating: parsed.rating }
        });
      } catch (error) {
        if (error instanceof AdapterBlockedError || error instanceof ParserChangedError) continue;
        throw error;
      }
    }
    if (refs.size === 0) {
      throw new AdapterBlockedError(`asna.ru: card sitemaps have no provable current product for ${brand}`);
    }
    return [...refs.values()].sort((left, right) => left.listingId.localeCompare(right.listingId));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = asnaRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`asna.ru: invalid product ref ${ref.listingId}`);
    const capturedAt = new Date().toISOString();
    const { html, $ } = await translatedPage(new URL(parsedRef.canonicalUrl), "www-asna-ru.translate.goog", context, this.fetchImpl, true);
    const parsed = asnaProduct($);
    if (!parsed || parsed.listingId !== ref.listingId || parsed.canonicalUrl !== parsedRef.canonicalUrl) {
      throw new ParserChangedError(`asna.ru:${ref.listingId}: product identity or aggregate changed`);
    }
    return observation("asna.ru", ref, parsed, html, this.evidence, capturedAt, "asna-product-microdata:google-translate");
  }
}
