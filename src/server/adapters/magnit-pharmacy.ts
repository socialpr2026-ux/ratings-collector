import { createHash } from "node:crypto";
import type { AdapterContext, AdapterHealth, Observation, ProductEvidence, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { aliasesForBrand, matchesBrand, normalizeText } from "../utils/normalize.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "apteka.magnit.ru";
const ORIGIN = `https://${DOMAIN}`;
const SITEMAP_INDEX_URL = `${ORIGIN}/sitemap_index.xml`;
const PRODUCT_SITEMAP_PATH = /^\/sitemap-parts\/products-\d+\.xml$/u;
const PRODUCT_PATH = /^\/product\/(\d+)(?:-[^/?#]+)?\/?$/u;
const PRODUCT_API_STORE = "shop_group_location_1_distr";
const MIN_PRODUCT_URLS = 15_000;
const MAX_INDEX_BYTES = 1_000_000;
const MAX_SITEMAP_BYTES = 8_000_000;
const MAX_PRODUCT_BYTES = 1_000_000;
const BLOCK_MARKERS = /captcha|access denied|forbidden|qrator|temporarily unavailable/i;

const BIVIART = "\u0431\u0438\u0432\u0438\u0430\u0440\u0442";
const OKUSALIN = "\u043e\u043a\u0443\u0441\u0430\u043b\u0438\u043d";
const OFTARINT = "\u043e\u0444\u0442\u0430\u0440\u0438\u043d\u0442";
const TAUSTIN = "\u0442\u0430\u0443\u0441\u0442\u0438\u043d";

const EXPECTED_IDS = new Map<string, readonly string[]>([
  [BIVIART, ["1000507431", "1000509450", "1000510348"]],
  [OKUSALIN, ["1000341873"]],
  [OFTARINT, ["1000441301"]],
  [TAUSTIN, ["1000273881"]]
]);

const HEALTH_CANARY = { brand: TAUSTIN, id: "1000273881" } as const;

type CatalogProduct = {
  id: string;
  url: string;
  sitemapUrl: string;
};

type CatalogSnapshot = {
  products: ReadonlyMap<string, CatalogProduct>;
  sitemapUrls: readonly string[];
};

type ProductPayload = {
  id: string;
  name: string;
  seoCode: string;
  storeCode: string;
  isMissing: boolean;
  ratings: unknown;
};

type ProductMetrics = {
  rating: number | null;
  scoresCount: number;
  commentsCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeRating(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 5 ? value : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function xmlLocations(xml: string, root: "sitemapindex" | "urlset", sourceUrl: string): string[] {
  const withoutComments = xml.replace(/<!--[^]*?-->/gu, "").trim();
  if (BLOCK_MARKERS.test(withoutComments) ||
      !new RegExp(`^<\\?xml[^>]*>\\s*(?:<\\?xml-stylesheet[^>]*>\\s*)?<${root}\\b`, "iu").test(withoutComments) ||
      !new RegExp(`</${root}>\\s*$`, "iu").test(withoutComments)) {
    throw new ParserChangedError(`${DOMAIN}: incomplete or non-XML sitemap at ${sourceUrl}`);
  }
  const locations = [...withoutComments.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/giu)]
    .map((match) => decodeXml(match[1] ?? "").trim())
    .filter(Boolean);
  if (locations.length === 0) throw new ParserChangedError(`${DOMAIN}: sitemap has no locations at ${sourceUrl}`);
  return locations;
}

function canonicalProduct(value: string): { id: string; url: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLocaleLowerCase("en-US") !== DOMAIN) return undefined;
    const id = url.pathname.match(PRODUCT_PATH)?.[1];
    if (!id) return undefined;
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/u, "");
    return { id, url: url.toString() };
  } catch {
    return undefined;
  }
}

function transliterate(value: string): string {
  const map: Record<string, string> = {
    "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d", "\u0435": "e", "\u0451": "e",
    "\u0436": "zh", "\u0437": "z", "\u0438": "i", "\u0439": "y", "\u043a": "k", "\u043b": "l", "\u043c": "m",
    "\u043d": "n", "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t", "\u0443": "u",
    "\u0444": "f", "\u0445": "h", "\u0446": "c", "\u0447": "ch", "\u0448": "sh", "\u0449": "sch", "\u044a": "",
    "\u044b": "y", "\u044c": "", "\u044d": "e", "\u044e": "yu", "\u044f": "ya"
  };
  return normalizeText(value).split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function brandSlugs(brand: string): string[] {
  return [...new Set(aliasesForBrand(brand).map(transliterate).filter(Boolean))];
}

function normalizedPath(value: string): string {
  return new URL(value).pathname.toLocaleLowerCase("en-US").replace(/[_-]+/gu, "-");
}

function productPayload(value: unknown, listingId: string): ProductPayload {
  if (!isRecord(value)) throw new ParserChangedError(`${DOMAIN}:${listingId}: product API returned non-object JSON`);
  const id = typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const seoCode = typeof value.seoCode === "string" ? value.seoCode.trim() : "";
  const storeCode = typeof value.storeCode === "string" ? value.storeCode : "";
  const isMissing = value.isMissing === true;
  if (id !== listingId || !name || !seoCode || storeCode !== PRODUCT_API_STORE || isMissing) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: product API identity changed`);
  }
  return { id, name, seoCode, storeCode, isMissing, ratings: value.ratings };
}

function productMetrics(value: unknown, listingId: string): ProductMetrics | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new ParserChangedError(`${DOMAIN}:${listingId}: malformed product rating aggregate`);
  if (value.external !== null && value.external !== false && value.external !== undefined) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: external or store-level rating aggregate rejected`);
  }
  const scoresCount = safeInteger(value.scoresCount);
  const commentsCount = safeInteger(value.commentsCount);
  if (scoresCount === undefined || commentsCount === undefined || commentsCount > scoresCount) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: invalid scoresCount/commentsCount aggregate`);
  }
  if (scoresCount === 0) {
    if (commentsCount !== 0 || value.rating !== null && value.rating !== 0 && value.rating !== undefined) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: zero aggregate contradicts its rating`);
    }
    return { rating: null, scoresCount, commentsCount };
  }
  const rating = safeRating(value.rating);
  if (rating === undefined) throw new ParserChangedError(`${DOMAIN}:${listingId}: positive aggregate has no valid rating`);
  return { rating, scoresCount, commentsCount };
}

function productEvidence(title: string, listingId: string, url: string): ProductEvidence {
  return {
    scope: "listing",
    signals: [
      { source: "title", text: title },
      { source: "url", text: url }
    ],
    variants: [],
    identifiers: [{ type: "product_id", value: listingId }],
    imageUrls: [],
    instructionUrls: []
  };
}

export class MagnitPharmacyAdapter implements SiteAdapter {
  readonly id = DOMAIN;
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;
  private readonly catalogCache = new Map<string, Promise<CatalogSnapshot>>();

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const catalog = await this.catalog(context);
      const canary = catalog.products.get(HEALTH_CANARY.id);
      if (!canary) throw new ParserChangedError(`${DOMAIN}: health canary disappeared from the complete sitemap`);
      const { payload } = await this.fetchProduct(canary, context);
      if (!matchesBrand(payload.name, HEALTH_CANARY.brand)) {
        throw new ParserChangedError(`${DOMAIN}: health canary changed product identity`);
      }
      const metrics = productMetrics(payload.ratings, canary.id);
      if (!metrics || metrics.scoresCount === 0) {
        throw new ParserChangedError(`${DOMAIN}: health canary lost its product rating aggregate`);
      }
      return {
        ok: true,
        checkedAt,
        message: `${DOMAIN}: complete sitemap and source-bound product API are healthy`
      };
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
    const catalog = await this.catalog(context);
    const normalizedBrand = normalizeText(brand);
    const expectedIds = EXPECTED_IDS.get(normalizedBrand) ?? [];
    const slugs = brandSlugs(brand);
    const candidates = new Map<string, CatalogProduct>();

    for (const product of catalog.products.values()) {
      const path = normalizedPath(product.url);
      if (slugs.some((slug) => path.includes(slug.replace(/[_-]+/gu, "-")))) candidates.set(product.id, product);
    }
    for (const id of expectedIds) {
      const product = catalog.products.get(id);
      if (!product) throw new ParserChangedError(`${DOMAIN}: expected ${normalizedBrand} SKU ${id} is absent from the complete sitemap`);
      candidates.set(id, product);
    }

    const refs = (await Promise.all([...candidates.values()].map(async (product) => {
      const { payload } = await this.fetchProduct(product, context);
      if (!matchesBrand(payload.name, brand)) return undefined;
      return {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId: product.id,
        brand,
        url: product.url,
        title: payload.name,
        metadata: {
          discovery: "magnit-complete-sitemap+product-api",
          sitemapUrl: product.sitemapUrl,
          productApiStore: PRODUCT_API_STORE
        }
      } satisfies ProductRef;
    }))).filter((ref): ref is NonNullable<typeof ref> => ref !== undefined);

    const discoveredIds = new Set(refs.map((ref) => ref.listingId));
    for (const id of expectedIds) {
      if (!discoveredIds.has(id)) {
        throw new ParserChangedError(`${DOMAIN}: expected ${normalizedBrand} SKU ${id} failed exact product identity validation`);
      }
    }
    return refs.sort((left, right) =>
      (left.title ?? "").localeCompare(right.title ?? "", "ru") || left.listingId.localeCompare(right.listingId)
    );
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = canonicalProduct(ref.url);
    if (!parsedRef || parsedRef.id !== ref.listingId) {
      throw new ParserChangedError(`${DOMAIN}: invalid product reference ${ref.listingId}`);
    }
    const capturedAt = new Date().toISOString();
    const { payload, body, status, apiUrl } = await this.fetchProduct({
      id: parsedRef.id,
      url: parsedRef.url,
      sitemapUrl: typeof ref.metadata.sitemapUrl === "string" ? ref.metadata.sitemapUrl : SITEMAP_INDEX_URL
    }, context);
    if (!matchesBrand(payload.name, ref.brand)) {
      throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: exact product belongs to another brand`);
    }

    const exactProductEvidence = productEvidence(payload.name, parsedRef.id, parsedRef.url);
    let metrics: ProductMetrics | undefined;
    let metricError: ParserChangedError | undefined;
    try { metrics = productMetrics(payload.ratings, parsedRef.id); }
    catch (error) {
      if (!(error instanceof ParserChangedError)) throw error;
      metricError = error;
    }
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: parsedRef.url,
      apiUrl,
      status,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
      parsed: {
        listingId: parsedRef.id,
        title: payload.name,
        ratings: metrics ?? null,
        metricError: metricError?.message ?? (payload.ratings == null ? "missing product rating aggregate" : undefined)
      },
      productEvidence: exactProductEvidence,
      source: "magnit-pharmacy-first-party-api"
    });

    if (!metrics || metricError) {
      return {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId: parsedRef.id,
        brand: ref.brand,
        canonicalUrl: parsedRef.url,
        product: payload.name,
        reviews: null,
        writtenReviewCount: null,
        rating: null,
        ratingCount: null,
        status: "parser_changed",
        capturedAt,
        evidenceRef,
        productEvidence: exactProductEvidence,
        source: "magnit-pharmacy-first-party-api:no-product-aggregate"
      };
    }

    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: parsedRef.id,
      brand: ref.brand,
      canonicalUrl: parsedRef.url,
      product: payload.name,
      reviews: metrics.scoresCount,
      writtenReviewCount: metrics.commentsCount,
      rating: metrics.rating,
      rawRating: metrics.rating,
      rawRatingScale: 5,
      ratingCount: metrics.scoresCount,
      status: metrics.scoresCount === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence: exactProductEvidence,
      source: "magnit-pharmacy-first-party-api"
    };
  }

  private catalog(context: AdapterContext): Promise<CatalogSnapshot> {
    const key = context.runId ?? "standalone";
    const cached = this.catalogCache.get(key);
    if (cached) return cached;
    const pending = this.loadCatalog(context).catch((error) => {
      this.catalogCache.delete(key);
      throw error;
    });
    this.catalogCache.set(key, pending);
    return pending;
  }

  private async loadCatalog(context: AdapterContext): Promise<CatalogSnapshot> {
    const index = await this.fetchText(SITEMAP_INDEX_URL, MAX_INDEX_BYTES, context, "application/xml,text/xml");
    const sitemapUrls = xmlLocations(index.body, "sitemapindex", SITEMAP_INDEX_URL).filter((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === DOMAIN && PRODUCT_SITEMAP_PATH.test(url.pathname);
      } catch { return false; }
    });
    if (sitemapUrls.length === 0) throw new ParserChangedError(`${DOMAIN}: sitemap index has no product sitemap`);

    const products = new Map<string, CatalogProduct>();
    for (const sitemapUrl of sitemapUrls) {
      const sitemap = await this.fetchText(sitemapUrl, MAX_SITEMAP_BYTES, context, "application/xml,text/xml");
      for (const location of xmlLocations(sitemap.body, "urlset", sitemapUrl)) {
        const parsed = canonicalProduct(location);
        if (!parsed) continue;
        const previous = products.get(parsed.id);
        if (previous && previous.url !== parsed.url) {
          throw new ParserChangedError(`${DOMAIN}: duplicate product ID ${parsed.id} has conflicting sitemap URLs`);
        }
        products.set(parsed.id, { ...parsed, sitemapUrl });
      }
    }
    if (products.size < MIN_PRODUCT_URLS) {
      throw new ParserChangedError(`${DOMAIN}: product sitemap is incomplete (${products.size} < ${MIN_PRODUCT_URLS})`);
    }
    for (const [brand, ids] of EXPECTED_IDS) {
      for (const id of ids) {
        if (!products.has(id)) throw new ParserChangedError(`${DOMAIN}: complete sitemap lost ${brand} SKU ${id}`);
      }
    }
    return { products, sitemapUrls };
  }

  private async fetchProduct(
    product: CatalogProduct,
    context: AdapterContext
  ): Promise<{ payload: ProductPayload; body: string; status: number; apiUrl: string }> {
    const apiUrl = `${ORIGIN}/webgate/v2/goods/${product.id}/stores/${PRODUCT_API_STORE}?storetype=apteka&catalogtype=3`;
    const response = await this.fetchText(apiUrl, MAX_PRODUCT_BYTES, context, "application/json");
    let json: unknown;
    try { json = JSON.parse(response.body); }
    catch { throw new ParserChangedError(`${DOMAIN}:${product.id}: product API returned invalid JSON`); }
    return { payload: productPayload(json, product.id), body: response.body, status: response.status, apiUrl };
  }

  private async fetchText(
    url: string,
    maxBytes: number,
    context: AdapterContext,
    accept: string
  ): Promise<{ body: string; status: number }> {
    let response: Response;
    try {
      response = await safeFetch(url, { headers: { accept }, signal: context.signal }, context.fetch ?? this.fetchImpl);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: string;
    try { body = await readTextBounded(response, maxBytes); }
    catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}: response could not be read for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok || [401, 403, 429, 498].includes(response.status) || response.status >= 500 || BLOCK_MARKERS.test(body.slice(0, 10_000))) {
      throw new AdapterBlockedError(`${DOMAIN}: blocked response HTTP ${response.status} for ${url}`);
    }
    return { body, status: response.status };
  }
}
