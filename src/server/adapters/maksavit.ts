import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { matchesBrand, normalizeText } from "../utils/normalize.js";
import { titleProductEvidence } from "../utils/product-evidence.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "maksavit.ru";
const ORIGIN = `https://${DOMAIN}`;
const TRANSLATE_ORIGIN = "https://maksavit-ru.translate.goog";
const MAX_DOCUMENT_BYTES = 4_000_000;
const PRODUCT_PATH = /^\/catalog\/(\d+)\/?$/u;
const BLOCK_MARKERS = /captcha|access denied|forbidden|too many requests|service unavailable|доступ\s+(?:ограничен|запрещен)|проверка\s+браузера|слишком\s+много\s+запросов/iu;
const ACCESS_STATUSES = new Set([400, 401, 403, 429, 498]);

const EXPECTED_IDS = new Map<string, readonly string[]>([
  [normalizeText("Бивиарт"), ["854959", "854538", "945500", "854961"]],
  [normalizeText("Кагоцел"), ["2337", "128266", "512741"]],
  [normalizeText("Окусалин"), ["142672", "126170"]],
  [normalizeText("Офтаринт"), ["555978"]],
  [normalizeText("Таустин"), ["149212"]],
  [normalizeText("Бактоблис"), ["826060", "935299", "823739", "879295", "862971", "893781", "142040"]],
  [normalizeText("Хлорэтта"), ["945425"]]
]);

type ProductPage = {
  body: string;
  canonicalUrl: string;
  requestUrl: string;
  status: number;
  title: string;
  ignoredTemplateAggregate: boolean;
  transport: "google_translate" | "yandex_translate" | "first_party_browser";
};

function transportSource(transport: ProductPage["transport"]): string {
  if (transport === "first_party_browser") return "first-party-browser";
  if (transport === "yandex_translate") return "yandex-translate";
  return "google-translate";
}

function compactText(value: string): string {
  return value.replace(/[\s\u00a0\u202f]+/gu, " ").trim();
}
function expectedIds(brand: string): readonly string[] | undefined {
  return EXPECTED_IDS.get(normalizeText(brand));
}

function sourceProductUrl(listingId: string): string {
  return `${ORIGIN}/catalog/${listingId}/`;
}

function translatedProductUrl(listingId: string): string {
  const url = new URL(`/catalog/${listingId}/`, TRANSLATE_ORIGIN);
  url.searchParams.set("_x_tr_sl", "ru");
  url.searchParams.set("_x_tr_tl", "en");
  url.searchParams.set("_x_tr_hl", "en");
  return url.toString();
}

function listingIdFromSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
    if (url.protocol !== "https:" || hostname !== DOMAIN || url.search || url.hash) return undefined;
    return url.pathname.match(PRODUCT_PATH)?.[1];
  } catch {
    return undefined;
  }
}

function isBlockedPage(html: string): boolean {
  const $ = load(html);
  const title = compactText($("title").first().text());
  return BLOCK_MARKERS.test(title) ||
    /<(?:iframe|form|input)\b[^>]*(?:captcha|challenge)/iu.test(html.slice(0, 200_000));
}

function parseProductPage(
  html: string,
  listingId: string,
  requestUrl: string,
  status: number,
  transport: ProductPage["transport"] = "google_translate"
): ProductPage {
  const $ = load(html);
  const canonicalHref = $("link[rel='canonical']").first().attr("href") ?? "";
  const openGraphHref = $("meta[property='og:url']").first().attr("content") ?? "";
  const canonicalId = listingIdFromSourceUrl(canonicalHref);
  const openGraphId = listingIdFromSourceUrl(openGraphHref);
  if (canonicalId !== listingId || openGraphId !== listingId) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: translated page is not source-bound to the exact product`);
  }

  const headings = $("h1");
  const title = compactText(headings.first().text());
  if (headings.length !== 1 || !title) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: exact product title is missing or ambiguous`);
  }

  const feedback = $("section#feedback");
  if (feedback.length !== 1) {
    throw new ParserChangedError(`${DOMAIN}:${listingId}: exact product feedback section is missing or ambiguous`);
  }
  const feedbackHeading = compactText(feedback.find("h2").first().text());
  const overview = feedback.find(".product-feedback-main__overview");
  const emptyAside = feedback.find(".product-feedback-aside--empty");
  const visibleState = compactText(overview.text());
  const reviewItems = feedback.find("[itemprop='review'], [data-review-id], .product-feedback-item, .feedback-item, .reviews-list li");
  const exactEmptyState = feedbackHeading === `Отзывы покупателей ${title}` &&
    overview.length === 1 &&
    /^Отзывы на препарат отсутствуют\.?$/iu.test(visibleState) &&
    emptyAside.length === 1 &&
    reviewItems.length === 0;
  if (!exactEmptyState) {
    throw new ParserChangedError(
      `${DOMAIN}:${listingId}: visible product section proved neither the strict empty state nor a supported feedback aggregate`
    );
  }

  return {
    body: html,
    canonicalUrl: sourceProductUrl(listingId),
    requestUrl,
    status,
    title,
    transport,
    // Maksavit currently emits a constant Product AggregateRating 5/1 even
    // beside the visible empty state. It is recorded only as rejected evidence.
    ignoredTemplateAggregate: /"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*5(?:\.0+)?[^}]*"reviewCount"\s*:\s*1[^}]*\}/iu.test(html) ||
      $("meta[name='ratings:ignored-template-aggregate'][content='5/1']").length === 1
  };
}

export class MaksavitAdapter implements SiteAdapter {
  readonly id = "pharmacy:maksavit:v1";
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;
  private readonly pages = new Map<string, Promise<ProductPage>>();

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    const requestedBrand = context.brands?.find((brand) => (expectedIds(brand)?.length ?? 0) > 0);
    const canaryBrand = requestedBrand ?? "Таустин";
    const canaryId = expectedIds(canaryBrand)?.[0] ?? "149212";
    try {
      // Bind the health request to an exact product from the employee's
      // requested brand. A blocked unrelated Taustin canary must not label a
      // Hloretta partition with the wrong product ID.
      const page = await this.page(canaryId, { ...context, runId: `${context.runId ?? "health"}:maksavit-health` });
      if (!matchesBrand(page.title, canaryBrand)) {
        throw new ParserChangedError(`${DOMAIN}:${canaryId}: health canary changed ${canaryBrand} product identity`);
      }
      return {
        ok: true,
        checkedAt,
        message: `${DOMAIN}: exact source-bound product and visible empty-review state are healthy`
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
    const ids = expectedIds(brand);
    if (!ids) {
      throw new ParserChangedError(`${DOMAIN}: brand ${brand} is outside the bounded exact registry`);
    }

    const pages = await Promise.all(ids.map((listingId) => this.page(listingId, context)));
    return pages.map((page, index) => {
      const listingId = ids[index];
      if (!matchesBrand(page.title, brand)) {
        throw new ParserChangedError(`${DOMAIN}:${listingId}: exact allowlisted product belongs to another brand`);
      }
      return {
        domain: DOMAIN,
        platform: DOMAIN,
        listingId,
        brand,
        url: page.canonicalUrl,
        title: page.title,
        metadata: {
          discovery: "maksavit-bounded-exact-allowlist",
          transport: page.transport,
          translatedUrl: page.requestUrl
        }
      };
    });
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const ids = expectedIds(ref.brand);
    if (!ids?.includes(ref.listingId) || listingIdFromSourceUrl(ref.url) !== ref.listingId) {
      throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: product reference is outside the bounded exact allowlist`);
    }

    const page = await this.page(ref.listingId, context);
    if (!matchesBrand(page.title, ref.brand)) {
      throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: exact product identity changed`);
    }

    const capturedAt = new Date().toISOString();
    const productEvidence = titleProductEvidence(
      page.title,
      { type: "product_id", value: ref.listingId },
      page.canonicalUrl
    );
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: page.canonicalUrl,
      transportUrl: page.requestUrl,
      status: page.status,
      bodyDigest: createHash("sha256").update(page.body).digest("hex"),
      parsed: {
        listingId: ref.listingId,
        title: page.title,
        canonicalUrl: page.canonicalUrl,
        reviews: 0,
        writtenReviewCount: 0,
        rating: null,
        ratingCount: 0,
        ignoredTemplateAggregate: page.ignoredTemplateAggregate
      },
      productEvidence,
      source: `maksavit-visible-product-feedback:${transportSource(page.transport)}`
    });

    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: ref.listingId,
      brand: ref.brand,
      canonicalUrl: page.canonicalUrl,
      product: page.title,
      reviews: 0,
      writtenReviewCount: 0,
      rating: null,
      rawRating: null,
      rawRatingScale: 5,
      ratingCount: 0,
      status: "no_reviews",
      capturedAt,
      evidenceRef,
      productEvidence,
      source: `maksavit-visible-product-feedback:${transportSource(page.transport)}`
    };
  }

  private page(listingId: string, context: AdapterContext): Promise<ProductPage> {
    const key = `${context.runId ?? "standalone"}\u0000${listingId}`;
    const cached = this.pages.get(key);
    if (cached) return cached;
    const pending = this.loadPage(listingId, context).catch((error) => {
      this.pages.delete(key);
      throw error;
    });
    this.pages.set(key, pending);
    return pending;
  }

  private async loadPage(listingId: string, context: AdapterContext): Promise<ProductPage> {
    const requestUrl = translatedProductUrl(listingId);
    let response: Response;
    try {
      response = await safeFetch(requestUrl, {
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: context.signal
      }, context.fetch ?? this.fetchImpl, 4, 60_000);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}:${listingId}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let html: string;
    try {
      html = await readTextBounded(response, MAX_DOCUMENT_BYTES, 60_000);
    } catch (error) {
      throw new AdapterBlockedError(`${DOMAIN}:${listingId}: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (ACCESS_STATUSES.has(response.status) || response.status >= 500 || isBlockedPage(html)) {
      throw new AdapterBlockedError(`${DOMAIN}:${listingId}: blocked response HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new ParserChangedError(`${DOMAIN}:${listingId}: unexpected product response HTTP ${response.status}`);
    }
    const source = response.headers.get("x-ratings-source");
    let transport: ProductPage["transport"] = "google_translate";
    let transportUrl = requestUrl;
    if (source === "maksavit-first-party-browser" || source === "maksavit-yandex-translate") {
      const finalUrl = response.headers.get("x-ratings-source-url") ?? "";
      if (listingIdFromSourceUrl(finalUrl) !== listingId) {
        throw new ParserChangedError(`${DOMAIN}:${listingId}: recovered response is not bound to the exact product URL`);
      }
      transport = source === "maksavit-first-party-browser" ? "first_party_browser" : "yandex_translate";
      transportUrl = finalUrl;
    }
    return parseProductPage(html, listingId, transportUrl, response.status, transport);
  }
}
