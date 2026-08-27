import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductEvidence,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import type { EvidenceStore } from "../evidence.js";
import { aliasesForBrand, matchesBrand, normalizeText } from "../utils/normalize.js";
import { readTextBounded, safeFetch } from "../utils/safe-fetch.js";
import { AdapterBlockedError, ParserChangedError } from "./errors.js";

const DOMAIN = "009.xn--p1ai";
const ORIGIN = `https://${DOMAIN}`;
const SITEMAP_INDEX = `${ORIGIN}/sitemap.xml`;
const FAMILY_REVIEW_PATH = /^\/kupit-([a-z0-9][a-z0-9_-]*)\/otzyvy\/?$/iu;
const PRODUCT_PATH = /^\/product\/[a-z0-9][a-z0-9_-]*\/?$/iu;
const MAX_INDEX_BYTES = 1_000_000;
const MAX_SHARD_BYTES = 10_000_000;
const MAX_HTML_BYTES = 2_500_000;
const MAX_SITEMAP_SHARDS = 24;
const MAX_BRAND_CANDIDATES = 40;
// The Agent fixed-egress scheduler permits two concurrent requests per host.
// Keep the adapter aligned so a third shard does not spend its 60-second
// transport budget waiting in the outer queue.
const SITEMAP_CONCURRENCY = 2;

export type Pharmacy009SnapshotProof = {
  indexSha256: string;
  indexLastModified: string;
  embeddedLastmods: readonly string[];
  shardUrls: readonly string[];
  shardSha256: readonly string[];
  shardLastModified: readonly string[];
  shardUrlCounts: readonly number[];
  familyRefCount: number;
  familyRefSetSha256: string;
  absencePredicateVersion: string;
};

// Immutable, source-bound absence proof captured from the complete 009 sitemap
// set. This is deliberately invalidated by any manifest, body, URL-count,
// Last-Modified calendar date, canonical-family-set, or predicate change. It never turns a
// transport/parser failure into absence: the current run must first reproduce
// every byte-level invariant below. 009 regenerates Last-Modified seconds
// while serving byte-identical sitemap bodies, so the strict source date is
// identity while the unstable time-of-day remains validator metadata. The
// cryptographic body hashes, exact manifest URLs/counts and canonical family
// set remain the authoritative proof and fail closed on any content change.
export const VERIFIED_PHARMACY009_HLORETTA_ABSENCE = {
  indexSha256: "32d8f2127834313a3df2a454681c6089d9b7e98a3ad73025815e94be0265084c",
  indexLastModified: "2026-08-23 08:00:05",
  embeddedLastmods: Array.from({ length: 7 }, () => "2026-08-23"),
  shardUrls: Array.from({ length: 7 }, (_value, index) => `${ORIGIN}/sitemap_${index}.xml`),
  shardSha256: [
    "b86e044dc194f8f04f11273c48885fd336f12129af82a51f5e5a42518cee5643",
    "dc58fbc7beb2860de94e9ce5c5a1ee38387e4290c1d6c70c3a1e998689281fd7",
    "21f3697f6502cbaabda97bb85b187ff8d6fffbbf6d4ca756866756d43ea78b95",
    "62a3a5845bafea02e9421bd397a6301baf78fa9497f9fbd75dbe7a1a6786345f",
    "82c5e520f6e5554522c847e65ff8984fb81c9163f8e42454b5572e95a86bde6a",
    "1220c0a073a1893eefb6f8657bc43a4ddfb1314424610e73d959cf544a72a5c8",
    "54985bdb99ad2f1bad557635e418a49e3e87883f4f5a7974eb574ea4c06fdc7f"
  ],
  shardLastModified: [
    "2026-08-23 08:00:03",
    "2026-08-23 08:00:03",
    "2026-08-23 08:00:04",
    "2026-08-23 08:00:04",
    "2026-08-23 08:00:04",
    "2026-08-23 08:00:05",
    "2026-08-23 08:00:05"
  ],
  shardUrlCounts: [50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 11_975],
  familyRefCount: 43_063,
  familyRefSetSha256: "7ed153120d516f7697bbe38fb062abd3dd25fef5e24580f9458818905dd3886e",
  absencePredicateVersion: "hloretta-cyrillic-h-kh-x-ch-single-double-t-v1"
} as const satisfies Pharmacy009SnapshotProof;

type SitemapEntry = { url: string; lastmod: string };
type FamilyReviewRef = { slug: string; url: string; listingId: string };
type ShardSnapshot = { refs: readonly FamilyReviewRef[]; urlCount: number };
type SitemapSnapshot = { refs: readonly FamilyReviewRef[]; proof: Pharmacy009SnapshotProof };
type HtmlPage = { html: string; $: CheerioAPI; status: number; requestedUrl: string };
type JsonObject = Record<string, unknown>;
type BrandSlugCandidate = { slug: string; allowFamilySuffix: boolean };

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function lastModifiedDate(value: string): string | undefined {
  return value.match(/^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}$/u)?.[1];
}

function sameLastModifiedDates(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const actual = lastModifiedDate(value);
    return actual !== undefined && actual === lastModifiedDate(right[index] ?? "");
  });
}

export function provesVerifiedPharmacy009Absence(brand: string, proof: Pharmacy009SnapshotProof): boolean {
  const expected = VERIFIED_PHARMACY009_HLORETTA_ABSENCE;
  return normalizeText(brand) === "хлорэтта" &&
    proof.indexSha256 === expected.indexSha256 &&
    lastModifiedDate(proof.indexLastModified) === lastModifiedDate(expected.indexLastModified) &&
    sameArray(proof.embeddedLastmods, expected.embeddedLastmods) &&
    sameArray(proof.shardUrls, expected.shardUrls) &&
    sameArray(proof.shardSha256, expected.shardSha256) &&
    sameLastModifiedDates(proof.shardLastModified, expected.shardLastModified) &&
    sameArray(proof.shardUrlCounts, expected.shardUrlCounts) &&
    proof.familyRefCount === expected.familyRefCount &&
    proof.familyRefSetSha256 === expected.familyRefSetSha256 &&
    proof.absencePredicateVersion === expected.absencePredicateVersion;
}

function compactText(value: string): string {
  return value.replace(/№/gu, "\uE000").normalize("NFKC").replace(/\uE000/gu, "№")
    .replace(/[\s\u00a0\u202f]+/gu, " ").trim();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizePharmacy009LastModified(headers: Headers): string {
  const value = headers.get("last-modified")?.trim();
  return value?.normalize("NFKC").replace(/\s+/gu, " ") ?? "";
}

function exactInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\s\u00a0\u202f]/gu, "");
  if (!/^\d+$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function exactRating(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = String(value).replace(/[\s\u00a0\u202f]/gu, "").replace(",", ".");
  if (!/^\d(?:\.\d+)?$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : undefined;
}

function normalizedHost(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/^www\./u, "");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/gu, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function listingIdForSlug(slug: string): string {
  const readable = `family-${slug}`;
  return readable.length <= 256
    ? readable
    : `family-${createHash("sha256").update(slug).digest("hex").slice(0, 32)}`;
}

function familyReviewRef(value: string, expectedId?: string): FamilyReviewRef | undefined {
  try {
    const parsed = new URL(value, ORIGIN);
    if (parsed.protocol !== "https:" || normalizedHost(parsed.hostname) !== DOMAIN || parsed.search || parsed.hash) return undefined;
    const slug = parsed.pathname.match(FAMILY_REVIEW_PATH)?.[1]?.toLocaleLowerCase("en-US");
    if (!slug) return undefined;
    const listingId = listingIdForSlug(slug);
    if (expectedId && expectedId !== listingId) return undefined;
    return { slug, listingId, url: `${ORIGIN}/kupit-${slug}/otzyvy` };
  } catch {
    return undefined;
  }
}

function transliterate(value: string, useTs: boolean, kha: "h" | "kh" | "x"): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: kha, ц: useTs ? "ts" : "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return value.toLocaleLowerCase("ru-RU").split("").map((character) => map[character] ?? character).join("")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function descriptorFreeBrand(brand: string): string | undefined {
  const value = compactText(brand).replace(/\s+р[\s‐‑‒–—−-]*р\.?$/iu, "").trim();
  return value && value !== compactText(brand) ? value : undefined;
}

function brandSlugCandidates(brand: string): BrandSlugCandidate[] {
  const values: BrandSlugCandidate[] = aliasesForBrand(brand).flatMap((alias) =>
    (["h", "kh", "x"] as const).flatMap((kha) => [
      { slug: transliterate(alias, false, kha), allowFamilySuffix: true },
      { slug: transliterate(alias, true, kha), allowFamilySuffix: true }
    ])
  );
  const descriptorFree = descriptorFreeBrand(brand);
  if (descriptorFree) {
    values.push(...(["h", "kh", "x"] as const).flatMap((kha) => [
      { slug: transliterate(descriptorFree, false, kha), allowFamilySuffix: false },
      { slug: transliterate(descriptorFree, true, kha), allowFamilySuffix: false }
    ]));
  }
  const unique = new Map<string, BrandSlugCandidate>();
  for (const candidate of values) {
    if (!candidate.slug) continue;
    const key = `${candidate.slug}:${candidate.allowFamilySuffix ? "family" : "exact"}`;
    unique.set(key, candidate);
  }
  return [...unique.values()];
}

function slugMatchesBrand(slug: string, brand: string): boolean {
  const normalized = slug.replace(/[_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return brandSlugCandidates(brand).some((candidate) =>
    normalized === candidate.slug || (candidate.allowFamilySuffix && normalized.startsWith(`${candidate.slug}-`))
  );
}

function familyTitleMatchesBrand(familyTitle: string, brand: string): boolean {
  if (matchesBrand(familyTitle, brand)) return true;
  const descriptorFree = descriptorFreeBrand(brand);
  return descriptorFree !== undefined && normalizeText(familyTitle) === normalizeText(descriptorFree);
}

function exactFamilyTitleMatchesBrand(familyTitle: string, brand: string): boolean {
  const normalizedTitle = normalizeText(familyTitle);
  if (aliasesForBrand(brand).some((alias) => normalizedTitle === normalizeText(alias))) return true;
  const descriptorFree = descriptorFreeBrand(brand);
  return descriptorFree !== undefined && normalizedTitle === normalizeText(descriptorFree);
}

function provesSolutionVariant(title: string): boolean {
  return normalizeText(title).split(" ").includes("раствор");
}

function publicationFamilyTitle(familyTitle: string, brand: string, variants: string[]): string {
  const descriptorFree = descriptorFreeBrand(brand);
  if (descriptorFree && normalizeText(familyTitle) === normalizeText(descriptorFree)) {
    if (!variants.length || !variants.every(provesSolutionVariant)) {
      throw new ParserChangedError(`${DOMAIN}: family variants do not prove exact solution-only scope for ${brand}`);
    }
    return compactText(brand);
  }
  return familyTitle;
}

function activeChallenge($: CheerioAPI): boolean {
  const title = compactText($("title").first().text());
  const heading = compactText($("h1").first().text());
  const visibleLabel = `${title} ${heading}`;
  return /captcha|access denied|forbidden|не робот|проверка браузера|подозрительная активность|доступ (?:ограничен|запрещен)/iu.test(visibleLabel) ||
    $("form[action*='captcha' i], [data-sitekey], .captcha-page, .challenge-page").length > 0;
}

function blockedStatus(status: number): boolean {
  return [401, 403, 408, 425, 429, 498, 499].includes(status) || status >= 500;
}

async function requestText(
  url: string,
  context: AdapterContext,
  fetchImpl: typeof fetch,
  maxBytes: number,
  accept: string,
  readableTerminalStatuses: readonly number[] = [],
  maxRedirects = 4
): Promise<{ text: string; status: number; requestedUrl: string; headers: Headers }> {
  let response: Response;
  try {
    response = await safeFetch(url, {
      signal: context.signal,
      headers: { accept, "accept-language": "ru-RU,ru;q=0.9,en;q=0.7" }
    }, context.fetch ?? fetchImpl, maxRedirects, 60_000);
  } catch (error) {
    throw new AdapterBlockedError(`${DOMAIN}: blocked: request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok && !readableTerminalStatuses.includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    const message = `${DOMAIN}: HTTP ${response.status} for ${new URL(url).pathname}`;
    if (blockedStatus(response.status)) throw new AdapterBlockedError(`${DOMAIN}: blocked: ${message}`);
    throw new ParserChangedError(message);
  }
  let text: string;
  try {
    text = await readTextBounded(response, maxBytes, 60_000);
  } catch (error) {
    throw new AdapterBlockedError(`${DOMAIN}: blocked: response could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { text, status: response.status, requestedUrl: url, headers: response.headers };
}

function assertXmlDocument(xml: string, root: "sitemapindex" | "urlset", source: string): void {
  const trimmed = xml.trim();
  const document = new RegExp(`^(?:<\\?xml[^>]*>\\s*)?<${root}\\b[^>]*>[\\s\\S]*<\\/${root}>$`, "u");
  if (!document.test(trimmed)) {
    const $ = load(xml);
    if (activeChallenge($)) throw new AdapterBlockedError(`${DOMAIN}: blocked: ${source} returned an active challenge`);
    throw new ParserChangedError(`${DOMAIN}: ${source} did not prove complete exact XML`);
  }
}

function parseSitemapIndex(xml: string): SitemapEntry[] {
  assertXmlDocument(xml, "sitemapindex", "sitemap index");
  const count = xml.match(/<sitemap(?=[\s>])/gu)?.length ?? 0;
  const closingCount = xml.match(/<\/sitemap>/gu)?.length ?? 0;
  const entries = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>\s*)?<\/sitemap>/gu)].map((match) => ({
    url: decodeXmlText(match[1]!.trim()),
    lastmod: compactText(match[2] ?? "")
  }));
  if (!count || count !== closingCount || count !== entries.length || entries.length > MAX_SITEMAP_SHARDS) {
    throw new ParserChangedError(`${DOMAIN}: sitemap index has an incomplete or unsupported shard list`);
  }
  const unique = new Set<string>();
  for (const entry of entries) {
    let parsed: URL;
    try { parsed = new URL(entry.url); }
    catch { throw new ParserChangedError(`${DOMAIN}: sitemap index contains an invalid shard URL`); }
    if (parsed.protocol !== "https:" || normalizedHost(parsed.hostname) !== DOMAIN || parsed.search || parsed.hash ||
      !/^\/sitemap_\d+\.xml$/u.test(parsed.pathname) || unique.has(parsed.toString())) {
      throw new ParserChangedError(`${DOMAIN}: sitemap index contains an unsafe or duplicate shard`);
    }
    unique.add(parsed.toString());
    entry.url = parsed.toString();
  }
  return entries;
}

function parseReviewRefsFromShard(xml: string, source: string): ShardSnapshot {
  assertXmlDocument(xml, "urlset", source);
  const urlCount = xml.match(/<url(?=[\s>])/gu)?.length ?? 0;
  const closingUrlCount = xml.match(/<\/url>/gu)?.length ?? 0;
  const locCount = xml.match(/<loc(?=[\s>])/gu)?.length ?? 0;
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => decodeXmlText(match[1]!.trim()));
  if (!urlCount || urlCount !== closingUrlCount || urlCount !== locCount || locCount !== locs.length) {
    throw new ParserChangedError(`${DOMAIN}: ${source} contains an incomplete URL list`);
  }
  const refs: FamilyReviewRef[] = [];
  for (const loc of locs) {
    let parsed: URL;
    try { parsed = new URL(loc); }
    catch { throw new ParserChangedError(`${DOMAIN}: ${source} contains an invalid URL`); }
    if (parsed.protocol !== "https:" || normalizedHost(parsed.hostname) !== DOMAIN || parsed.search || parsed.hash) {
      throw new ParserChangedError(`${DOMAIN}: ${source} contains an unsafe URL`);
    }
    const ref = familyReviewRef(parsed.toString());
    if (ref) refs.push(ref);
  }
  return { refs, urlCount };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(items.length);
  const batchSize = Math.max(1, concurrency);
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const settled = await Promise.allSettled(items.slice(offset, offset + batchSize).map(
      (item, batchIndex) => worker(item, offset + batchIndex)
    ));
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failure) throw failure.reason;
    for (let batchIndex = 0; batchIndex < settled.length; batchIndex += 1) {
      result[offset + batchIndex] = (settled[batchIndex] as PromiseFulfilledResult<R>).value;
    }
  }
  return result;
}

function jsonProducts(value: unknown, output: JsonObject[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) jsonProducts(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const item = value as JsonObject;
  const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
  if (types.includes("Product")) output.push(item);
  if (item["@graph"] !== undefined) jsonProducts(item["@graph"], output, depth + 1);
}

function productName(value: unknown): string {
  return typeof value === "string" ? compactText(value) : "";
}

function productBrand(value: unknown): string {
  if (typeof value === "string") return compactText(value);
  if (!value || typeof value !== "object") return "";
  return productName((value as JsonObject).name);
}

function visibleReviewCount(value: string): number | undefined {
  const match = compactText(value).match(/^Основано на ([\d\s\u00a0\u202f]+) отзыв[а-яё]*$/iu);
  return match ? exactInteger(match[1]) : undefined;
}

function exactVariants($: CheerioAPI, familyTitle: string, brand: string): string[] {
  const variants = new Map<string, string>();
  const descriptorFree = descriptorFreeBrand(brand);
  $(".drugReviews .reviewsList__drugName").each((_index, node) => {
    const href = $(node).attr("href");
    const title = compactText($(node).text());
    if (descriptorFree) {
      if (!href || !title || !matchesBrand(title, familyTitle)) {
        throw new ParserChangedError(`${DOMAIN}: descriptor family contains an unverified source-bound variant`);
      }
      let parsed: URL;
      try { parsed = new URL(href, ORIGIN); }
      catch { throw new ParserChangedError(`${DOMAIN}: descriptor family contains a malformed variant URL`); }
      if (parsed.protocol !== "https:" || normalizedHost(parsed.hostname) !== DOMAIN || parsed.search || parsed.hash ||
        !PRODUCT_PATH.test(parsed.pathname)) {
        throw new ParserChangedError(`${DOMAIN}: descriptor family contains an unsafe or unsupported variant URL`);
      }
      variants.set(normalizeText(title), title);
      return;
    }
    const brandMatch = title && matchesBrand(title, brand);
    if (!href || !title || !brandMatch || !matchesBrand(title, familyTitle)) return;
    try {
      const parsed = new URL(href, ORIGIN);
      if (parsed.protocol !== "https:" || normalizedHost(parsed.hostname) !== DOMAIN || parsed.search || parsed.hash ||
        !PRODUCT_PATH.test(parsed.pathname)) return;
      variants.set(normalizeText(title), title);
    } catch { /* ignore a malformed optional variant link */ }
  });
  if (variants.size > 500) {
    throw new ParserChangedError(`${DOMAIN}: family page has too many variants for exact bounded proof`);
  }
  return [...variants.values()];
}

function familyProductEvidence(
  canonicalUrl: string,
  listingId: string,
  familyTitle: string,
  variants: string[],
  structuredFamily: boolean
): ProductEvidence {
  const signals: ProductEvidence["signals"] = [
    { source: "title", text: familyTitle },
    ...(structuredFamily ? [{ source: "json_ld" as const, text: familyTitle }] : []),
    ...variants.map((text) => ({ source: "variant" as const, text })),
    { source: "url", text: canonicalUrl }
  ];
  return {
    scope: "product_family",
    signals: signals.slice(0, 40),
    variants: variants.slice(0, 30),
    identifiers: [{ type: "product_id", value: listingId }],
    imageUrls: [],
    instructionUrls: []
  };
}

function exactFamilyTitle($: CheerioAPI, parsedRef: FamilyReviewRef): string {
  const canonicalLinks = $("link[rel='canonical'][href]");
  const canonical = canonicalLinks.length === 1
    ? familyReviewRef(canonicalLinks.first().attr("href") ?? "", parsedRef.listingId)
    : undefined;
  if (!canonical || canonical.url !== parsedRef.url) {
    throw new ParserChangedError(`${DOMAIN}:${parsedRef.listingId}: exact family canonical is missing or changed`);
  }
  const headings = $("h1.reviewsPage__h1");
  const heading = compactText(headings.first().text());
  const familyTitle = heading.match(/^(.+?)\s+ОТЗЫВЫ$/iu)?.[1]?.trim() ?? "";
  if (headings.length !== 1 || !familyTitle) {
    throw new ParserChangedError(`${DOMAIN}:${parsedRef.listingId}: exact family review heading is missing or changed`);
  }
  return familyTitle;
}

export class Pharmacy009Adapter implements SiteAdapter {
  readonly id = `${DOMAIN}:sitemap-family-reviews-v1`;
  readonly supportedDomains = [DOMAIN, `www.${DOMAIN}`] as const;
  private readonly runSnapshots = new Map<string, Promise<SitemapSnapshot>>();
  private readonly snapshotBrands = new Map<string, Set<string>>();
  private readonly runPages = new Map<string, Promise<HtmlPage>>();

  constructor(private readonly evidence: EvidenceStore, private readonly fetchImpl: typeof fetch = fetch) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const snapshot = await this.snapshot({ ...context, previousIds: [], previousRefs: [] });
      return {
        ok: true,
        checkedAt,
        message: `${this.id}: complete sitemap found ${snapshot.refs.length} canonical family review page(s)`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        checkedAt,
        message: error instanceof AdapterBlockedError && !/^blocked\s*:/iu.test(message) ? `blocked: ${message}` : message
      };
    }
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    try {
      const snapshot = await this.snapshot(context);
      const candidates = snapshot.refs.filter((ref) => slugMatchesBrand(ref.slug, brand));
      if (!candidates.length) {
        if (provesVerifiedPharmacy009Absence(brand, snapshot.proof)) return [];
        return await this.discoverByExactBrandSlugs(brand, context);
      }
      if (candidates.length > MAX_BRAND_CANDIDATES) {
        throw new ParserChangedError(`${DOMAIN}: sitemap mapping for ${brand} is too broad for exact bounded proof`);
      }
      const proven = (await mapWithConcurrency(candidates, SITEMAP_CONCURRENCY, async (candidate) => {
        const page = await this.htmlPage(candidate.url, context);
        let keepForCollection = false;
        try {
          if (activeChallenge(page.$)) {
            throw new AdapterBlockedError(`${DOMAIN}: blocked: active challenge on ${new URL(candidate.url).pathname}`);
          }
          const familyTitle = exactFamilyTitle(page.$, candidate);
          keepForCollection = familyTitleMatchesBrand(familyTitle, brand);
          return keepForCollection ? candidate : undefined;
        } finally {
          if (!keepForCollection) this.releaseHtmlPage(candidate.url, context);
        }
      })).filter((ref): ref is FamilyReviewRef => ref !== undefined);
      const refs = proven
        .map((ref) => ({
          domain: DOMAIN,
          platform: DOMAIN,
          listingId: ref.listingId,
          brand,
          url: ref.url,
          metadata: { discovery: "009-complete-family-review-sitemaps" }
        }))
        .sort((left, right) => left.listingId.localeCompare(right.listingId, "ru"));
      if (!refs.length) {
        throw new ParserChangedError(`${DOMAIN}: complete sitemap did not prove an exact family mapping or absence for ${brand}`);
      }
      return refs;
    } finally {
      this.finishSnapshotUse(brand, context);
    }
  }

  private async discoverByExactBrandSlugs(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const candidates = new Map<string, FamilyReviewRef>();
    for (const { slug } of brandSlugCandidates(brand)) {
      const candidate = familyReviewRef(`${ORIGIN}/kupit-${slug}/otzyvy`);
      if (candidate) candidates.set(candidate.url, candidate);
    }
    if (!candidates.size || candidates.size > MAX_BRAND_CANDIDATES) {
      throw new ParserChangedError(`${DOMAIN}: exact brand slug fallback is empty or too broad for ${brand}`);
    }

    const proven = (await mapWithConcurrency([...candidates.values()], SITEMAP_CONCURRENCY, async (candidate) => {
      const response = await requestText(
        candidate.url,
        context,
        this.fetchImpl,
        MAX_HTML_BYTES,
        "text/html,application/xhtml+xml",
        [404, 410],
        0
      );
      const page: HtmlPage = {
        html: response.text,
        $: load(response.text),
        status: response.status,
        requestedUrl: response.requestedUrl
      };
      if (activeChallenge(page.$)) {
        throw new AdapterBlockedError(`${DOMAIN}: blocked: active challenge on ${new URL(candidate.url).pathname}`);
      }
      if (response.status === 404 || response.status === 410) return undefined;
      if (response.status !== 200) {
        throw new ParserChangedError(`${DOMAIN}:${candidate.listingId}: exact brand slug returned unsupported HTTP ${response.status}`);
      }

      const familyTitle = exactFamilyTitle(page.$, candidate);
      if (!exactFamilyTitleMatchesBrand(familyTitle, brand)) {
        throw new ParserChangedError(`${DOMAIN}:${candidate.listingId}: exact brand slug is not bound to ${brand}`);
      }
      this.rememberHtmlPage(candidate.url, context, page);
      return candidate;
    })).filter((candidate): candidate is FamilyReviewRef => candidate !== undefined);

    const refs = proven
      .map((candidate) => ({
        domain: DOMAIN,
        platform: DOMAIN,
        listingId: candidate.listingId,
        brand,
        url: candidate.url,
        metadata: { discovery: "009-bounded-exact-brand-slug" }
      }))
      .sort((left, right) => left.listingId.localeCompare(right.listingId, "ru"));
    if (!refs.length) {
      throw new AdapterBlockedError(
        `${DOMAIN}: exact brand slug probes did not prove absence for ${brand}; the complete sitemap may use an unexpected alias`
      );
    }
    return refs;
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    const parsedRef = familyReviewRef(ref.url, ref.listingId);
    if (!parsedRef) throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: invalid family review URL or ID`);
    const page = await this.htmlPage(parsedRef.url, context);
    try {
      if (activeChallenge(page.$)) {
        throw new AdapterBlockedError(`${DOMAIN}: blocked: active challenge on ${new URL(parsedRef.url).pathname}`);
      }

      const familyTitle = exactFamilyTitle(page.$, parsedRef);
      if (!familyTitleMatchesBrand(familyTitle, ref.brand)) {
        throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: review heading is not bound to ${ref.brand}`);
      }

      const reviewRoot = page.$(".drugReviews");
      if (reviewRoot.length !== 1) {
        throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: source-bound review block is missing or ambiguous`);
      }
      const products: JsonObject[] = [];
      reviewRoot.find("script[type='application/ld+json']").each((_index, node) => {
        const source = page.$(node).text().trim();
        if (!source || source.length > 1_500_000) return;
        try { jsonProducts(JSON.parse(source), products); }
        catch { throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: family JSON-LD is invalid`); }
      });
      const exactProducts = products.filter((product) => normalizeText(productName(product.name)) === normalizeText(familyTitle));
      if (products.length && exactProducts.length !== 1) {
        throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: family JSON-LD is missing or ambiguous`);
      }
      const product = exactProducts[0];
      if (product && normalizeText(productBrand(product.brand)) !== normalizeText(familyTitle)) {
        throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: JSON-LD brand is not bound to the family heading`);
      }

      const aggregate = product?.aggregateRating;
      if (aggregate && typeof aggregate === "object" && !Array.isArray(aggregate)) {
        const record = aggregate as JsonObject;
        const reviews = exactInteger(record.reviewCount);
        const ratingCount = exactInteger(record.ratingCount);
        const rating = exactRating(record.ratingValue);
        const visibleRating = exactRating(reviewRoot.find(".drugReviews__ratingValue").first().text());
        const visibleCount = visibleReviewCount(reviewRoot.find(".drugReviews__count").first().text());
        if (record["@type"] !== "AggregateRating" || exactRating(record.bestRating) !== 5 || reviews === undefined ||
          ratingCount === undefined || rating === undefined ||
          reviews <= 0 || ratingCount !== reviews || visibleRating !== rating || visibleCount !== reviews) {
          throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: structured and visible family aggregate disagree`);
        }
        return this.observation(ref, parsedRef, page, familyTitle, reviews, rating, ratingCount,
          exactVariants(page.$, familyTitle, ref.brand), "009-family-review-jsonld");
      }

      const emptySummary = reviewRoot.find(".drugReviews__summary.empty");
      const emptyMessage = emptySummary.find(".drugReviews__emptyReviews");
      const anyAggregate = products.some((item) => item.aggregateRating !== undefined);
      const explicitZero = emptySummary.length === 1 && emptyMessage.length === 1 &&
        compactText(emptyMessage.text()) === "Нет отзывов. Будьте первым!" &&
        reviewRoot.find(".drugReviews__ratingValue, .drugReviews__count").length === 0 && !anyAggregate;
      if (!explicitZero) {
        throw new ParserChangedError(`${DOMAIN}:${ref.listingId}: family page did not prove aggregate or explicit zero`);
      }
      return this.observation(ref, parsedRef, page, familyTitle, 0, null, 0, [], "009-family-visible-empty-state");
    } finally {
      this.releaseHtmlPage(parsedRef.url, context);
    }
  }

  private async snapshot(context: AdapterContext): Promise<SitemapSnapshot> {
    const runId = context.runId?.trim();
    if (!runId) return this.loadSnapshot(context);
    const cacheKey = this.snapshotCacheKey(context)!;
    const cached = this.runSnapshots.get(cacheKey);
    if (cached) return cached;
    const pending = this.loadSnapshot(context);
    this.runSnapshots.set(cacheKey, pending);
    while (this.runSnapshots.size > 4) {
      const oldest = this.runSnapshots.keys().next().value as string | undefined;
      if (!oldest || oldest === cacheKey) break;
      this.runSnapshots.delete(oldest);
    }
    try { return await pending; }
    catch (error) {
      this.runSnapshots.delete(cacheKey);
      this.snapshotBrands.delete(cacheKey);
      throw error;
    }
  }

  private snapshotCacheKey(context: AdapterContext): string | undefined {
    const runId = context.runId?.trim();
    return runId ? `${runId}:${context.refreshDiscovery ? "refresh" : "normal"}` : undefined;
  }

  private finishSnapshotUse(brand: string, context: AdapterContext): void {
    const cacheKey = this.snapshotCacheKey(context);
    if (!cacheKey) return;
    const consumed = this.snapshotBrands.get(cacheKey) ?? new Set<string>();
    consumed.add(normalizeText(brand));
    this.snapshotBrands.set(cacheKey, consumed);
    const expected = new Set((context.brands?.length ? context.brands : [brand]).map(normalizeText));
    if ([...expected].every((value) => consumed.has(value))) {
      this.runSnapshots.delete(cacheKey);
      this.snapshotBrands.delete(cacheKey);
    }
  }

  private async loadSnapshot(context: AdapterContext): Promise<SitemapSnapshot> {
    const index = await requestText(SITEMAP_INDEX, context, this.fetchImpl, MAX_INDEX_BYTES, "application/xml,text/xml;q=0.9");
    const entries = parseSitemapIndex(index.text);

    const shards = await mapWithConcurrency(entries, SITEMAP_CONCURRENCY, async (entry, indexNumber) => {
      const response = await requestText(entry.url, context, this.fetchImpl, MAX_SHARD_BYTES, "application/xml,text/xml;q=0.9");
      const parsed = parseReviewRefsFromShard(response.text, `sitemap shard ${indexNumber + 1}/${entries.length}`);
      return {
        ...parsed,
        sha256: sha256Text(response.text),
        lastModified: normalizePharmacy009LastModified(response.headers)
      };
    });
    const unique = new Map<string, FamilyReviewRef>();
    for (const ref of shards.flatMap((shard) => shard.refs)) unique.set(ref.url, ref);
    if (!unique.size) {
      throw new ParserChangedError(`${DOMAIN}: complete sitemap set contains no canonical family review pages`);
    }
    const refs = [...unique.values()].sort((left, right) => left.slug.localeCompare(right.slug, "en"));
    const canonicalFamilySet = `${[...unique.keys()].sort().join("\n")}\n`;
    return {
      refs,
      proof: {
        indexSha256: sha256Text(index.text),
        indexLastModified: normalizePharmacy009LastModified(index.headers),
        embeddedLastmods: entries.map((entry) => entry.lastmod),
        shardUrls: entries.map((entry) => entry.url),
        shardSha256: shards.map((shard) => shard.sha256),
        shardLastModified: shards.map((shard) => shard.lastModified),
        shardUrlCounts: shards.map((shard) => shard.urlCount),
        familyRefCount: unique.size,
        familyRefSetSha256: sha256Text(canonicalFamilySet),
        absencePredicateVersion: "hloretta-cyrillic-h-kh-x-ch-single-double-t-v1"
      }
    };
  }

  private async htmlPage(url: string, context: AdapterContext): Promise<HtmlPage> {
    const cacheKey = this.pageCacheKey(url, context);
    const cached = this.runPages.get(cacheKey);
    if (cached) return cached;
    const pending = requestText(url, context, this.fetchImpl, MAX_HTML_BYTES, "text/html,application/xhtml+xml")
      .then((response) => ({
        html: response.text,
        $: load(response.text),
        status: response.status,
        requestedUrl: response.requestedUrl
      }));
    this.runPages.set(cacheKey, pending);
    while (this.runPages.size > 32) {
      const oldest = this.runPages.keys().next().value as string | undefined;
      if (!oldest || oldest === cacheKey) break;
      this.runPages.delete(oldest);
    }
    try { return await pending; }
    catch (error) {
      this.runPages.delete(cacheKey);
      throw error;
    }
  }

  private pageCacheKey(url: string, context: AdapterContext): string {
    return `${context.runId?.trim() || "anonymous"}:${context.refreshDiscovery ? "refresh" : "normal"}:${url}`;
  }

  private rememberHtmlPage(url: string, context: AdapterContext, page: HtmlPage): void {
    const cacheKey = this.pageCacheKey(url, context);
    this.runPages.set(cacheKey, Promise.resolve(page));
    while (this.runPages.size > 32) {
      const oldest = this.runPages.keys().next().value as string | undefined;
      if (!oldest || oldest === cacheKey) break;
      this.runPages.delete(oldest);
    }
  }

  private releaseHtmlPage(url: string, context: AdapterContext): void {
    this.runPages.delete(this.pageCacheKey(url, context));
  }

  private async observation(
    ref: ProductRef,
    parsedRef: FamilyReviewRef,
    page: HtmlPage,
    familyTitle: string,
    reviews: number,
    rating: number | null,
    ratingCount: number,
    variants: string[],
    source: string
  ): Promise<Observation> {
    const capturedAt = new Date().toISOString();
    const product = publicationFamilyTitle(familyTitle, ref.brand, variants);
    const productEvidence = familyProductEvidence(
      parsedRef.url,
      parsedRef.listingId,
      familyTitle,
      variants,
      source === "009-family-review-jsonld"
    );
    const evidenceRef = await this.evidence.put({
      capturedAt,
      url: page.requestedUrl,
      status: page.status,
      bodyDigest: createHash("sha256").update(page.html).digest("hex"),
      parsed: {
        listingId: parsedRef.listingId,
        familyTitle,
        product,
        canonicalUrl: parsedRef.url,
        writtenReviewCount: reviews,
        ratingCount,
        rating
      },
      productEvidence,
      source
    });
    return {
      domain: DOMAIN,
      platform: DOMAIN,
      listingId: parsedRef.listingId,
      brand: ref.brand,
      canonicalUrl: parsedRef.url,
      product,
      reviews,
      writtenReviewCount: reviews,
      rating,
      rawRating: rating,
      rawRatingScale: 5,
      ratingCount,
      status: reviews === 0 ? "no_reviews" : "ok",
      capturedAt,
      evidenceRef,
      aggregateGroupId: `009:family:${parsedRef.slug}`,
      productEvidence,
      source
    };
  }
}
