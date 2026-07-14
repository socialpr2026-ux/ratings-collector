import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  aliasesForBrand,
  matchesBrand,
  normalizeRating
} from "../src/server/utils/normalize.js";

const ACTOR_ID = "zen-studio~ozon-scraper-pro";
const API_BASE = "https://api.apify.com";
const STARTED_AFTER = process.env.OZON_RECOVERY_STARTED_AFTER ?? "2026-07-13T13:15:00.000Z";
const STARTED_BEFORE = process.env.OZON_RECOVERY_STARTED_BEFORE ?? "2026-07-13T14:05:00.000Z";
const OUTPUT = resolve(process.env.OZON_RECOVERY_OUTPUT ?? "outputs/ozon-quick.json");

const BRANDS = [
  "Арбидол",
  "Кагоцел",
  "Рафамин",
  "Эргоферон",
  "Анаферон",
  "Гриппферон",
  "Ингавирин",
  "Циклоферон",
  "Полиоксидоний",
  "Трекрезан",
  "Цитовир-3",
  "Бронхо-мунал",
  "Амиксин",
  "Номидес",
  "Триазавирин",
  "Нобазит",
  "Исмиген"
] as const;

const SLUG_ALIASES: Record<(typeof BRANDS)[number], readonly string[]> = {
  "Арбидол": ["arbidol"],
  "Кагоцел": ["kagocel", "kagotsel"],
  "Рафамин": ["rafamin"],
  "Эргоферон": ["ergoferon"],
  "Анаферон": ["anaferon"],
  "Гриппферон": ["grippferon"],
  "Ингавирин": ["ingavirin"],
  "Циклоферон": ["cikloferon", "tsikloferon"],
  "Полиоксидоний": ["polioksidoniy", "polioksidonii"],
  "Трекрезан": ["trekrezan"],
  "Цитовир-3": ["citovir-3", "citovir3", "tsitovir-3", "tsitovir3"],
  "Бронхо-мунал": ["bronho-munal", "bronkho-munal", "bronhomunal"],
  "Амиксин": ["amiksin"],
  "Номидес": ["nomides"],
  "Триазавирин": ["triazavirin"],
  "Нобазит": ["nobazit"],
  "Исмиген": ["ismigen"]
};

type JsonRecord = Record<string, unknown>;
type Run = {
  id: string;
  actId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
  meta?: { origin?: string };
};

type Row = {
  domain: "ozon.ru";
  platform: "ozon";
  listingId: string;
  brand: string;
  canonicalUrl: string;
  product: string;
  reviews: number | null;
  rating: number | null;
  status: "ok" | "no_reviews" | "needs_review";
  capturedAt: string;
  source: string;
  recoveryNote?: string;
};

const token = process.env.APIFY_TOKEN?.trim();
if (!token) throw new Error("APIFY_TOKEN is required");

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstPresent(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function normalizedSet(values: readonly string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeSku(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const compact = value.normalize("NFKC").replace(/[\s\u00a0\u202f]+/g, "");
  if (!/^\d+$/.test(compact)) return null;
  const clean = compact.replace(/^0+(?=\d)/, "");
  return clean === "0" ? null : clean;
}

function skuFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, "https://www.ozon.ru");
    return normalizeSku(url.pathname.match(/(?:^|[-/])(\d{5,})(?:\/)?$/)?.[1]);
  } catch {
    return null;
  }
}

function safeTitle(record: JsonRecord): string | null {
  const value = firstPresent(record, ["title", "name"]);
  return typeof value === "string" && value.trim() ? value.normalize("NFKC").trim() : null;
}

function rawBrand(record: JsonRecord): string | undefined {
  const value = record.brand;
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const name = value.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function parseReviews(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const digits = value.normalize("NFKC").replace(/[^\d]/g, "");
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRating(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.normalize("NFKC").replace(",", ".").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function canonicalUrl(value: unknown, sku: string): string {
  const fallback = `https://www.ozon.ru/product/${sku}/`;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value, "https://www.ozon.ru");
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (host !== "ozon.ru" && !host.endsWith(".ozon.ru")) return fallback;
    const segment = url.pathname.match(/\/product\/([^/]+)/i)?.[1];
    if (!segment || skuFromUrl(url.toString()) !== sku) return fallback;
    return `https://www.ozon.ru/product/${segment}/`;
  } catch {
    return fallback;
  }
}

function fallbackTitle(value: unknown, sku: string, brand: string): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value, "https://www.ozon.ru");
      const segment = decodeURIComponent(url.pathname.match(/\/product\/([^/]+)/i)?.[1] ?? "")
        .replace(new RegExp(`-${sku}$`), "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (segment) return `${brand} — ${segment}`;
    } catch {
      // Deterministic SKU fallback below.
    }
  }
  return `${brand} — Ozon SKU ${sku}`;
}

function slugFromUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return decodeURIComponent(new URL(value, "https://www.ozon.ru").pathname.match(/\/product\/([^/]+)/i)?.[1] ?? "")
      .toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function slugMatchesBrand(value: unknown, brand: (typeof BRANDS)[number]): boolean {
  const slug = slugFromUrl(value);
  return SLUG_ALIASES[brand].some((alias) =>
    new RegExp(`(?:^|-)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-|$)`, "i").test(slug)
  );
}

async function getJson(url: URL | string): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`GET ${new URL(String(url)).pathname}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function unwrapData(value: unknown): JsonRecord {
  if (!isRecord(value) || !isRecord(value.data)) throw new Error("Unexpected Apify response envelope");
  return value.data;
}

const actor = unwrapData(await getJson(`${API_BASE}/v2/acts/${ACTOR_ID}`));
if (typeof actor.id !== "string") throw new Error("Actor ID missing from Apify response");

const runsUrl = new URL(`${API_BASE}/v2/actor-runs`);
runsUrl.searchParams.set("status", "SUCCEEDED");
runsUrl.searchParams.set("startedAfter", STARTED_AFTER);
runsUrl.searchParams.set("startedBefore", STARTED_BEFORE);
runsUrl.searchParams.set("desc", "1");
runsUrl.searchParams.set("limit", "1000");
const runList = unwrapData(await getJson(runsUrl));
const allRuns = Array.isArray(runList.items) ? runList.items.filter(isRecord) : [];
const runs = allRuns.filter((item): item is JsonRecord & Run =>
  item.actId === actor.id && item.status === "SUCCEEDED" && typeof item.defaultDatasetId === "string"
);

const expectedQueries = new Map(
  BRANDS.map((brand) => [brand, normalizedSet(aliasesForBrand(brand))] as const)
);
const candidates = new Map<string, Run[]>();
const inputErrors: Array<{ runId: string; message: string }> = [];

for (const run of runs) {
  try {
    const input = await getJson(`${API_BASE}/v2/actor-runs/${run.id}/key-value-store/records/INPUT`);
    if (!isRecord(input) || !Array.isArray(input.queries) || !input.queries.every((item) => typeof item === "string")) continue;
    if (input.skipDetails !== true || input.includeSellerDetails !== false || input.language !== "ru" || input.currency !== "RUB") continue;
    if (Number(input.maxResults) !== 250) continue;
    const actual = normalizedSet(input.queries as string[]);
    const brand = BRANDS.find((candidate) => sameStrings(actual, expectedQueries.get(candidate) ?? []));
    if (!brand) continue;
    const list = candidates.get(brand) ?? [];
    list.push(run);
    candidates.set(brand, list);
  } catch (error) {
    inputErrors.push({ runId: run.id, message: error instanceof Error ? error.message : String(error) });
  }
}

const rows: Row[] = [];
const errors: Array<{ brand?: string; runId?: string; message: string }> = [...inputErrors];
const malformed: Array<{ brand: string; runId: string; datasetId: string; listingId: string | null; url: string | null; keys: string[]; action: string }> = [];
const datasets: Array<{ brand: string; runId: string; datasetId: string; startedAt: string; finishedAt?: string; itemCount: number; matchingRows: number; duplicateCandidateRuns: number }> = [];

for (const brand of BRANDS) {
  const matchingRuns = (candidates.get(brand) ?? []).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const run = matchingRuns[0];
  if (!run) {
    errors.push({ brand, message: "No matching already-paid successful Actor run found in the recovery window" });
    continue;
  }

  try {
    const itemsUrl = new URL(`${API_BASE}/v2/datasets/${run.defaultDatasetId}/items`);
    itemsUrl.searchParams.set("format", "json");
    itemsUrl.searchParams.set("clean", "1");
    itemsUrl.searchParams.set("limit", "10000");
    const payload = await getJson(itemsUrl);
    if (!Array.isArray(payload)) throw new Error("Dataset items response is not an array");

    const bySku = new Map<string, Row>();
    for (const value of payload) {
      if (!isRecord(value)) {
        errors.push({ brand, runId: run.id, message: "Dataset contains a non-object item" });
        continue;
      }
      const actorError = value.error ?? value.errorInfo;
      if (actorError) {
        errors.push({ brand, runId: run.id, message: "Dataset contains an actor-reported error item" });
        continue;
      }

      const sourceUrl = firstPresent(value, ["url", "productUrl", "link"]);
      const sku = normalizeSku(firstPresent(value, ["sku", "id"])) ?? normalizeSku(value.productId) ?? skuFromUrl(sourceUrl);
      const title = safeTitle(value);
      const itemBrand = rawBrand(value);

      if (!title) {
        const keys = Object.keys(value).sort().slice(0, 40);
        if (!sku) {
          malformed.push({ brand, runId: run.id, datasetId: run.defaultDatasetId, listingId: null, url: typeof sourceUrl === "string" ? sourceUrl : null, keys, action: "ignored_non_product_without_title_or_sku" });
          continue;
        }
        const brandEvidence = (itemBrand ? matchesBrand(itemBrand, brand) : false) || slugMatchesBrand(sourceUrl, brand);
        malformed.push({ brand, runId: run.id, datasetId: run.defaultDatasetId, listingId: sku, url: typeof sourceUrl === "string" ? sourceUrl : null, keys, action: brandEvidence ? "included_as_needs_review" : "ignored_without_brand_evidence" });
        if (!brandEvidence) continue;

        const reviews = parseReviews(firstPresent(value, ["reviewCount", "reviewsCount", "reviewsTotal", "feedbackCount"]));
        const rawRating = parseRating(firstPresent(value, ["rating", "reviewRating", "averageRating"]));
        bySku.set(sku, {
          domain: "ozon.ru",
          platform: "ozon",
          listingId: sku,
          brand,
          canonicalUrl: canonicalUrl(sourceUrl, sku),
          product: fallbackTitle(sourceUrl, sku, brand),
          reviews,
          rating: reviews === 0 ? null : rawRating === null ? null : normalizeRating(rawRating, 5),
          status: "needs_review",
          capturedAt: run.finishedAt ?? run.startedAt,
          source: `apify:dataset:${run.defaultDatasetId}`,
          recoveryNote: "Actor item had no title; fallback label requires review"
        });
        continue;
      }

      if (!sku) {
        malformed.push({ brand, runId: run.id, datasetId: run.defaultDatasetId, listingId: null, url: typeof sourceUrl === "string" ? sourceUrl : null, keys: Object.keys(value).sort().slice(0, 40), action: "ignored_product_without_sku" });
        continue;
      }
      if (!matchesBrand(title, brand) && !(itemBrand && matchesBrand(itemBrand, brand))) continue;

      const reviews = parseReviews(firstPresent(value, ["reviewCount", "reviewsCount", "reviewsTotal", "feedbackCount"]));
      const rawRating = parseRating(firstPresent(value, ["rating", "reviewRating", "averageRating"]));
      const rating = reviews === 0 ? null : rawRating === null ? null : normalizeRating(rawRating, 5);
      const status = reviews === 0 ? "no_reviews" : reviews === null || rating === null || rating === 0 ? "needs_review" : "ok";
      const candidate: Row = {
        domain: "ozon.ru",
        platform: "ozon",
        listingId: sku,
        brand,
        canonicalUrl: canonicalUrl(sourceUrl, sku),
        product: title,
        reviews,
        rating,
        status,
        capturedAt: run.finishedAt ?? run.startedAt,
        source: `apify:dataset:${run.defaultDatasetId}`
      };
      const existing = bySku.get(sku);
      if (!existing || (candidate.reviews !== null && existing.reviews === null) || (candidate.rating !== null && existing.rating === null)) bySku.set(sku, candidate);
    }

    const brandRows = [...bySku.values()];
    rows.push(...brandRows);
    datasets.push({
      brand,
      runId: run.id,
      datasetId: run.defaultDatasetId,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      itemCount: payload.length,
      matchingRows: brandRows.length,
      duplicateCandidateRuns: Math.max(0, matchingRuns.length - 1)
    });
  } catch (error) {
    errors.push({ brand, runId: run.id, message: error instanceof Error ? error.message : String(error) });
  }
}

rows.sort((left, right) => BRANDS.indexOf(left.brand as typeof BRANDS[number]) - BRANDS.indexOf(right.brand as typeof BRANDS[number]) || left.product.localeCompare(right.product, "ru") || left.listingId.localeCompare(right.listingId));

const result = {
  generatedAt: new Date().toISOString(),
  mode: "read_existing_apify_datasets_only",
  actor: ACTOR_ID,
  recoveryWindow: { startedAfter: STARTED_AFTER, startedBefore: STARTED_BEFORE },
  requestedBrands: [...BRANDS],
  summary: {
    matchedDatasets: datasets.length,
    totalRows: rows.length,
    ok: rows.filter((row) => row.status === "ok").length,
    noReviews: rows.filter((row) => row.status === "no_reviews").length,
    needsReview: rows.filter((row) => row.status === "needs_review").length,
    malformedItems: malformed.length,
    errors: errors.length
  },
  datasets,
  rows,
  malformed,
  errors
};

await mkdir(resolve(OUTPUT, ".."), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: OUTPUT, ...result.summary, brandsWithDatasets: datasets.map((item) => item.brand) }));
