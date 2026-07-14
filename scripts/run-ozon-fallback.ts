import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { matchesBrand, normalizeRating } from "../src/server/utils/normalize.js";

const ACTOR_ID = "ahaham_bytiz~ozon-scraper";
const API_BASE = "https://api.apify.com";
const OUTPUT = resolve("outputs/ozon-quick.json");
const SENTINEL = resolve("outputs/ozon-fallback-run.json");
const MAX_TOTAL_CHARGE_USD = 0.5;
const MAX_ITEMS = 612;

const BRANDS = [
  "Арбидол", "Кагоцел", "Рафамин", "Эргоферон", "Анаферон", "Гриппферон",
  "Ингавирин", "Циклоферон", "Полиоксидоний", "Трекрезан", "Цитовир-3",
  "Бронхо-мунал", "Амиксин", "Номидес", "Триазавирин", "Нобазит", "Исмиген"
] as const;

type JsonRecord = Record<string, unknown>;
type RunRecord = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
};

const token = process.env.APIFY_TOKEN?.trim();
if (!token) throw new Error("APIFY_TOKEN is required");

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapRun(value: unknown): RunRecord {
  if (!isRecord(value) || !isRecord(value.data)) throw new Error("Unexpected Apify run response");
  const data = value.data;
  if (typeof data.id !== "string" || typeof data.status !== "string" || typeof data.startedAt !== "string" || typeof data.defaultDatasetId !== "string") {
    throw new Error("Apify run response is missing required fields");
  }
  return data as unknown as RunRecord;
}

async function requestJson(url: URL | string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${new URL(String(url)).pathname}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) as unknown : null;
}

async function readSentinel(): Promise<{ runId: string } | null> {
  try {
    const value = JSON.parse(await readFile(SENTINEL, "utf8")) as unknown;
    return isRecord(value) && typeof value.runId === "string" ? { runId: value.runId } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

await mkdir(resolve(OUTPUT, ".."), { recursive: true });
let sentinel = await readSentinel();
let run: RunRecord;

if (!sentinel) {
  const runUrl = new URL(`${API_BASE}/v2/acts/${ACTOR_ID}/runs`);
  runUrl.searchParams.set("maxTotalChargeUsd", String(MAX_TOTAL_CHARGE_USD));
  runUrl.searchParams.set("timeout", "300");
  runUrl.searchParams.set("maxItems", String(MAX_ITEMS));
  run = unwrapRun(await requestJson(runUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      searchQueries: [...BRANDS],
      startUrls: [],
      maxItems: MAX_ITEMS,
      maxPagesPerQuery: 1,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountry: "RU"
      }
    })
  }));
  sentinel = { runId: run.id };
  await writeFile(SENTINEL, `${JSON.stringify({ ...sentinel, actor: ACTOR_ID, createdAt: new Date().toISOString(), maxTotalChargeUsd: MAX_TOTAL_CHARGE_USD, maxItems: MAX_ITEMS }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "actor_started", runId: run.id, status: run.status }));
} else {
  run = unwrapRun(await requestJson(`${API_BASE}/v2/actor-runs/${sentinel.runId}`, { method: "GET" }));
  console.log(JSON.stringify({ event: "resuming_existing_actor", runId: run.id, status: run.status }));
}

const terminal = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);
const deadline = Date.now() + 300_000;
while (!terminal.has(run.status) && Date.now() < deadline) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  run = unwrapRun(await requestJson(`${API_BASE}/v2/actor-runs/${run.id}`, { method: "GET" }));
  console.log(JSON.stringify({ event: "actor_status", runId: run.id, status: run.status }));
}

if (run.status !== "SUCCEEDED") {
  throw new Error(`Fallback Actor stopped with status ${run.status}`);
}

const itemsUrl = new URL(`${API_BASE}/v2/datasets/${run.defaultDatasetId}/items`);
itemsUrl.searchParams.set("format", "json");
itemsUrl.searchParams.set("clean", "1");
itemsUrl.searchParams.set("limit", String(MAX_ITEMS));
const payload = await requestJson(itemsUrl, { method: "GET" });
if (!Array.isArray(payload)) throw new Error("Fallback Actor dataset is not an array");

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function skuFrom(value: JsonRecord): string | null {
  const candidates = [value.sku, value.productId];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return String(candidate);
    if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) return candidate.trim().replace(/^0+(?=\d)/, "");
  }
  if (typeof value.url !== "string") return null;
  try {
    return new URL(value.url).pathname.match(/(?:^|[-/])(\d{5,})(?:\/)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function canonicalUrl(value: unknown, sku: string): string {
  const fallback = `https://www.ozon.ru/product/${sku}/`;
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value);
    if (url.hostname !== "ozon.ru" && !url.hostname.endsWith(".ozon.ru")) return fallback;
    const segment = url.pathname.match(/\/product\/([^/]+)/i)?.[1];
    return segment ? `https://www.ozon.ru/product/${segment}/` : fallback;
  } catch {
    return fallback;
  }
}

const rowsBySku = new Map<string, JsonRecord>();
const errors: Array<{ index: number; message: string }> = [];

payload.forEach((value, index) => {
  if (!isRecord(value)) {
    errors.push({ index, message: "non_object_item" });
    return;
  }
  const nameValue = value.name ?? value.title;
  const name = typeof nameValue === "string" ? nameValue.normalize("NFKC").trim() : "";
  const brand = BRANDS.find((candidate) => matchesBrand(name, candidate));
  if (!brand) return;
  const sku = skuFrom(value);
  if (!sku) {
    errors.push({ index, message: `matched_${brand}_without_numeric_sku` });
    return;
  }
  const reviews = integerOrNull(value.reviewsCount ?? value.reviewCount);
  const rawRating = numberOrNull(value.rating);
  const rating = reviews === 0 ? null : rawRating === null || rawRating < 0 || rawRating > 5 ? null : normalizeRating(rawRating, 5);
  const status = reviews === 0 ? "no_reviews" : reviews === null || rating === null || rating === 0 ? "needs_review" : "ok";
  const row: JsonRecord = {
    domain: "ozon.ru",
    platform: "ozon",
    listingId: sku,
    brand,
    canonicalUrl: canonicalUrl(value.url, sku),
    product: name,
    reviews,
    rating,
    status,
    capturedAt: run.finishedAt ?? new Date().toISOString(),
    source: `apify:${ACTOR_ID}:${run.id}`
  };
  const existing = rowsBySku.get(sku);
  if (existing && existing.brand !== brand) {
    existing.status = "needs_review";
    row.status = "needs_review";
    errors.push({ index, message: `sku_${sku}_matched_multiple_brands` });
  }
  if (!existing || (row.status === "ok" && existing.status !== "ok")) rowsBySku.set(sku, row);
});

const brandOrder = new Map(BRANDS.map((brand, index) => [brand, index]));
const rows = [...rowsBySku.values()].sort((left, right) =>
  (brandOrder.get(String(left.brand) as typeof BRANDS[number]) ?? 999) - (brandOrder.get(String(right.brand) as typeof BRANDS[number]) ?? 999) ||
  String(left.product).localeCompare(String(right.product), "ru") || String(left.listingId).localeCompare(String(right.listingId))
);
const summary = {
  actorRunId: run.id,
  datasetId: run.defaultDatasetId,
  actorStatus: run.status,
  usageTotalUsd: run.usageTotalUsd ?? null,
  datasetItems: payload.length,
  rows: rows.length,
  ok: rows.filter((row) => row.status === "ok").length,
  noReviews: rows.filter((row) => row.status === "no_reviews").length,
  needsReview: rows.filter((row) => row.status === "needs_review").length,
  brandsFound: BRANDS.filter((brand) => rows.some((row) => row.brand === brand)),
  errors: errors.length
};

await writeFile(OUTPUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: "single_capped_fallback_actor", actor: ACTOR_ID, requestedBrands: [...BRANDS], summary, rows, errors }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ event: "complete", output: OUTPUT, ...summary }));
