import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductEvidence, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { extractPageProductEvidence, titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";
import { canonicalProductDescriptor } from "../utils/product-name.js";

const MAX_HTML_BYTES = 12_000_000;
const TRANSLATE_PARAMETERS = { _x_tr_sl: "ru", _x_tr_tl: "en", _x_tr_hl: "en" } as const;
const BLOCK_MARKERS = /captcha|access denied|forbidden|доступ (?:ограничен|запрещен)|проверка браузера|can't reach this website|enable javascript/i;

type HtmlPage = { html: string; $: CheerioAPI; requestedUrl: string; status: number };

function compactText(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function host(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./, "");
}

function sameSource(left: URL, right: URL): boolean {
  if (left.protocol !== "https:" || right.protocol !== "https:") return false;
  if (host(left.hostname) !== host(right.hostname) || left.pathname !== right.pathname) return false;
  return JSON.stringify([...left.searchParams.entries()].sort()) === JSON.stringify([...right.searchParams.entries()].sort());
}

function sameSourcePage(left: URL, right: URL): boolean {
  return left.protocol === "https:" && right.protocol === "https:" &&
    host(left.hostname) === host(right.hostname) && left.pathname === right.pathname;
}

function translatedUrl(source: URL, translatedHost: string): URL {
  const result = new URL(`${source.pathname}${source.search}`, `https://${translatedHost}`);
  for (const [key, value] of Object.entries(TRANSLATE_PARAMETERS)) result.searchParams.set(key, value);
  return result;
}

function assertTranslatedSource($: CheerioAPI, source: URL): void {
  const proofs = [
    $("[data-source-url]").first().attr("data-source-url"),
    $("base[href]").first().attr("href")
  ].filter((value): value is string => Boolean(value));
  const proven = proofs.some((value) => {
    try { return sameSource(new URL(value, source), source); }
    catch { return false; }
  });
  // Google Translate now emits a first-party canonical URL plus a relative
  // base instead of repeating the full requested URL. The canonical proves
  // the exact source host and path; adapters must still bind query-specific
  // state (for example eTabl's searchQuery) before accepting any product.
  const canonical = $("link[rel='canonical']").first().attr("href");
  const canonicalProven = canonical ? (() => {
    try { return sameSourcePage(new URL(canonical, source), source); }
    catch { return false; }
  })() : false;
  if (!proven && !canonicalProven) {
    throw new ParserChangedError(`${host(source.hostname)}: translated page returned another source URL`);
  }
}

async function requestPage(
  source: URL,
  context: AdapterContext,
  fallbackFetch: typeof fetch,
  translatedHost?: string
): Promise<HtmlPage> {
  const endpoint = translatedHost ? translatedUrl(source, translatedHost) : source;
  let response: Response;
  try {
    response = await safeFetch(endpoint.toString(), {
      signal: context.signal,
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ru-RU,ru;q=0.9,en;q=0.7" }
    }, context.fetch ?? fallbackFetch, 4, 60_000);
  } catch (error) {
    throw new AdapterBlockedError(`${host(source.hostname)}: request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, MAX_HTML_BYTES, 60_000).catch((error) => {
    throw new AdapterBlockedError(`${host(source.hostname)}: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
  });
  const $ = load(html);
  const title = compactText($("title").first().text());
  if (!response.ok || BLOCK_MARKERS.test(title)) {
    throw new AdapterBlockedError(`${host(source.hostname)}: free first-party page is unavailable (HTTP ${response.status})`);
  }
  if (translatedHost) assertTranslatedSource($, source);
  return { html, $, requestedUrl: endpoint.toString(), status: response.status };
}

function exactInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\s\u00a0\u202f]/g, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function exactRating(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = String(value).replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!/^\d(?:\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

function sourceHref(value: string | undefined, domain: string): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, `https://${domain}/`);
    if (parsed.protocol !== "https:") return undefined;
    const source = new URL(`https://${domain}${parsed.pathname}${parsed.search}`);
    for (const key of Object.keys(TRANSLATE_PARAMETERS)) source.searchParams.delete(key);
    return source;
  } catch {
    return undefined;
  }
}

function transliterate(value: string, useTs = false, kha: "h" | "kh" | "x" = "h"): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: kha, ц: useTs ? "ts" : "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value.toLocaleLowerCase("ru-RU").split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function transliteratedSlugs(value: string): string[] {
  return [...new Set((["h", "kh", "x"] as const).flatMap((kha) =>
    [transliterate(value, false, kha), transliterate(value, true, kha)]
  ).filter(Boolean))];
}

function historicalRefs(
  domain: string,
  brand: string,
  context: AdapterContext,
  parse: (url: string, listingId?: string) => { id: string; url: string } | undefined
): Map<string, ProductRef> {
  const refs = new Map<string, ProductRef>();
  for (const previous of context.previousRefs ?? []) {
    const parsed = parse(previous.url, previous.listingId);
    if (!parsed || parsed.id !== previous.listingId) continue;
    refs.set(parsed.id, {
      domain, platform: domain, listingId: parsed.id, brand, url: parsed.url,
      metadata: { discovery: "historical-registry" }
    });
  }
  return refs;
}

async function observation(
  evidence: EvidenceStore,
  ref: ProductRef,
  page: HtmlPage,
  input: {
    domain: string; title: string; canonicalUrl: string; reviews: number; rating: number | null;
    ratingCount?: number | null; source: string; productEvidence?: ProductEvidence; aggregateGroupId?: string;
  }
): Promise<Observation> {
  const capturedAt = new Date().toISOString();
  const productEvidence = input.productEvidence ?? titleProductEvidence(input.title, { type: "product_id", value: ref.listingId }, input.canonicalUrl);
  const parsed = {
    listingId: ref.listingId,
    title: input.title,
    canonicalUrl: input.canonicalUrl,
    writtenReviewCount: input.reviews,
    ratingCount: input.ratingCount ?? null,
    rating: input.rating
  };
  const evidenceRef = await evidence.put({
    capturedAt,
    url: page.requestedUrl,
    status: page.status,
    bodyDigest: createHash("sha256").update(page.html).digest("hex"),
    parsed,
    productEvidence,
    source: input.source
  });
  const feedbackCount = Math.max(input.reviews, input.ratingCount ?? 0);
  return {
    domain: input.domain,
    platform: input.domain,
    listingId: ref.listingId,
    brand: ref.brand,
    canonicalUrl: input.canonicalUrl,
    product: input.title,
    reviews: feedbackCount,
    writtenReviewCount: input.ratingCount !== undefined && input.ratingCount !== null ? input.reviews : undefined,
    rating: feedbackCount === 0 ? null : input.rating,
    rawRating: input.rating,
    rawRatingScale: 5,
    ratingCount: input.ratingCount,
    status: feedbackCount === 0 ? "no_reviews" : "ok",
    capturedAt,
    evidenceRef,
    aggregateGroupId: input.aggregateGroupId,
    productEvidence,
    source: input.source
  };
}

abstract class AdditionalPharmacyAdapter implements SiteAdapter {
  abstract readonly id: string;
  abstract readonly supportedDomains: readonly string[];
  abstract healthCheck(context: AdapterContext): Promise<AdapterHealth>;
  abstract discover(brand: string, context: AdapterContext): Promise<ProductRef[]>;
  abstract collect(ref: ProductRef, context: AdapterContext): Promise<Observation>;

  constructor(protected readonly evidence: EvidenceStore, protected readonly fetchImpl: typeof fetch = fetch) {}

  protected async canary(brand: string, context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const refs = await this.discover(brand, { ...context, previousIds: [], previousRefs: [] });
      return refs.length
        ? { ok: true, checkedAt, message: `${this.id}: ${refs.length} control product(s) found` }
        : { ok: false, checkedAt, message: `${this.id}: control brand returned no products` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

const APTEKA_DOMAIN = "apteka.ru";
const APTEKA_TRANSLATE_HOST = "apteka-ru.translate.goog";
const APTEKA_PRODUCT = /^\/product\/([a-z0-9-]+-([a-f0-9]{24}))\/?$/i;
const APTEKA_PREPARATION_SLUG_ALIASES: Record<string, readonly string[]> = {
  "кагоцел": ["kagoczel"]
};
const APTEKA_BOUNDED_EXACT_PRODUCTS: Record<string, ReadonlyArray<{ id: string; url: string; title: string }>> = {
  "энтеролактис": [
    {
      id: "6061c3333312949196ec943d",
      url: "https://apteka.ru/product/enterolaktis-plyus-15-sht-kapsuly-massoj-319-mg-6061c3333312949196ec943d/",
      title: "Энтеролактис плюс 15 шт. капсулы массой 319 мг"
    },
    {
      id: "6267ea3630197ea53c0caa2c",
      url: "https://apteka.ru/product/enterolaktis-duo-20-sht-sashe-po-5-g-6267ea3630197ea53c0caa2c/",
      title: "Энтеролактис дуо 20 шт. саше по 5 г"
    },
    {
      id: "611b9cdd492c4ced7420a4a6",
      url: "https://apteka.ru/product/enterolaktis-fibra-10-ml-12-sht-flakon-sirop-i-kapsula-s-poroshkom-v-kryshkax-flakonov-611b9cdd492c4ced7420a4a6/",
      title: "Энтеролактис фибра 10 мл 12 шт. флакон сироп"
    }
  ]
};

function aptekaPreparationSlugs(brand: string): string[] {
  return [...new Set([
    ...transliteratedSlugs(brand),
    ...(APTEKA_PREPARATION_SLUG_ALIASES[normalizeText(brand)] ?? [])
  ])];
}

function aptekaRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value, `https://${APTEKA_DOMAIN}/`);
    if (url.protocol !== "https:" || host(url.hostname) !== APTEKA_DOMAIN) return undefined;
    const match = url.pathname.match(APTEKA_PRODUCT);
    if (!match || expectedId && match[2] !== expectedId) return undefined;
    return { id: match[2], url: `https://${APTEKA_DOMAIN}/product/${match[1]}/` };
  } catch { return undefined; }
}

function jsonLdProducts($: CheerioAPI): Array<Record<string, unknown>> {
  const products: Array<Record<string, unknown>> = [];
  $("script[type='application/ld+json']").each((_index, node) => {
    try {
      const value = JSON.parse($(node).html() ?? "null") as unknown;
      const queue = Array.isArray(value) ? [...value] : [value];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record["@type"] === "Product") products.push(record);
        const graph = record["@graph"];
        if (Array.isArray(graph)) queue.push(...graph);
      }
    } catch { /* unrelated invalid JSON-LD is ignored */ }
  });
  return products;
}

function aptekaVisibleFeedback(
  $: CheerioAPI,
  expectedUrl: string,
  expectedTitle: string
): { count: number; rating: number } | undefined {
  const expectedPath = new URL(expectedUrl).pathname;
  // Apteka.ru intermittently omits `aria-selected` from its SSR variants.
  // The exact product link and title still bind the visible rating to one
  // concrete variant, so recover only that unique, source-bound card.
  const candidates = $(".variantButton, .variantButtonExp").filter((_index, element) => {
    const link = $(element).find(
      "a.variantButton__link[href][aria-label], a.variantButtonExp__link[href][aria-label]"
    ).first();
    const source = sourceHref(link.attr("href"), APTEKA_DOMAIN);
    const title = compactText(link.attr("aria-label") ?? "");
    return source?.pathname === expectedPath && normalizeText(title) === normalizeText(expectedTitle);
  });
  if (candidates.length !== 1) return undefined;
  const selected = candidates.first();
  const link = selected.find(
    "a.variantButton__link[href][aria-label], a.variantButtonExp__link[href][aria-label]"
  ).first();
  const source = sourceHref(link.attr("href"), APTEKA_DOMAIN);
  const title = compactText(link.attr("aria-label") ?? "");
  if (!source || source.pathname !== expectedPath || normalizeText(title) !== normalizeText(expectedTitle)) {
    return undefined;
  }
  const metric = selected.find(".variantButton__rating .ItemRating, .variantButtonExp__rating .ItemRating");
  if (metric.length !== 1) return undefined;
  const count = exactInteger(metric.find(".caption3 span").first().text());
  const rating = exactRating(metric.find(".ItemRating__label").first().text());
  return count === undefined || rating === undefined ? undefined : { count, rating };
}

function aptekaExactOfferProof(product: Record<string, unknown>, expectedUrl: string, expectedTitle: string): boolean {
  const offers = Array.isArray(product.offers) ? product.offers : product.offers ? [product.offers] : [];
  const expectedPath = new URL(expectedUrl).pathname;
  const matches = offers.filter((offer) => {
    if (!offer || typeof offer !== "object") return false;
    const record = offer as Record<string, unknown>;
    const source = sourceHref(typeof record.url === "string" ? record.url : undefined, APTEKA_DOMAIN);
    return source?.pathname === expectedPath && normalizeText(String(record.name ?? "")) === normalizeText(expectedTitle);
  });
  return matches.length === 1;
}

function aptekaStateRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function aptekaAssignedProductState($: CheerioAPI): Record<string, unknown> | undefined {
  const scripts = $("script").toArray().map((node) => $(node).html() ?? "").filter((script) =>
    /^\s*window\.__INITIAL_STATE__\s*=\s*/.test(script)
  );
  if (scripts.length !== 1) return undefined;
  const prefix = scripts[0].match(/^\s*window\.__INITIAL_STATE__\s*=\s*/)?.[0];
  if (!prefix) return undefined;
  let objectStart = prefix.length;
  while (/\s/.test(scripts[0][objectStart] ?? "")) objectStart += 1;
  if (scripts[0][objectStart] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < scripts[0].length; index += 1) {
    const character = scripts[0][index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        const state = JSON.parse(scripts[0].slice(objectStart, index + 1)) as Record<string, unknown>;
        return aptekaStateRecord(state.product);
      } catch { return undefined; }
    }
  }
  return undefined;
}

function aptekaStateItemProvesExactZero(
  value: unknown,
  productId: string,
  productSlug: string,
  productName: string,
  requireDefault = false
): boolean {
  const item = aptekaStateRecord(value);
  return Boolean(item) && String(item!.id ?? "") === productId &&
    compactText(String(item!.humanableUrl ?? "")) === productSlug &&
    compactText(String(item!.name ?? "")) === productName &&
    item!.reviewsCount === 0 && item!.rating === null &&
    (!requireDefault || item!.default === true);
}

function aptekaStateGroupItems(value: unknown, productId: string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const selected: unknown[] = [];
  for (const groupValue of value) {
    const group = aptekaStateRecord(groupValue);
    if (!group || !Array.isArray(group.itemInfos)) return undefined;
    for (const item of group.itemInfos) {
      const itemRecord = aptekaStateRecord(item);
      if (!itemRecord) return undefined;
      if (String(itemRecord.id ?? "") === productId) selected.push(item);
    }
  }
  return selected;
}

function aptekaInitialStateProvesExactZero(
  $: CheerioAPI,
  productId: string,
  productUrl: string,
  productName: string
): boolean {
  const productSlug = new URL(productUrl).pathname.match(/^\/product\/([^/]+)\/$/i)?.[1];
  const productState = aptekaAssignedProductState($);
  if (!productSlug || !productState || productState.selected !== productId || productState.groupId !== productId ||
    productState.error !== false || productState.transition !== null ||
    !Array.isArray(productState.itemReviews) || productState.itemReviews.length !== 0) return false;
  const itemInfo = aptekaStateRecord(productState.iteminfo);
  if (!itemInfo || Object.keys(itemInfo).length !== 1 || !(productId in itemInfo) ||
    !aptekaStateItemProvesExactZero(itemInfo[productId], productId, productSlug, productName)) return false;
  const products = aptekaStateRecord(productState.products);
  if (!products || !aptekaStateItemProvesExactZero(products[productId], productId, productSlug, productName)) return false;
  const directGroups = aptekaStateGroupItems(productState.groupItems, productId);
  const mirroredGroups = aptekaStateGroupItems(aptekaStateRecord(productState.groupinfo)?.groupItems, productId);
  return directGroups?.length === 1 && mirroredGroups?.length === 1 &&
    aptekaStateItemProvesExactZero(directGroups[0], productId, productSlug, productName, true) &&
    aptekaStateItemProvesExactZero(mirroredGroups[0], productId, productSlug, productName, true);
}

export class AptekaRuAdapter extends AdditionalPharmacyAdapter {
  readonly id = "apteka.ru:preparation-jsonld-v1";
  readonly supportedDomains = [APTEKA_DOMAIN, `www.${APTEKA_DOMAIN}`] as const;

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    const canaryId = "5e3268eaca7bdc000192d316";
    const canaryUrl = `https://${APTEKA_DOMAIN}/product/oczillokokczinum-30-sht-granuly-${canaryId}/`;
    try {
      const page = await requestPage(new URL(canaryUrl), context, this.fetchImpl, APTEKA_TRANSLATE_HOST);
      const products = jsonLdProducts(page.$).filter((item) => String(item.sku ?? "") === canaryId);
      if (products.length !== 1 || !matchesBrand(compactText(String(products[0].name ?? "")), "Оциллококцинум")) {
        throw new ParserChangedError(`${this.id}: control Product JSON-LD is missing or ambiguous`);
      }
      return { ok: true, checkedAt, message: `${this.id}: control product structure is valid` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(APTEKA_DOMAIN, brand, context, aptekaRef);
    const slugs = aptekaPreparationSlugs(brand);
    for (const slug of slugs) {
      const source = new URL(`https://${APTEKA_DOMAIN}/preparation/${slug}/`);
      let page: HtmlPage;
      try {
        page = await requestPage(source, context, this.fetchImpl, APTEKA_TRANSLATE_HOST);
      } catch (error) {
        // Preparation pages are only a fast, source-bound SSR discovery hint.
        // Keep walking the bounded transliterations when that optional route
        // is unavailable; the filtered first-party sitemap remains the
        // authoritative fallback. Parser/content errors still fail closed.
        if (error instanceof AdapterBlockedError) continue;
        throw error;
      }
      page.$("a[href*='/product/']").each((_index, node) => {
        const sourceLink = sourceHref(page.$(node).attr("href"), APTEKA_DOMAIN);
        const parsed = sourceLink ? aptekaRef(sourceLink.toString()) : undefined;
        if (!parsed) return;
        const card = page.$(node).closest("article, li, [class*='product'], [class*='item']");
        const title = compactText(page.$(node).attr("aria-label") || page.$(node).text() || card.text());
        if (!matchesBrand(title, brand)) return;
        refs.set(parsed.id, {
          domain: APTEKA_DOMAIN, platform: APTEKA_DOMAIN, listingId: parsed.id, brand,
          url: parsed.url, title, metadata: { discovery: "first-party-preparation-page" }
        });
      });
      if (refs.size) break;
    }
    if (!refs.size) {
      const sitemap = new URL(`https://${APTEKA_DOMAIN}/sitemap-product.xml`);
      sitemap.searchParams.set("slugs", slugs.join(","));
      const page = await requestPage(sitemap, context, this.fetchImpl);
      if (!/<urlset\b/i.test(page.html)) {
        throw new ParserChangedError(`${APTEKA_DOMAIN}: product sitemap proof is missing`);
      }
      for (const match of page.html.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        const parsed = aptekaRef(match[1].replace(/&amp;/gi, "&"));
        if (!parsed) continue;
        const productSlug = new URL(parsed.url).pathname.match(/^\/product\/([a-z0-9-]+)-[a-f0-9]{24}\/?$/i)?.[1] ?? "";
        if (!slugs.some((slug) => productSlug === slug || productSlug.startsWith(`${slug}-`))) continue;
        refs.set(parsed.id, {
          domain: APTEKA_DOMAIN, platform: APTEKA_DOMAIN, listingId: parsed.id, brand,
          url: parsed.url, metadata: { discovery: "first-party-product-sitemap" }
        });
      }
    }
    for (const product of APTEKA_BOUNDED_EXACT_PRODUCTS[normalizeText(brand)] ?? []) {
      if (refs.has(product.id)) continue;
      refs.set(product.id, {
        domain: APTEKA_DOMAIN,
        platform: APTEKA_DOMAIN,
        listingId: product.id,
        brand,
        url: product.url,
        title: product.title,
        metadata: { discovery: "bounded-exact-product-registry" }
      });
    }
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = aptekaRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    // Direct Apteka product egress is intermittently rejected while the
    // source-bound Translate SSR route returns the same canonical Product
    // JSON-LD. Keep discovery on the first-party sitemap and collect the exact
    // proven product through that bounded gateway.
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, APTEKA_TRANSLATE_HOST);
    const products = jsonLdProducts(page.$).filter((item) => String(item.sku ?? "") === ref.listingId);
    if (products.length !== 1) throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: exact Product JSON-LD is missing or ambiguous`);
    const product = products[0];
    const title = compactText(String(product.name ?? ""));
    if (!matchesBrand(title, ref.brand)) throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: product brand changed`);
    const aggregate = product.aggregateRating;
    let reviews: number | undefined;
    let ratingCount: number | undefined;
    let value: number | undefined;
    if (aggregate && typeof aggregate === "object") {
      const record = aggregate as Record<string, unknown>;
      reviews = exactInteger(record.reviewCount);
      ratingCount = exactInteger(record.ratingCount);
      value = exactRating(record.ratingValue);
    }
    if (reviews === undefined && ratingCount === undefined) {
      if (!aptekaInitialStateProvesExactZero(page.$, ref.listingId, parsedRef.url, title)) {
        throw new AdapterBlockedError(
          `${APTEKA_DOMAIN}:${ref.listingId}: review_aggregate_unavailable: exact product has no source-bound feedback aggregate`
        );
      }
      reviews = 0;
      ratingCount = 0;
    }
    const feedbackCount = Math.max(reviews ?? 0, ratingCount ?? 0);
    if (feedbackCount > 0) {
      const visible = aptekaVisibleFeedback(page.$, parsedRef.url, title);
      const exactOffer = aptekaExactOfferProof(product, parsedRef.url, title);
      if ((!visible || visible.count !== feedbackCount || visible.rating !== value) && !exactOffer) {
        throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: structured feedback is not proven by the selected product variant`);
      }
    }
    if (feedbackCount > 0 && value === undefined) {
      throw new ParserChangedError(`${APTEKA_DOMAIN}:${ref.listingId}: complete feedback aggregate is missing`);
    }
    return observation(this.evidence, ref, page, {
      domain: APTEKA_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews: reviews ?? 0,
      ratingCount: ratingCount ?? null,
      rating: value ?? null,
      source: "apteka-product-jsonld"
    });
  }
}

const NF_DOMAIN = "nfapteka.ru";
const NF_TRANSLATE_HOST = "nfapteka-ru.translate.goog";
const NF_PRODUCT = /^\/(?:[a-z0-9-]+\/)*catalog\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.html$/i;

function nfRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  const id = expectedId;
  if (!id || !/^\d+$/.test(id)) return undefined;
  const url = sourceHref(value, NF_DOMAIN);
  if (!url || !NF_PRODUCT.test(url.pathname)) return undefined;
  return { id, url: `https://${NF_DOMAIN}${url.pathname}` };
}

function nfExplicitEmptyProductReviews($: CheerioAPI): boolean {
  const sections = $("#review");
  if (sections.length !== 1) return false;
  const section = sections.first();
  if (section.children().length !== 2 || section.children("h2").length !== 1 ||
    section.find("[itemprop='review'], [data-review-id], .review-item, [itemprop='ratingValue']").length) return false;
  const heading = compactText(section.children("h2").first().text());
  const links = section.find("a[href]");
  if (!/^Отзывы\s+\S/iu.test(heading) || links.length !== 1 || compactText(links.first().text()) !== "Оставить отзыв") return false;
  try {
    return new URL(links.first().attr("href") ?? "", "https://nfapteka.ru/").hash === "#testimonialModal";
  } catch {
    return false;
  }
}

function nfVisibleReviewMetrics($: CheerioAPI, brand: string, expectedTitle: string): { reviews: number; rating: number } | undefined {
  const section = $("#review");
  if (section.length !== 1) return undefined;
  const items = section.find(".testimonial[itemscope][itemtype*='Review']");
  if (!items.length) return undefined;
  const expectedProduct = canonicalProductDescriptor(brand, expectedTitle);
  if (!expectedProduct) return undefined;
  let sum = 0;
  for (const node of items.toArray()) {
    const item = $(node);
    const reviewed = compactText(item.find("meta[itemprop='itemReviewed']").first().attr("content") ?? "");
    const score = exactRating(item.find("[itemprop='reviewRating'] [itemprop='ratingValue']").first().attr("content"));
    if (canonicalProductDescriptor(brand, reviewed) !== expectedProduct || score === undefined) return undefined;
    sum += score;
  }
  return { reviews: items.length, rating: Math.round(sum / items.length * 100) / 100 };
}

export class NfAptekaAdapter extends AdditionalPharmacyAdapter {
  readonly id = "nfapteka.ru:translated-microdata-v1";
  readonly supportedDomains = [NF_DOMAIN, `www.${NF_DOMAIN}`] as const;

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    return this.canary("Оциллококцинум", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(NF_DOMAIN, brand, context, nfRef);
    const source = new URL(`https://${NF_DOMAIN}/catalog/`);
    source.searchParams.set("q", brand);
    const page = await requestPage(source, context, this.fetchImpl, NF_TRANSLATE_HOST);
    page.$(".productOuter, [class*='productOuter']").each((_index, node) => {
      const root = page.$(node);
      const id = root.find("[data-id]").first().attr("data-id")?.trim();
      if (!id) return;
      let selected: { parsed: { id: string; url: string }; title: string } | undefined;
      for (const candidate of root.find("a[href$='.html'], a[href*='.html?']").toArray()) {
        const link = page.$(candidate);
        const title = compactText(link.text() || link.find("img[alt]").first().attr("alt") || "");
        if (!title) continue;
        const parsed = nfRef(link.attr("href") ?? "", id);
        if (!parsed) continue;
        selected = { parsed, title };
        break;
      }
      if (!selected) return;
      const parsed = selected.parsed;
      const title = selected.title;
      if (!matchesBrand(title, brand)) return;
      refs.set(parsed.id, {
        domain: NF_DOMAIN, platform: NF_DOMAIN, listingId: parsed.id, brand,
        url: parsed.url, title, metadata: { discovery: "translated-first-party-search" }
      });
    });
    if (!refs.size) {
      const text = compactText(page.$("main, body").text());
      if (/ничего не найдено|товары не найдены|по вашему запросу.{0,80}не найдено/i.test(text)) return [];
      throw new AdapterBlockedError(`${NF_DOMAIN}: search proved neither exact products nor no results`);
    }
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = nfRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, NF_TRANSLATE_HOST);
    const pageId = page.$("input[name='productId'], [data-id]").first().attr("value")
      ?? page.$("[data-id]").first().attr("data-id");
    const canonical = sourceHref(page.$("link[rel='canonical']").first().attr("href"), NF_DOMAIN);
    const title = compactText(page.$("h1").first().text());
    if (pageId !== ref.listingId || !canonical || canonical.pathname !== new URL(parsedRef.url).pathname || !matchesBrand(title, ref.brand)) {
      throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: exact product identity changed`);
    }
    const aggregate = page.$("[itemprop='aggregateRating']").first();
    const reviews = exactInteger(aggregate.find("[itemprop='reviewCount']").first().attr("content") ?? aggregate.find("[itemprop='reviewCount']").first().text())
      ?? (nfExplicitEmptyProductReviews(page.$) ? 0 : undefined);
    const value = exactRating(aggregate.find("[itemprop='ratingValue']").first().attr("content") ?? aggregate.find("[itemprop='ratingValue']").first().text());
    if (reviews === undefined || reviews > 0 && value === undefined) {
      throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: complete product feedback microdata is missing`);
    }
    if (reviews > 0) {
      const visible = nfVisibleReviewMetrics(page.$, ref.brand, title);
      const aggregateMatchesVisible = visible && (
        Math.abs(visible.rating - value!) <= 0.01 ||
        Number.isInteger(value) && Math.round(visible.rating) === value
      );
      if (!visible || visible.reviews !== reviews || !aggregateMatchesVisible) {
        throw new ParserChangedError(`${NF_DOMAIN}:${ref.listingId}: aggregate feedback is not proven by the exact product review list`);
      }
    }
    return observation(this.evidence, ref, page, {
      domain: NF_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews,
      rating: reviews === 0 ? null : value!,
      source: "nfapteka-product-feedback:google-translate"
    });
  }
}

type EtablProduct = {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  subtitleFull?: unknown;
  reviewsStats?: { rating?: unknown; reviewsCount?: unknown };
};

const ETABL_DOMAIN = "etabl.ru";
const ETABL_TRANSLATE_HOST = "etabl-ru.translate.goog";
const ETABL_PRODUCT = /^\/product\/([a-z0-9-]+=(\d+))\/?$/i;

function initialState($: CheerioAPI, domain: string): Record<string, unknown> {
  const script = $("script").toArray().map((node) => $(node).html() ?? "")
    .find((value) => value.startsWith("window.__INITIAL_STATE__="));
  if (!script) throw new ParserChangedError(`${domain}: __INITIAL_STATE__ is missing`);
  const raw = script.slice("window.__INITIAL_STATE__=".length);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  const suffix = end >= 0 ? raw.slice(end).trim() : "";
  const knownCleanup = /^(?:;\s*)?(?:document\.currentScript\.remove\(\)|\(function\(\)\{var s;\(s=document\.currentScript\|\|document\.scripts\[document\.scripts\.length-1\]\)\.parentNode\.removeChild\(s\);\}\(\)\))?;?$/u;
  if (end < 0 || !knownCleanup.test(suffix)) {
    throw new ParserChangedError(`${domain}: __INITIAL_STATE__ has an unknown executable suffix`);
  }
  try { return JSON.parse(raw.slice(0, end)) as Record<string, unknown>; }
  catch { throw new ParserChangedError(`${domain}: __INITIAL_STATE__ is invalid JSON`); }
}

function etablRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  const url = sourceHref(value, ETABL_DOMAIN);
  if (!url) return undefined;
  const match = url.pathname.match(ETABL_PRODUCT);
  if (!match || expectedId && match[2] !== expectedId) return undefined;
  return { id: match[2], url: `https://${ETABL_DOMAIN}/product/${match[1]}` };
}

function etablTitle(product: EtablProduct): string {
  return compactText(`${String(product.name ?? "")} ${String(product.subtitleFull ?? "")}`);
}

export class EtablAdapter extends AdditionalPharmacyAdapter {
  readonly id = "etabl.ru:translated-state-v1";
  readonly supportedDomains = [ETABL_DOMAIN, `www.${ETABL_DOMAIN}`] as const;

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    return this.canary("Оциллококцинум", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(ETABL_DOMAIN, brand, context, etablRef);
    const source = new URL(`https://${ETABL_DOMAIN}/search`);
    source.searchParams.set("query", brand);
    source.searchParams.set("limit", "100");
    const page = await requestPage(source, context, this.fetchImpl, ETABL_TRANSLATE_HOST);
    const state = initialState(page.$, ETABL_DOMAIN);
    const search = state.search as {
      searchResultNew?: unknown;
      searchResultCount?: unknown;
      searchQuery?: unknown;
    } | undefined;
    const products = Array.isArray(search?.searchResultNew) ? search.searchResultNew as EtablProduct[] : undefined;
    const count = exactInteger(search?.searchResultCount);
    const normalizedQuery = compactText(String(search?.searchQuery ?? ""))
      .toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const normalizedBrand = compactText(brand).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    // searchResultCount is a broad catalogue counter and can exceed the
    // sellable cards in searchResultNew (live Хондрофен: 2 vs 1). It is not a
    // pagination proof. Require the exact echoed query and a structurally
    // consistent card array; a positive counter with no cards stays blocked.
    if (!products || count === undefined || normalizedQuery !== normalizedBrand ||
      count < products.length || count > 0 && products.length === 0) {
      throw new ParserChangedError(`${ETABL_DOMAIN}: search result is incomplete or malformed`);
    }
    for (const product of products) {
      const id = String(product.id ?? "");
      const parsed = etablRef(`https://${ETABL_DOMAIN}/product/${String(product.url ?? "")}`, id);
      const title = etablTitle(product);
      if (!parsed || !matchesBrand(title, brand)) continue;
      refs.set(parsed.id, {
        domain: ETABL_DOMAIN, platform: ETABL_DOMAIN, listingId: parsed.id, brand,
        url: parsed.url, title, metadata: { discovery: "translated-first-party-search-state" }
      });
    }
    if (!refs.size && count === 0) return [];
    if (!refs.size) throw new ParserChangedError(`${ETABL_DOMAIN}: search returned products but none proved the requested brand`);
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = etablRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${ETABL_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, ETABL_TRANSLATE_HOST);
    const state = initialState(page.$, ETABL_DOMAIN);
    const product = (state.products as { product?: EtablProduct } | undefined)?.product;
    const id = String(product?.id ?? "");
    const exact = product ? etablRef(`https://${ETABL_DOMAIN}/product/${String(product.url ?? "")}`, id) : undefined;
    const title = product ? etablTitle(product) : "";
    if (!product || id !== ref.listingId || exact?.url !== parsedRef.url || !matchesBrand(title, ref.brand)) {
      throw new ParserChangedError(`${ETABL_DOMAIN}:${ref.listingId}: exact product identity changed`);
    }
    const reviews = exactInteger(product.reviewsStats?.reviewsCount);
    const value = exactRating(product.reviewsStats?.rating);
    if (reviews === undefined || reviews > 0 && value === undefined) {
      throw new ParserChangedError(`${ETABL_DOMAIN}:${ref.listingId}: complete reviewsStats is missing`);
    }
    return observation(this.evidence, ref, page, {
      domain: ETABL_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews,
      rating: reviews === 0 ? null : value!,
      source: "etabl-product-state:google-translate"
    });
  }
}

const BUD_DOMAIN = "budzdorov.ru";
const BUD_TRANSLATE_HOST = "www-budzdorov-ru.translate.goog";
const BUD_PRODUCT = /^\/product\/(?:[a-z0-9-]+-)?(\d+)\/?$/i;
const BUD_FORM_SLUG_ALIASES: Record<string, string> = {
  "оциллококцинум": "ocillokokcinum"
};
const BUD_BOUNDED_EXACT_PRODUCTS: Record<string, Array<{ id: string; url: string; title: string }>> = {
  "бактоблис": [
    {
      id: "5005555",
      url: `https://www.${BUD_DOMAIN}/product/baktoblis-plyus-tabdlya-rassas-950mg-no30-ddet-starshe-3-kh-let-i-vzr-bad-5005555`,
      title: "Бактоблис плюс таблетки для рассасывания 950 мг №30"
    },
    {
      id: "109834",
      url: `https://www.${BUD_DOMAIN}/product/baktoblis-tab-dlya-rassasyv-30g-no30-109834`,
      title: "Бактоблис таблетки для рассасывания 30 г №30"
    },
    {
      id: "5005556",
      url: `https://www.${BUD_DOMAIN}/product/baktoblis-poroshok-dlya-vzr-i-det-ot-15let-sashe-paket-1500mg-no15-bad-5005556`,
      title: "Бактоблис порошок в саше-пакетах 1500 мг №15"
    },
    {
      id: "6000866",
      url: `https://www.${BUD_DOMAIN}/product/baktoblis-poroshok-v-sashe-paketakh-1500mg-no30-6000866`,
      title: "Бактоблис порошок в саше-пакетах 1500 мг №30"
    }
  ],
  "кагоцел": [
    {
      id: "15027",
      url: `https://www.${BUD_DOMAIN}/product/kagotsel-tab-12mg-no10-15027`,
      title: "Кагоцел таблетки 0,012г №10"
    },
    {
      id: "90933",
      url: `https://www.${BUD_DOMAIN}/product/90933`,
      title: "Кагоцел таблетки 0,012г №10"
    },
    {
      id: "106662",
      url: `https://www.${BUD_DOMAIN}/product/kagotsel-tab-12mg-no20-106662`,
      title: "Кагоцел таблетки 12мг №20"
    },
    {
      id: "110671",
      url: `https://www.${BUD_DOMAIN}/product/kagotsel-tab-12mg-no30-110671`,
      title: "Кагоцел таблетки 12мг №30"
    }
  ],
  "энтеролактис": [
    {
      id: "113143",
      url: `https://www.${BUD_DOMAIN}/product/enterolaktis-plyus-kaps-316mg-no15-bad-113143`,
      title: "Энтеролактис Плюс капсулы 316 мг №15"
    },
    {
      id: "4993056",
      url: `https://www.${BUD_DOMAIN}/product/enterolaktis-fibra-sirop-fl-10ml-kapsula-s-porno12-bad-4993056`,
      title: "Энтеролактис Фибра сироп 10 мл №12"
    },
    {
      id: "5005750",
      url: `https://www.${BUD_DOMAIN}/product/enterolaktis-duo-sashe-5g-no20-bad-5005750`,
      title: "Энтеролактис Дуо саше 5 г №20"
    }
  ]
};

function budFormSlugs(brand: string): string[] {
  const normalized = brand.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
  const known = BUD_FORM_SLUG_ALIASES[normalized];
  return known ? [known] : transliteratedSlugs(brand);
}

function budRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  const url = sourceHref(value, `www.${BUD_DOMAIN}`);
  if (!url || host(url.hostname) !== BUD_DOMAIN) return undefined;
  const id = url.pathname.match(BUD_PRODUCT)?.[1];
  if (!id || expectedId && id !== expectedId) return undefined;
  return { id, url: `https://www.${BUD_DOMAIN}${url.pathname}` };
}

function budMissingFormPage(error: unknown): boolean {
  return error instanceof AdapterBlockedError && /\(HTTP 404\)$/.test(error.message);
}

function addBudDiscoveryRefs(
  page: HtmlPage,
  selector: string,
  brand: string,
  discovery: "translated-first-party-form-page" | "translated-first-party-letter-index",
  refs: Map<string, ProductRef>
): void {
  page.$(selector).each((_index, node) => {
    const link = page.$(node);
    const parsed = budRef(link.attr("href") ?? "");
    const title = compactText(link.attr("title") || link.text());
    if (!parsed || !matchesBrand(title, brand)) return;
    const previous = refs.get(parsed.id);
    refs.set(parsed.id, {
      domain: BUD_DOMAIN,
      platform: BUD_DOMAIN,
      listingId: parsed.id,
      brand,
      url: parsed.url,
      title,
      metadata: {
        discovery: previous && previous.metadata.discovery !== discovery
          ? "translated-first-party-form+letter-union"
          : discovery
      }
    });
  });
}

type BudReview = { id?: unknown; ratings?: Array<{ attribute_code?: unknown; value?: unknown }> };

function boundedBudRefs(brand: string): ProductRef[] {
  return (BUD_BOUNDED_EXACT_PRODUCTS[normalizeText(brand)] ?? []).map((product) => ({
    domain: BUD_DOMAIN,
    platform: BUD_DOMAIN,
    listingId: product.id,
    brand,
    url: product.url,
    title: product.title,
    metadata: { discovery: "bounded-exact-product-registry" }
  }));
}

function parseBudReviewPage(page: HtmlPage, ref: ProductRef): {
  title: string;
  reviews: BudReview[];
  rating: number | null;
  ratingUnavailable: boolean;
} {
  const title = compactText(page.$("h1").first().text());
  if (!matchesBrand(title, ref.brand)) throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: product brand changed`);
  const state = initialState(page.$, BUD_DOMAIN);
  const productView = state.productView as { reviews?: unknown } | undefined;
  const reviews = Array.isArray(productView?.reviews) ? productView.reviews as BudReview[] : undefined;
  const visibleCount = exactInteger(page.$("[allreviewsqty]").first().attr("allreviewsqty"));
  if (!reviews || visibleCount === undefined || visibleCount !== reviews.length) {
    throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: full review list is missing or incomplete`);
  }
  const ids = new Set<string>();
  let sum = 0;
  let ratedReviews = 0;
  for (const review of reviews) {
    const id = String(review.id ?? "");
    if (!id || ids.has(id) || !Array.isArray(review.ratings)) {
      throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: review identities or scores are incomplete`);
    }
    ids.add(id);
    const scores = review.ratings.filter((item) =>
      String(item.attribute_code ?? "").toLocaleLowerCase("ru-RU") === "оценка"
    );
    if (scores.length === 0) continue;
    const score = scores.length === 1 ? exactRating(scores[0].value) : undefined;
    if (score === undefined) {
      throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: review identities or scores are incomplete`);
    }
    sum += score;
    ratedReviews += 1;
  }
  return {
    title,
    reviews,
    rating: reviews.length && ratedReviews === reviews.length
      ? Math.round(sum / reviews.length * 10) / 10
      : null,
    ratingUnavailable: reviews.length > 0 && ratedReviews < reviews.length
  };
}

export class BudZdorovAdapter extends AdditionalPharmacyAdapter {
  readonly id = "budzdorov.ru:translated-review-state-v1";
  readonly supportedDomains = [BUD_DOMAIN, `www.${BUD_DOMAIN}`] as const;
  private readonly successfulDiscovery = new Map<string, ProductRef[]>();

  private discoveryKey(brand: string, context: AdapterContext): string {
    return `${context.runId ?? "standalone"}:${normalizeText(brand)}`;
  }

  healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    // Check the product family that this run is actually about. A transient
    // block on an unrelated canary must not prevent a healthy brand partition.
    return this.canary(context.brands?.[0]?.trim() || "Оциллококцинум", context);
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const refs = historicalRefs(BUD_DOMAIN, brand, context, budRef);
    const cacheKey = this.discoveryKey(brand, context);
    const cached = this.successfulDiscovery.get(cacheKey);
    if (cached) {
      this.successfulDiscovery.delete(cacheKey);
      for (const ref of cached) refs.set(ref.listingId, { ...ref, metadata: { ...ref.metadata } });
      return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
    }
    const liveRefs = new Map<string, ProductRef>();
    const slugs = budFormSlugs(brand);
    let explicitNoResults = 0;
    let successfulPages = 0;
    let formError: unknown;
    for (const slug of slugs) {
      try {
        const source = new URL(`https://www.${BUD_DOMAIN}/forms/${slug}`);
        const page = await requestPage(source, context, this.fetchImpl, BUD_TRANSLATE_HOST);
        successfulPages += 1;
        addBudDiscoveryRefs(page, "a[href*='/product/']", brand, "translated-first-party-form-page", liveRefs);
        const text = compactText(page.$("main, body").text());
        if (/ничего не найдено|товары не найдены|нет препаратов/i.test(text)) explicitNoResults += 1;
      } catch (error) {
        if (!budMissingFormPage(error)) formError ??= error;
      }
    }

    const initial = brand.normalize("NFKC").trim().charAt(0).toLocaleUpperCase("ru-RU");
    if (!initial) throw new AdapterBlockedError(`${BUD_DOMAIN}: brand has no alphabet initial`);
    const letterSource = new URL(`https://www.${BUD_DOMAIN}/letter/${encodeURIComponent(initial)}`);
    let letterError: unknown;
    try {
      const letterPage = await requestPage(letterSource, context, this.fetchImpl, BUD_TRANSLATE_HOST);
      if (!letterPage.$(".alphabet-forms").length) {
        throw new ParserChangedError(`${BUD_DOMAIN}: letter index structure is missing`);
      }
      addBudDiscoveryRefs(
        letterPage,
        ".alphabet-forms a[href*='/product/'], a.alphabet-forms__item-link[href*='/product/']",
        brand,
        "translated-first-party-letter-index",
        liveRefs
      );
    } catch (error) {
      letterError = error;
    }

    // The exact /forms/<brand> page is the first-party family index. Once it
    // has yielded exact product links, the alphabet page is only an auxiliary
    // completeness cross-check and cannot discard already proven cards.
    const discoveryError = liveRefs.size ? undefined : formError ?? letterError;
    const bounded = boundedBudRefs(brand);
    if (discoveryError) {
      if (!bounded.length) throw discoveryError;
      const verified = await Promise.all(bounded.map(async (ref) => {
        const parsedRef = budRef(ref.url, ref.listingId);
        if (!parsedRef) throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: invalid bounded product URL`);
        const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, BUD_TRANSLATE_HOST);
        const parsed = parseBudReviewPage(page, ref);
        return { ...ref, title: parsed.title, metadata: { ...ref.metadata } };
      }));
      liveRefs.clear();
      for (const ref of verified) liveRefs.set(ref.listingId, ref);
    } else {
      for (const ref of bounded) {
        if (!liveRefs.has(ref.listingId)) liveRefs.set(ref.listingId, ref);
      }
    }

    if (!liveRefs.size && !refs.size) {
      if (successfulPages === slugs.length && explicitNoResults === slugs.length) return [];
      throw new AdapterBlockedError(`${BUD_DOMAIN}: form and letter pages proved neither exact products nor no results`);
    }
    if (liveRefs.size) {
      const snapshot = [...liveRefs.values()].map((ref) => ({ ...ref, metadata: { ...ref.metadata } }));
      this.successfulDiscovery.set(cacheKey, snapshot);
      for (const ref of snapshot) refs.set(ref.listingId, ref);
    }
    return [...refs.values()].sort((left, right) => (left.title ?? "").localeCompare(right.title ?? "", "ru"));
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = budRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${BUD_DOMAIN}:${ref.listingId}: invalid product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl, BUD_TRANSLATE_HOST);
    const parsed = parseBudReviewPage(page, ref);
    const result = await observation(this.evidence, ref, page, {
      domain: BUD_DOMAIN,
      title: parsed.title,
      canonicalUrl: parsedRef.url,
      reviews: parsed.reviews.length,
      rating: parsed.rating,
      source: "budzdorov-complete-review-state:google-translate"
    });
    if (parsed.ratingUnavailable) result.ratingUnavailable = true;
    return result;
  }
}

export class AptekaAprilAdapter extends AdditionalPharmacyAdapter {
  readonly id = "apteka-april.ru:blocked-free-mode-v1";
  readonly supportedDomains = ["apteka-april.ru", "www.apteka-april.ru"] as const;

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await requestPage(new URL("https://apteka-april.ru/robots.txt"), context, this.fetchImpl);
      return { ok: false, checkedAt, message: "apteka-april.ru: a verified free product profile is not available" };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(_brand: string, context: AdapterContext): Promise<ProductRef[]> {
    try {
      await requestPage(new URL("https://apteka-april.ru/robots.txt"), context, this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`apteka-april.ru: blocked_free_mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new AdapterBlockedError("apteka-april.ru: blocked_free_mode: no verified first-party search path");
  }

  async collect(): Promise<Observation> {
    throw new AdapterBlockedError("apteka-april.ru: blocked_free_mode");
  }
}

const OZERKI_DOMAIN = "ozerki.ru";
const OZERKI_FAMILY = /^\/alphabet\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/i;
const OZERKI_PRODUCT = /^\/catalog\/product\/([a-z0-9_-]+)\/?$/i;
const OZERKI_SEARCH_PATH = "/catalog/search/";
const OZERKI_MAX_SEARCH_PAGES = 50;
const OZERKI_MAX_SEARCH_PRODUCTS = 1_800;
const OZERKI_BOUNDED_PRODUCTS = [
  {
    brand: "Бивиарт",
    id: "370912",
    title: "Бивиарт Ультра",
    url: "https://ozerki.ru/catalog/product/biviart-ultra-rastvor-oftalmologicheskiy-uvlazhnyayushchiy-fl-kap-10ml-1-370912/"
  },
  {
    brand: "Энтеролактис",
    id: "339183",
    title: "Энтеролактис Фибра сироп 10 мл 12 шт",
    url: "https://ozerki.ru/catalog/product/enterolaktis-fibra-sirop-fl-10ml-12/"
  },
  {
    brand: "Энтеролактис",
    id: "346830",
    title: "Энтеролактис Плюс капсулы 15 шт",
    url: "https://ozerki.ru/catalog/product/enterolaktis-plyus-n15-kaps-po-316mg-346830/"
  },
  {
    brand: "Энтеролактис",
    id: "362968",
    title: "Энтеролактис Дуо порошок для приготовления раствора 5 г 20 шт",
    url: "https://ozerki.ru/catalog/product/enterolaktis-duo-n20-sashe-po-5g-362968/"
  }
] as const;

function ozerkiProductEmptyReviewProof(
  page: HtmlPage,
  expected: { id: string; title: string; url: string; brand: string }
): boolean {
  const feedback = page.$("#feedbackAnchor");
  const emptyBlocks = page.$("[class*='Reviews_noReviewsBlock__']");
  if (page.$("[itemprop='aggregateRating'], [itemprop='review']").length !== 0) return false;
  if (feedback.length > 1 || emptyBlocks.length > 1 || feedback.length !== emptyBlocks.length) return false;
  if (feedback.length === 1) {
    const text = normalizeText(emptyBlocks.first().text());
    const hasVisibleEmptyState = text.includes("вы использовали этот товар") &&
      text.includes("поделитесь своим мнением о нем");
    const hasFailureMarker = /\b(?:loading|error)\b|\u043e\u0448\u0438\u0431\u043a|\u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c|\u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435 \u043f\u043e\u0437\u0436\u0435/iu.test(feedback.text());
    if (!hasVisibleEmptyState || hasFailureMarker) return false;
  }

  const stateScripts = page.$("script#__NEXT_DATA__[type='application/json']");
  if (stateScripts.length !== 1) return false;
  try {
    const payload = JSON.parse(stateScripts.first().html() ?? "") as unknown;
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    const props = record(payload)?.props;
    const pageProps = record(props)?.pageProps;
    const data = record(pageProps)?.data;
    const componentData = record(record(data)?.componentData);
    const productCard = record(componentData?.productCard);
    const product = record(productCard?.product);
    const reviews = componentData?.initialReviews;
    const meta = record(record(reviews)?.meta);
    const rates = record(record(reviews)?.rates);
    const distribution = record(rates?.filterByValue);
    const productId = exactInteger(product?.productId);
    const id = exactInteger(product?.id);
    const title = typeof product?.name === "string" ? compactText(product.name) : "";
    const sourceRef = typeof product?.href === "string"
      ? ozerkiCanonicalProductRef(product.href, expected.id, true)
      : undefined;
    return productId !== undefined && id === productId && String(productId) === expected.id &&
      normalizeText(title) === normalizeText(expected.title) && matchesBrand(title, expected.brand) &&
      sourceRef?.url === expected.url &&
      Array.isArray(record(reviews)?.data) && (record(reviews)?.data as unknown[]).length === 0 &&
      exactInteger(meta?.current_page) === 1 && meta?.from === null && exactInteger(meta?.last_page) === 1 &&
      exactInteger(meta?.per_page) !== undefined && meta?.to === null && exactInteger(meta?.total) === 0 &&
      rates?.average === null && exactInteger(rates?.total) === 0 &&
      ["1", "2", "3", "4", "5"].every((score) => exactInteger(distribution?.[score]) === 0);
  } catch {
    return false;
  }
}

function ozerkiFamilyRef(value: string, expectedId?: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value, `https://${OZERKI_DOMAIN}/`);
    if (url.protocol !== "https:" || host(url.hostname) !== OZERKI_DOMAIN || url.search || url.hash) return undefined;
    const match = url.pathname.match(OZERKI_FAMILY);
    if (!match) return undefined;
    const id = `family-${match[2]}`;
    if (expectedId && expectedId !== id) return undefined;
    return { id, url: `https://${OZERKI_DOMAIN}/alphabet/${match[1]}/${match[2]}/` };
  } catch {
    return undefined;
  }
}

function ozerkiProductRef(
  value: string,
  expectedId?: string,
  allowSearchBoundId = false
): { id: string; url: string } | undefined {
  try {
    const url = new URL(value, `https://${OZERKI_DOMAIN}/`);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    if (url.protocol !== "https:" ||
      hostname !== OZERKI_DOMAIN && !hostname.endsWith(`.${OZERKI_DOMAIN}`) ||
      url.search || url.hash) return undefined;
    const match = url.pathname.match(OZERKI_PRODUCT);
    if (!match) return undefined;
    const embeddedId = match[1].match(/-(\d+)$/)?.[1];
    const exactBoundedProduct = expectedId
      ? OZERKI_BOUNDED_PRODUCTS.find((product) =>
        product.id === expectedId && new URL(product.url).pathname === url.pathname
      )
      : undefined;
    if (embeddedId && expectedId && embeddedId !== expectedId && !exactBoundedProduct && !allowSearchBoundId) return undefined;
    const id = expectedId ?? embeddedId;
    if (!id) return undefined;
    return { id, url: `https://${OZERKI_DOMAIN}/catalog/product/${match[1]}/` };
  } catch {
    return undefined;
  }
}

function ozerkiCanonicalProductRef(
  value: string | undefined,
  expectedId: string,
  allowSearchBoundId = false
): { id: string; url: string } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, `https://${OZERKI_DOMAIN}/`);
    if (host(url.hostname) !== OZERKI_DOMAIN) return undefined;
    return ozerkiProductRef(url.toString(), expectedId, allowSearchBoundId);
  } catch {
    return undefined;
  }
}

function ozerkiMissingFamilyPage(error: unknown): error is AdapterBlockedError {
  return error instanceof AdapterBlockedError && /\(HTTP 404\)$/.test(error.message);
}

type OzerkiSearchProduct = { id: string; title: string; url: string };
type OzerkiSearchPage = {
  products: OzerkiSearchProduct[];
  total: number;
  currentPage: number;
  lastPage: number;
  perPage: number;
  controls: string;
};

function ozerkiRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ozerkiSearchProofError(detail: string): ParserChangedError {
  return new ParserChangedError(`${OZERKI_DOMAIN}: exact search proof is incomplete (${detail})`);
}

function ozerkiExactSearchQuery(value: unknown, brand: string): boolean {
  return typeof value === "string" && normalizeText(value) === normalizeText(brand);
}

function ozerkiSearchFilterProof(value: unknown, brand: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value, `https://${OZERKI_DOMAIN}/`);
    const keys = [...url.searchParams.keys()];
    return url.protocol === "https:" && host(url.hostname) === OZERKI_DOMAIN &&
      url.pathname.replace(/\/$/, "") === OZERKI_SEARCH_PATH.replace(/\/$/, "") && !url.hash &&
      keys.length === 1 && keys[0] === "q" && url.searchParams.getAll("q").length === 1 &&
      ozerkiExactSearchQuery(url.searchParams.get("q"), brand);
  } catch {
    return false;
  }
}

function ozerkiSearchProduct(value: unknown): OzerkiSearchProduct | undefined {
  const item = ozerkiRecord(value);
  if (!item || typeof item.id !== "string" || !/^\d+$/.test(item.id)) return undefined;
  const productId = exactInteger(item.productId);
  const id = exactInteger(item.id);
  const title = typeof item.name === "string" ? compactText(item.name) : "";
  if (!productId || productId !== id || !title || typeof item.href !== "string") return undefined;
  try {
    const url = new URL(item.href, `https://${OZERKI_DOMAIN}/`);
    if (url.protocol !== "https:" || host(url.hostname) !== OZERKI_DOMAIN || url.search || url.hash ||
      !url.pathname.match(OZERKI_PRODUCT)) return undefined;
    return {
      id: String(productId),
      title,
      url: `https://${OZERKI_DOMAIN}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`
    };
  } catch {
    return undefined;
  }
}

function parseOzerkiSearchPage(page: HtmlPage, brand: string, expectedPage: number): OzerkiSearchPage {
  const scripts = page.$("script#__NEXT_DATA__[type='application/json']");
  if (scripts.length !== 1) throw ozerkiSearchProofError("NEXT_DATA");
  let payload: unknown;
  try {
    payload = JSON.parse(scripts.first().html() ?? "") as unknown;
  } catch {
    throw ozerkiSearchProofError("NEXT_DATA JSON");
  }

  const root = ozerkiRecord(payload);
  const query = ozerkiRecord(root?.query);
  const pageQuery = query?.page;
  if (!query || !ozerkiExactSearchQuery(query.q, brand) ||
    (expectedPage === 1
      ? pageQuery !== undefined && exactInteger(pageQuery) !== 1
      : exactInteger(pageQuery) !== expectedPage)) {
    throw ozerkiSearchProofError("query");
  }

  const componentData = ozerkiRecord(ozerkiRecord(ozerkiRecord(ozerkiRecord(root?.props)?.pageProps)?.data)?.componentData);
  const controls = ozerkiRecord(componentData?.catalogControls);
  const productList = ozerkiRecord(componentData?.productList);
  const productsValue = productList?.products;
  const pagination = ozerkiRecord(productList?.pagination);
  const total = exactInteger(componentData?.productCount);
  const limit = exactInteger(controls?.limit);
  if (!componentData || !controls || !productList || !Array.isArray(productsValue) || !pagination ||
    total === undefined || total > OZERKI_MAX_SEARCH_PRODUCTS || !limit ||
    !ozerkiSearchFilterProof(componentData.filterUrl, brand)) {
    throw ozerkiSearchProofError("catalog state");
  }
  const sort = controls.sort;
  const order = controls.order;
  const view = controls.view;
  if (typeof sort !== "string" || !sort || typeof order !== "string" || !order ||
    typeof view !== "string" || !view) throw ozerkiSearchProofError("catalog controls");
  const controlsProof = JSON.stringify({ sort, order, view, limit });

  if (total === 0) {
    if (expectedPage !== 1 || productsValue.length !== 0 || pagination.meta !== null) {
      throw ozerkiSearchProofError("empty pagination");
    }
    return { products: [], total: 0, currentPage: 1, lastPage: 1, perPage: limit, controls: controlsProof };
  }

  const meta = ozerkiRecord(pagination.meta);
  const currentPage = exactInteger(meta?.current_page);
  const from = exactInteger(meta?.from);
  const lastPage = exactInteger(meta?.last_page);
  const perPage = exactInteger(meta?.per_page);
  const to = exactInteger(meta?.to);
  const paginationTotal = exactInteger(meta?.total);
  if (!currentPage || !from || !lastPage || !perPage || !to || paginationTotal === undefined ||
    currentPage !== expectedPage || perPage !== limit || total !== paginationTotal ||
    lastPage > OZERKI_MAX_SEARCH_PAGES || lastPage !== Math.ceil(total / perPage) ||
    from !== (currentPage - 1) * perPage + 1 || to !== from + productsValue.length - 1 ||
    productsValue.length === 0 || productsValue.length > perPage ||
    (currentPage < lastPage && productsValue.length !== perPage) ||
    (currentPage === lastPage && to !== total)) {
    throw ozerkiSearchProofError("pagination");
  }

  const products = productsValue.map(ozerkiSearchProduct);
  if (products.some((item) => item === undefined)) throw ozerkiSearchProofError("product listing");
  return {
    products: products as OzerkiSearchProduct[],
    total,
    currentPage,
    lastPage,
    perPage,
    controls: controlsProof
  };
}

async function discoverOzerkiSearch(
  brand: string,
  context: AdapterContext,
  fetchImpl: typeof fetch
): Promise<ProductRef[]> {
  const products: OzerkiSearchProduct[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  let firstPage: OzerkiSearchPage | undefined;
  let pageNumber = 1;
  do {
    const source = new URL(OZERKI_SEARCH_PATH, `https://${OZERKI_DOMAIN}/`);
    source.searchParams.set("q", brand);
    if (pageNumber > 1) source.searchParams.set("page", String(pageNumber));
    const parsed = parseOzerkiSearchPage(
      await requestPage(source, context, fetchImpl),
      brand,
      pageNumber
    );
    if (!firstPage) firstPage = parsed;
    else if (parsed.total !== firstPage.total || parsed.lastPage !== firstPage.lastPage ||
      parsed.perPage !== firstPage.perPage || parsed.controls !== firstPage.controls) {
      throw ozerkiSearchProofError("snapshot changed between pages");
    }
    for (const product of parsed.products) {
      if (ids.has(product.id) || urls.has(product.url)) throw ozerkiSearchProofError("duplicate listing");
      ids.add(product.id);
      urls.add(product.url);
      products.push(product);
    }
    pageNumber += 1;
  } while (firstPage && pageNumber <= firstPage.lastPage);

  if (!firstPage || products.length !== firstPage.total) throw ozerkiSearchProofError("incomplete result set");
  return products.filter((product) => matchesBrand(product.title, brand)).map((product) => ({
    domain: OZERKI_DOMAIN,
    platform: OZERKI_DOMAIN,
    listingId: product.id,
    brand,
    url: product.url,
    title: product.title,
    metadata: { discovery: "ozerki-complete-search" }
  }));
}

export class OzerkiAdapter extends AdditionalPharmacyAdapter {
  readonly id = "ozerki.ru:family-reviews-v1";
  readonly supportedDomains = [OZERKI_DOMAIN, `www.${OZERKI_DOMAIN}`] as const;

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const refs = await this.discover("АкваОптик", { ...context, previousIds: [], previousRefs: [] });
      return refs.length
        ? { ok: true, checkedAt, message: `${OZERKI_DOMAIN}: fixed exact family canary is available` }
        : { ok: false, checkedAt, message: `${OZERKI_DOMAIN}: fixed family canary returned no products` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const boundedProducts = OZERKI_BOUNDED_PRODUCTS.filter((product) =>
      normalizeText(product.brand) === normalizeText(brand)
    );
    if (boundedProducts.length) {
      const refs = historicalRefs(OZERKI_DOMAIN, brand, context, ozerkiProductRef);
      for (const product of boundedProducts) {
        refs.set(product.id, {
          domain: OZERKI_DOMAIN,
          platform: OZERKI_DOMAIN,
          listingId: product.id,
          brand,
          url: product.url,
          title: product.title,
          metadata: { discovery: "ozerki-bounded-exact-product" }
        });
      }
      return [...refs.values()].sort((left, right) => left.listingId.localeCompare(right.listingId));
    }

    const previous = historicalRefs(OZERKI_DOMAIN, brand, context, ozerkiFamilyRef);
    let missingPage: AdapterBlockedError | undefined;
    for (const slug of transliteratedSlugs(brand)) {
      const initial = slug[0];
      if (!initial) continue;
      const source = new URL(`https://${OZERKI_DOMAIN}/alphabet/${initial}/${slug}/`);
      let page: HtmlPage;
      try {
        page = await requestPage(source, context, this.fetchImpl);
      } catch (error) {
        if (ozerkiMissingFamilyPage(error)) {
          missingPage = error;
          continue;
        }
        throw error;
      }
      const title = compactText(page.$("h1").first().text());
      if (!matchesBrand(title, brand)) {
        throw new ParserChangedError(`${OZERKI_DOMAIN}: exact family page is not bound to ${brand}`);
      }
      const parsed = ozerkiFamilyRef(source.toString());
      if (!parsed) throw new ParserChangedError(`${OZERKI_DOMAIN}: invalid exact family URL`);
      const feedback = page.$("#feedbackAnchor");
      const aggregate = feedback.find("[itemprop='aggregateRating']");
      if (aggregate.length === 0 && page.$("[itemprop='aggregateRating']").length === 0) {
        return discoverOzerkiSearch(brand, context, this.fetchImpl);
      }
      if (feedback.length !== 1 || aggregate.length !== 1 ||
          exactInteger(aggregate.find("meta[itemprop='reviewCount']").first().attr("content")) === undefined ||
          exactInteger(aggregate.find("meta[itemprop='ratingCount']").first().attr("content")) === undefined ||
          exactRating(aggregate.find("meta[itemprop='ratingValue']").first().attr("content")) === undefined ||
          feedback.find("[itemprop='review']").length === 0) {
        throw new ParserChangedError(`${OZERKI_DOMAIN}: exact family feedback proof is incomplete`);
      }
      previous.set(parsed.id, {
        domain: OZERKI_DOMAIN,
        platform: OZERKI_DOMAIN,
        listingId: parsed.id,
        brand,
        url: parsed.url,
        title,
        metadata: { discovery: "ozerki-exact-family-page" }
      });
      return [...previous.values()];
    }
    if (missingPage) return discoverOzerkiSearch(brand, context, this.fetchImpl);
    throw new ParserChangedError(`${OZERKI_DOMAIN}: no bounded family slug for ${brand}`);
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const searchBoundId = ref.metadata.discovery === "ozerki-complete-search";
    const productRef = ozerkiProductRef(ref.url, ref.listingId, searchBoundId);
    if (productRef) {
      const page = await requestPage(new URL(productRef.url), context, this.fetchImpl);
      const canonicalLinks = page.$("link[rel='canonical'][href]");
      const canonicalRef = canonicalLinks.length === 1
        ? ozerkiCanonicalProductRef(canonicalLinks.first().attr("href"), productRef.id, searchBoundId)
        : undefined;
      if (!canonicalRef || canonicalRef.url !== productRef.url) {
        throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: exact product canonical is missing or changed`);
      }

      const products = jsonLdProducts(page.$).filter((item) => String(item.sku ?? "") === productRef.id);
      if (products.length !== 1) {
        const fallbackTitle = compactText(ref.title ?? page.$("h1").first().text());
        if (products.length === 0 && matchesBrand(fallbackTitle, ref.brand) &&
          ozerkiProductEmptyReviewProof(page, {
            id: productRef.id,
            title: fallbackTitle,
            url: productRef.url,
            brand: ref.brand
          })) {
          return observation(this.evidence, ref, page, {
            domain: OZERKI_DOMAIN,
            title: fallbackTitle,
            canonicalUrl: productRef.url,
            reviews: 0,
            rating: null,
            ratingCount: 0,
            source: "ozerki-next-data-product-empty-state",
            productEvidence: titleProductEvidence(
              fallbackTitle,
              { type: "product_id", value: productRef.id },
              productRef.url
            )
          });
        }
        throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: exact Product JSON-LD is missing or ambiguous`);
      }
      const product = products[0];
      const structuredUrl = ozerkiCanonicalProductRef(
        typeof product.url === "string" ? product.url : undefined,
        productRef.id,
        searchBoundId
      );
      const title = compactText(String(product.name ?? ""));
      const heading = compactText(page.$("h1").first().text());
      if (!structuredUrl || structuredUrl.url !== productRef.url ||
        !matchesBrand(title, ref.brand) || !matchesBrand(heading, ref.brand)) {
        throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: Product JSON-LD is not bound to the exact product`);
      }

      const aggregate = product.aggregateRating;
      if (!aggregate || typeof aggregate !== "object") {
        if (!ozerkiProductEmptyReviewProof(page, {
          id: productRef.id,
          title,
          url: productRef.url,
          brand: ref.brand
        })) {
          throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: source-bound product aggregate is missing`);
        }
        return observation(this.evidence, ref, page, {
          domain: OZERKI_DOMAIN,
          title,
          canonicalUrl: productRef.url,
          reviews: 0,
          rating: null,
          ratingCount: 0,
          source: "ozerki-visible-product-empty-state",
          productEvidence: titleProductEvidence(
            title,
            { type: "product_id", value: productRef.id },
            productRef.url
          )
        });
      }
      const record = aggregate as Record<string, unknown>;
      const reviews = exactInteger(record.reviewCount);
      const ratingCount = exactInteger(record.ratingCount);
      const value = exactRating(record.ratingValue);
      if (record["@type"] !== "AggregateRating" || reviews === undefined || ratingCount === undefined ||
        value === undefined || reviews === 0 || ratingCount === 0) {
        throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: product feedback proof is incomplete`);
      }

      return observation(this.evidence, ref, page, {
        domain: OZERKI_DOMAIN,
        title,
        canonicalUrl: productRef.url,
        reviews,
        rating: value,
        ratingCount,
        source: "ozerki-product-aggregate-jsonld",
        productEvidence: titleProductEvidence(
          title,
          { type: "product_id", value: productRef.id },
          productRef.url
        )
      });
    }

    const parsedRef = ozerkiFamilyRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: invalid family or product URL or ID`);
    const page = await requestPage(new URL(parsedRef.url), context, this.fetchImpl);
    const title = compactText(page.$("h1").first().text());
    if (!matchesBrand(title, ref.brand)) {
      throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: family brand changed`);
    }
    const feedback = page.$("#feedbackAnchor");
    const aggregate = feedback.find("[itemprop='aggregateRating']");
    if (feedback.length !== 1 || aggregate.length !== 1) {
      throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: source-bound family aggregate is missing`);
    }
    const reviews = exactInteger(aggregate.find("meta[itemprop='reviewCount']").first().attr("content"));
    const ratingCount = exactInteger(aggregate.find("meta[itemprop='ratingCount']").first().attr("content"));
    const value = exactRating(aggregate.find("meta[itemprop='ratingValue']").first().attr("content"));
    if (reviews === undefined || ratingCount === undefined || value === undefined ||
      reviews === 0 || ratingCount === 0 || feedback.find("[itemprop='review']").length === 0) {
      throw new ParserChangedError(`${OZERKI_DOMAIN}:${ref.listingId}: family feedback proof is incomplete`);
    }
    return observation(this.evidence, ref, page, {
      domain: OZERKI_DOMAIN,
      title,
      canonicalUrl: parsedRef.url,
      reviews,
      rating: value,
      ratingCount,
      source: "ozerki-family-aggregate-microdata",
      aggregateGroupId: `ozerki:family:${parsedRef.id}`,
      productEvidence: {
        ...extractPageProductEvidence(page.html, parsedRef.url, ref.brand, { forceFamily: true }),
        scope: "product_family"
      }
    });
  }
}

export function createAdditionalPharmacyAdapters(evidence: EvidenceStore, fetchImpl?: typeof fetch): SiteAdapter[] {
  return [
    new AptekaRuAdapter(evidence, fetchImpl),
    new NfAptekaAdapter(evidence, fetchImpl),
    new BudZdorovAdapter(evidence, fetchImpl),
    new OzerkiAdapter(evidence, fetchImpl),
    new AptekaAprilAdapter(evidence, fetchImpl)
  ];
}
