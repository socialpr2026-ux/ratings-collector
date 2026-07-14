import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand } from "../utils/normalize.js";
import { titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { canonicalizeUrl } from "../utils/urls.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "med-otzyv.ru";
const PRODUCT_PATH = /^\/lekarstva\/\d+-[a-z0-9-]+\/(\d+)-[a-z0-9-]+\/?$/i;

function compact(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function searchUrl(brand: string): string {
  const result = new URL(`https://${DOMAIN}/__external_search__`);
  result.searchParams.set("brand", brand);
  return result.toString();
}

function parsedProduct(value: string): { id: string; url: string } | undefined {
  try {
    let target = new URL(value, "https://html.duckduckgo.com/");
    const redirected = target.searchParams.get("uddg");
    if (redirected) target = new URL(redirected);
    const match = target.pathname.match(PRODUCT_PATH);
    if (target.protocol !== "https:" || target.hostname.replace(/^www\./, "") !== DOMAIN || !match) return undefined;
    target.search = "";
    target.hash = "";
    return { id: match[1], url: canonicalizeUrl(target.toString()) };
  } catch {
    return undefined;
  }
}

function reviewsFromTitle(title: string): number | undefined {
  const value = title.match(/(?:-|—)\s*([\d\s\u00a0\u202f]+)\s+отзыв(?:а|ов)?\s+(?:врачей|пациентов)/iu)?.[1] ??
    title.match(/([\d\s\u00a0\u202f]+)\s+отзыв(?:а|ов)?\s+(?:врачей|пациентов)/iu)?.[1];
  if (!value) return undefined;
  const parsed = Number(value.replace(/[\s\u00a0\u202f]/g, ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function requestSearch(brand: string, context: AdapterContext, fetchImpl: typeof fetch): Promise<{ html: string; status: number }> {
  let response: Response;
  try {
    response = await safeFetch(searchUrl(brand), { signal: context.signal }, context.fetch ?? fetchImpl, 2, 45_000);
  } catch (error) {
    throw new AdapterBlockedError(`${DOMAIN}: external discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = await readTextBounded(response, 2_000_000, 45_000);
  if (!response.ok || /captcha|anomaly-modal|access denied/i.test(html.slice(0, 100_000))) {
    throw new AdapterBlockedError(`${DOMAIN}: external discovery is unavailable (HTTP ${response.status})`);
  }
  return { html, status: response.status };
}

export class MedOtzyvAdapter implements SiteAdapter {
  readonly id = "med-otzyv:exact-index-v1";
  readonly supportedDomains = [DOMAIN] as const;

  constructor(private readonly evidence: EvidenceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const refs = await this.discover("Оциллококцинум", { ...context, previousIds: [], previousRefs: [] });
      const exact = refs.find((ref) => ref.listingId === "34740" &&
        typeof ref.metadata.reviewCount === "number" && Number.isSafeInteger(ref.metadata.reviewCount) && ref.metadata.reviewCount >= 0);
      return exact
        ? { ok: true, checkedAt, message: `${DOMAIN}: exact indexed canary reviewCount=${exact.metadata.reviewCount}` }
        : { ok: false, checkedAt, message: `${DOMAIN}: exact indexed canary changed` };
    } catch (error) {
      return { ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const { html } = await requestSearch(brand, context, this.fetchImpl);
    const $ = load(html);
    const refs = new Map<string, ProductRef>();
    $("a.result__a[href]").each((_index, node) => {
      const title = compact($(node).text());
      const href = $(node).attr("href");
      const product = href ? parsedProduct(href) : undefined;
      const reviewCount = reviewsFromTitle(title);
      // Search snippets and review bodies may mention another medicine. Only
      // an exact result title bound to a stable med-otzyv medicine URL counts.
      if (!product || reviewCount === undefined || !matchesBrand(title.split(/\s+(?:-|—)\s+\d/)[0] ?? title, brand)) return;
      refs.set(product.id, {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId: product.id,
        brand,
        url: product.url,
        title: title.replace(/\s+(?:-|—)\s+\d[\d\s\u00a0\u202f]*\s+отзыв[а-яё\s]+$/iu, "").trim(),
        metadata: { source: "med-otzyv-exact-index", reviewCount, proofTitle: title }
      });
    });
    for (const previous of context.previousRefs ?? []) {
      const product = parsedProduct(previous.url);
      if (!product || product.id !== previous.listingId || refs.has(product.id)) continue;
      // A historical page cannot be refreshed from an inaccessible origin
      // without a current exact indexed metric, so it must fail closed later.
      refs.set(product.id, {
        domain: DOMAIN, platform: DOMAIN, listingId: product.id, brand, url: product.url,
        metadata: { source: "historical-registry" }
      });
    }
    if (!refs.size) {
      // DuckDuckGo's empty page does not prove that the first-party site has no
      // product. Never convert this situation to no_results or zero.
      throw new AdapterBlockedError(`${DOMAIN}: exact indexed discovery found no verifiable product; absence is not proven`);
    }
    return [...refs.values()];
  }

  async collect(ref: ProductRef): Promise<Observation> {
    const product = parsedProduct(ref.url);
    const reviewCount = ref.metadata.reviewCount;
    const proofTitle = ref.metadata.proofTitle;
    const title = ref.title ? compact(ref.title) : "";
    if (!product || product.id !== ref.listingId || !title || !matchesBrand(title, ref.brand) ||
      typeof reviewCount !== "number" || !Number.isSafeInteger(reviewCount) || reviewCount < 0 ||
      typeof proofTitle !== "string" || reviewsFromTitle(proofTitle) !== reviewCount) {
      throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: exact indexed product proof is incomplete`);
    }
    const capturedAt = new Date().toISOString();
    const productEvidence = {
      ...titleProductEvidence(title, { type: "product_id" as const, value: ref.listingId }, product.url),
      scope: "product_family" as const
    };
    const proof = JSON.stringify({ listingId: ref.listingId, url: product.url, title, reviewCount, proofTitle });
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: product.url,
      status: 200,
      bodyDigest: createHash("sha256").update(proof).digest("hex"),
      parsed: { listingId: ref.listingId, title, reviews: reviewCount, rating: null },
      productEvidence,
      source: "med-otzyv-exact-index"
    });
    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: product.url,
      product: title,
      reviews: reviewCount,
      rating: null,
      rawRating: 0,
      rawRatingScale: 5,
      ratingUnavailable: reviewCount > 0 || undefined,
      status: reviewCount === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      productEvidence,
      source: "med-otzyv-exact-index"
    };
  }
}
