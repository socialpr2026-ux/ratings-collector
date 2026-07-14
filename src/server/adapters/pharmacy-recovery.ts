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
  fallbackFetch: typeof fetch
): Promise<{ html: string; $: CheerioAPI }> {
  const endpoint = translatedUrl(source, translatedHost);
  let response: Response;
  try {
    response = await safeFetch(endpoint.toString(), { signal: context.signal, headers: { accept: "text/html,application/xhtml+xml" } }, context.fetch ?? fallbackFetch);
  } catch (error) {
    throw new AdapterBlockedError(`${normalizeHost(source.hostname)} translated request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, MAX_DOCUMENT_BYTES);
  if (!response.ok || blockPage(html)) {
    throw new AdapterBlockedError(`${normalizeHost(source.hostname)} translated request is blocked (HTTP ${response.status})`);
  }
  if (!/text\/html/i.test(response.headers.get("content-type") ?? "text/html")) {
    throw new ParserChangedError(`${normalizeHost(source.hostname)} translated request returned non-HTML data`);
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

function transliterate(value: string, tse = false): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: tse ? "ts" : "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value.toLocaleLowerCase("ru-RU").split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function brandSlugs(brand: string): string[] {
  return [...new Set(aliasesForBrand(brand).flatMap((alias) => [transliterate(alias), transliterate(alias, true)]).filter(Boolean))];
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
          url: parsed.canonicalUrl, title: brand,
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
    const aggregate = root.find("[itemprop='aggregateRating']").first();
    const reviews = exactInteger(aggregate.find("meta[itemprop='reviewCount']").first().attr("content"));
    const rating = exactRating(aggregate.find("meta[itemprop='ratingValue']").first().attr("content"));
    if (root.length !== 1 || reviews === undefined || reviews > 0 && rating === undefined) {
      throw new ParserChangedError(`polza.ru:${ref.listingId}: product aggregate is incomplete`);
    }
    return observation("polza.ru", ref, {
      listingId: parsedRef.listingId,
      canonicalUrl: parsedRef.canonicalUrl,
      reviews,
      rating: reviews === 0 ? null : rating!
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
      const { $ } = await translatedPage(source, "www-asna-ru.translate.goog", context, this.fetchImpl);
      if (!asnaProduct($)) throw new ParserChangedError("asna.ru canary has no exact aggregate product");
      return { ok: true, checkedAt, message: "asna.ru: fixed translated product canary is healthy" };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = new Map(previousRefs("asna.ru", brand, context, (value) => asnaRef(value)).map((ref) => [ref.listingId, ref]));
    const slugs = brandSlugs(brand);
    const maps = await Promise.all([
      sitemap("https://www.asna.ru/sitemap/sitemap_cards.xml", context, this.fetchImpl),
      sitemap("https://www.asna.ru/sitemap/sitemap_cards1.xml", context, this.fetchImpl)
    ]);
    for (const xml of maps) {
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        let url: URL;
        try { url = new URL(match[1].replace(/&amp;/gi, "&")); }
        catch { continue; }
        const slug = url.pathname.match(/^\/cards\/([a-z0-9_.-]+)\.html$/i)?.[1];
        if (!slug || !slugMatches(slug, slugs)) continue;
        const preliminary = asnaRef(url);
        if (!preliminary) continue;
        const { $ } = await translatedPage(new URL(preliminary.canonicalUrl), "www-asna-ru.translate.goog", context, this.fetchImpl);
        const parsed = asnaProduct($);
        if (!parsed || parsed.canonicalUrl !== preliminary.canonicalUrl) continue;
        refs.set(parsed.listingId, {
          domain: "asna.ru", platform: "asna.ru", listingId: parsed.listingId, brand,
          url: parsed.canonicalUrl, title: asnaTitle(parsed.canonicalUrl, brand, slugs),
          metadata: { discovery: "asna-card-sitemap", reviewCount: parsed.reviews, rating: parsed.rating }
        });
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
    const { html, $ } = await translatedPage(new URL(parsedRef.canonicalUrl), "www-asna-ru.translate.goog", context, this.fetchImpl);
    const parsed = asnaProduct($);
    if (!parsed || parsed.listingId !== ref.listingId || parsed.canonicalUrl !== parsedRef.canonicalUrl) {
      throw new ParserChangedError(`asna.ru:${ref.listingId}: product identity or aggregate changed`);
    }
    return observation("asna.ru", ref, parsed, html, this.evidence, capturedAt, "asna-product-microdata:google-translate");
  }
}
