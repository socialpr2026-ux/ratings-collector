import { isKnownYandexIndexTombstoneSitemap } from "../../shared/yandex-sitemaps.js";

const YANDEX_REVIEWS_ORIGIN = "https://reviews.yandex.ru";
const MODEL_SITEMAP_PATH = /^\/ugcpub\/sitemap_model_\d+-\d+-\d+\.xml$/i;
const SHOP_SITEMAP_PATH = /^\/ugcpub\/sitemap_shop_((?:[0-9a-z]|%[0-9a-f]{2})-(?:[0-9a-z]|%[0-9a-f]{2}))-\d+\.xml$/i;
const SHOP_SITEMAP_RANGES = new Set([
  "%25-%26",
  ...Array.from({ length: 10 }, (_value, index) => `${index}-${index === 9 ? "%3a" : index + 1}`),
  ...Array.from({ length: 26 }, (_value, index) => {
    const start = String.fromCharCode("a".charCodeAt(0) + index);
    const end = index === 25 ? "%7b" : String.fromCharCode("a".charCodeAt(0) + index + 1);
    return `${start}-${end}`;
  })
]);

export type YandexManifestEntry = {
  url: string;
  kind: "model" | "shop";
  lastModified?: string;
  entryHash: string;
};

export type YandexSitemapManifest = {
  version: 1;
  indexUrl: string;
  /** SHA-256 of the exact bounded XML bytes received from Yandex. */
  manifestHash: string;
  entries: YandexManifestEntry[];
  modelEntries: YandexManifestEntry[];
};

export type YandexStoredShardMatch = {
  brand: string;
  url: string;
  sitemap: string;
};

export type YandexShardProof = {
  version: 1;
  manifestHash: string;
  manifestEntryHash: string;
  brandSetHash: string;
  shardUrl: string;
  status: "verified" | "tombstoned";
  matches: YandexStoredShardMatch[];
  completedAt: string;
  /** SHA-256 of every source-bound field except the informational timestamp. */
  proofHash: string;
};

export type YandexShardPlanItem = {
  entry: YandexManifestEntry;
  reason: "missing" | "changed" | "invalid";
};

export type YandexShardProofPlan = {
  reusable: YandexShardProof[];
  pending: YandexShardPlanItem[];
};

export interface YandexShardProofStore {
  load(jobKey: string): Promise<readonly YandexShardProof[]>;
  put(jobKey: string, proof: YandexShardProof): Promise<void>;
}

export class YandexManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YandexManifestValidationError";
  }
}

export class InMemoryYandexShardProofStore implements YandexShardProofStore {
  private readonly jobs = new Map<string, Map<string, YandexShardProof>>();

  constructor(private readonly maxJobs = 32) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) {
      throw new RangeError("Yandex proof store maxJobs must be a positive integer");
    }
  }

  async load(jobKey: string): Promise<readonly YandexShardProof[]> {
    return [...(this.jobs.get(jobKey)?.values() ?? [])].map(cloneShardProof);
  }

  async put(jobKey: string, proof: YandexShardProof): Promise<void> {
    let job = this.jobs.get(jobKey);
    if (!job) {
      job = new Map();
      this.jobs.set(jobKey, job);
      while (this.jobs.size > this.maxJobs) {
        const oldest = this.jobs.keys().next().value as string | undefined;
        if (!oldest || oldest === jobKey) break;
        this.jobs.delete(oldest);
      }
    }
    job.set(proof.shardUrl, cloneShardProof(proof));
  }
}

export class YandexShardScanCoordinator {
  private readonly jobs = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) return existing as Promise<T>;
    const job = operation();
    this.jobs.set(key, job);
    try {
      return await job;
    } finally {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    }
  }
}

export const sharedYandexShardProofStore = new InMemoryYandexShardProofStore();
export const sharedYandexShardScanCoordinator = new YandexShardScanCoordinator();

export async function validateAndHashYandexManifest(
  xml: string,
  indexUrl: string
): Promise<YandexSitemapManifest> {
  if (!isExactIndexUrl(indexUrl)) {
    throw new YandexManifestValidationError("Yandex sitemap index URL is not the fixed Reviews index");
  }
  const source = xml.replace(/^\uFEFF/, "").trim();
  const withoutDeclaration = source.replace(/^<\?xml\b[^?]*\?>\s*/i, "");
  const root = withoutDeclaration.match(/^<sitemapindex\b[^>]*>([\s\S]*)<\/sitemapindex\s*>$/i);
  if (!root) throw new YandexManifestValidationError("Yandex sitemap index XML shape changed");

  const body = root[1]!;
  const blockPattern = /<sitemap\s*>([\s\S]*?)<\/sitemap\s*>/gi;
  const blocks = [...body.matchAll(blockPattern)];
  const remainder = body.replace(blockPattern, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (blocks.length === 0 || remainder) {
    throw new YandexManifestValidationError("Yandex sitemap index is incomplete or contains unknown elements");
  }

  const rawEntries = blocks.map((block) => parseManifestBlock(block[1]!));
  if (new Set(rawEntries.map(({ url }) => url)).size !== rawEntries.length) {
    throw new YandexManifestValidationError("Yandex sitemap index contains duplicate maps");
  }
  const manifestHash = await sha256Hex(xml);
  const entries = await Promise.all(rawEntries.map(async ({ url, kind, lastModified }) => ({
    url,
    kind,
    ...(lastModified ? { lastModified } : {}),
    // lastmod is the exact per-shard revision when Yandex supplies it. Without
    // one, bind the shard to the complete exact manifest hash so any index
    // change invalidates the otherwise unversioned checkpoint fail-closed.
    entryHash: await sha256Hex(`${url}\n${lastModified ?? `manifest:${manifestHash}`}`)
  })));
  const modelEntries = entries.filter(({ kind }) => kind === "model");
  if (modelEntries.length === 0) {
    throw new YandexManifestValidationError("Yandex sitemap index contains no model maps");
  }
  return {
    version: 1,
    indexUrl,
    manifestHash,
    entries,
    modelEntries
  };
}

export async function hashYandexBrandSet(brandKeys: readonly string[]): Promise<string> {
  const normalized = [...new Set(brandKeys.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) throw new Error("Yandex proof brand set cannot be empty");
  return sha256Hex(normalized.join("\u001f"));
}

export function yandexShardJobKey(runId: string | undefined, brandSetHash: string): string | undefined {
  const scope = runId?.trim();
  return scope ? `yandex-shards:v1:${scope}:${brandSetHash}` : undefined;
}

export async function createYandexShardProof(input: {
  manifest: YandexSitemapManifest;
  entry: YandexManifestEntry;
  brandSetHash: string;
  status: "verified" | "tombstoned";
  matches: readonly YandexStoredShardMatch[];
  completedAt: string;
}): Promise<YandexShardProof> {
  if (!input.manifest.modelEntries.some(({ url, entryHash }) =>
    url === input.entry.url && entryHash === input.entry.entryHash)) {
    throw new Error("Yandex shard proof is not bound to the current model manifest");
  }
  const matches = [...input.matches]
    .map((match) => ({ ...match }))
    .sort(compareMatches);
  const matchKeys = new Set<string>();
  if (matches.some((match) => {
    const key = `${proofBrandKey(match.brand)}\u001e${match.url}`;
    if (!match.brand.trim() || match.sitemap !== input.entry.url ||
      !isAllowedYandexProductUrl(match.url) || !productBelongsToShard(match.url, input.entry.url) ||
      matchKeys.has(key)) return true;
    matchKeys.add(key);
    return false;
  }) || input.status === "tombstoned" && (
    matches.length > 0 || !isKnownYandexIndexTombstoneSitemap(input.entry.url)
  )) {
    throw new Error("Yandex shard proof contains source-unbound matches");
  }
  const proof = {
    version: 1 as const,
    manifestHash: input.manifest.manifestHash,
    manifestEntryHash: input.entry.entryHash,
    brandSetHash: input.brandSetHash,
    shardUrl: input.entry.url,
    status: input.status,
    matches,
    completedAt: input.completedAt
  };
  return { ...proof, proofHash: await shardProofHash(proof) };
}

export async function planYandexShardProofs(input: {
  manifest: YandexSitemapManifest;
  selectedEntries: readonly YandexManifestEntry[];
  brandSetHash: string;
  brandKeys: ReadonlySet<string>;
  stored: readonly YandexShardProof[];
  normalizeBrand: (brand: string) => string;
  isAllowedProductUrl: (url: string) => boolean;
}): Promise<YandexShardProofPlan> {
  const storedByUrl = new Map(input.stored.map((proof) => [proof.shardUrl, proof]));
  const reusable: YandexShardProof[] = [];
  const pending: YandexShardPlanItem[] = [];
  for (const entry of input.selectedEntries) {
    const proof = storedByUrl.get(entry.url);
    if (!proof) {
      pending.push({ entry, reason: "missing" });
      continue;
    }
    if (proof.manifestEntryHash !== entry.entryHash || proof.brandSetHash !== input.brandSetHash) {
      pending.push({ entry, reason: "changed" });
      continue;
    }
    if (!await validStoredProof(proof, input, entry)) {
      pending.push({ entry, reason: "invalid" });
      continue;
    }
    reusable.push(cloneShardProof(proof));
  }
  return { reusable, pending };
}

async function validStoredProof(
  proof: YandexShardProof,
  input: Parameters<typeof planYandexShardProofs>[0],
  entry: YandexManifestEntry
): Promise<boolean> {
  if (proof.version !== 1 || proof.shardUrl !== entry.url ||
    proof.status !== "verified" && proof.status !== "tombstoned" ||
    !Array.isArray(proof.matches) || typeof proof.completedAt !== "string" ||
    !Number.isFinite(Date.parse(proof.completedAt)) || typeof proof.proofHash !== "string") return false;
  if (proof.status === "tombstoned" && (
    proof.matches.length > 0 || !isKnownYandexIndexTombstoneSitemap(entry.url)
  )) return false;
  const matchKeys = new Set<string>();
  for (const match of proof.matches) {
    if (!match || typeof match.brand !== "string" ||
      !input.brandKeys.has(input.normalizeBrand(match.brand)) ||
      typeof match.url !== "string" || !input.isAllowedProductUrl(match.url) ||
      !productBelongsToShard(match.url, entry.url) ||
      match.sitemap !== entry.url) return false;
    const key = `${input.normalizeBrand(match.brand)}\u001e${match.url}`;
    if (matchKeys.has(key)) return false;
    matchKeys.add(key);
  }
  const { proofHash: _proofHash, ...unsigned } = proof;
  return proof.proofHash === await shardProofHash(unsigned);
}

async function shardProofHash(proof: Omit<YandexShardProof, "proofHash">): Promise<string> {
  return sha256Hex(JSON.stringify({
    version: proof.version,
    manifestHash: proof.manifestHash,
    manifestEntryHash: proof.manifestEntryHash,
    brandSetHash: proof.brandSetHash,
    shardUrl: proof.shardUrl,
    status: proof.status,
    matches: [...proof.matches].sort(compareMatches)
  }));
}

function parseManifestBlock(block: string): {
  url: string;
  kind: "model" | "shop";
  lastModified?: string;
} {
  const locPattern = /<loc\s*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/loc\s*>/gi;
  const lastmodPattern = /<lastmod\s*>([\s\S]*?)<\/lastmod\s*>/gi;
  const locations = [...block.matchAll(locPattern)];
  const lastModifiedValues = [...block.matchAll(lastmodPattern)];
  const remainder = block.replace(locPattern, "").replace(lastmodPattern, "").trim();
  if (locations.length !== 1 || lastModifiedValues.length > 1 || remainder) {
    throw new YandexManifestValidationError("Yandex sitemap manifest entry is incomplete or contains unknown fields");
  }
  const url = decodeXmlEntities((locations[0]![1] ?? locations[0]![2] ?? "").trim());
  const kind = sitemapKind(url);
  if (!kind) throw new YandexManifestValidationError(`Yandex sitemap index contains an unknown map: ${url}`);
  const lastModified = lastModifiedValues[0]?.[1]?.trim();
  if (lastModified && !validW3cDateTime(lastModified)) {
    throw new YandexManifestValidationError(`Yandex sitemap ${url} has an invalid lastmod`);
  }
  return { url, kind, ...(lastModified ? { lastModified } : {}) };
}

function sitemapKind(input: string): "model" | "shop" | undefined {
  try {
    const url = new URL(input);
    if (!isAllowedYandexSitemapUrl(url)) return undefined;
    if (MODEL_SITEMAP_PATH.test(url.pathname)) return "model";
    const range = url.pathname.match(SHOP_SITEMAP_PATH)?.[1]?.toLowerCase();
    if (range && SHOP_SITEMAP_RANGES.has(range)) return "shop";
    return undefined;
  } catch {
    return undefined;
  }
}

function isAllowedYandexProductUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.origin === YANDEX_REVIEWS_ORIGIN && !url.search && !url.hash &&
      !url.username && !url.password && /^\/product\/(?:[a-z0-9][a-z0-9_-]*)?--\d+$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function productBelongsToShard(productUrl: string, shardUrl: string): boolean {
  try {
    const productId = new URL(productUrl).pathname.match(/--(\d+)$/)?.[1];
    const range = new URL(shardUrl).pathname.match(/sitemap_model_(\d+)-(\d+)-\d+\.xml$/i);
    if (!productId || !range) return false;
    const numericId = BigInt(productId);
    return numericId >= BigInt(range[1]!) && numericId <= BigInt(range[2]!);
  } catch {
    return false;
  }
}

function isExactIndexUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.origin === YANDEX_REVIEWS_ORIGIN && url.pathname === "/ugcpub/sitemap.xml" &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isAllowedYandexSitemapUrl(url: URL): boolean {
  return url.origin === YANDEX_REVIEWS_ORIGIN && !url.search && !url.hash && !url.username && !url.password;
}

function validW3cDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function compareMatches(left: YandexStoredShardMatch, right: YandexStoredShardMatch): number {
  return left.brand.localeCompare(right.brand, "ru") || left.url.localeCompare(right.url) ||
    left.sitemap.localeCompare(right.sitemap);
}

function proofBrandKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
}

function cloneShardProof(proof: YandexShardProof): YandexShardProof {
  return { ...proof, matches: proof.matches.map((match) => ({ ...match })) };
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
