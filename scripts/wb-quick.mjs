import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const brands = [
  "Арбидол", "Кагоцел", "Рафамин", "Эргоферон", "Анаферон", "Гриппферон",
  "Ингавирин", "Циклоферон", "Полиоксидоний", "Трекрезан", "Цитовир-3",
  "Бронхо-мунал", "Амиксин", "Номидес", "Триазавирин", "Нобазит", "Исмиген"
];

const versions = [4];
const headers = {
  accept: "application/json, text/plain, */*",
  "accept-language": "ru-RU,ru;q=0.9",
  origin: "https://www.wildberries.ru",
  referer: "https://www.wildberries.ru/",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36"
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const normalize = (value) => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru-RU")
  .replaceAll("ё", "е")
  .replace(/[‐‑‒–—−-]+/g, " ")
  .replace(/[^a-zа-я0-9]+/giu, " ")
  .trim()
  .replace(/\s+/g, " ");

function matchesBrand(title, brand) {
  const normalizedTitle = ` ${normalize(title)} `;
  const normalizedBrand = normalize(brand);
  return normalizedBrand !== "" && normalizedTitle.includes(` ${normalizedBrand} `);
}

async function fetchPage(brand, page) {
  let lastError = "unknown";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const version = versions[attempt % versions.length];
    const url = new URL(`https://search.wb.ru/exactmatch/ru/common/v${version}/search`);
    for (const [key, value] of Object.entries({
      ab_testing: "false", appType: "1", curr: "rub", dest: "-1257786",
      hide_dtype: "13", lang: "ru", page: String(page), query: brand,
      resultset: "catalog", sort: "popular", spp: "30", suppressSpellcheck: "false"
    })) url.searchParams.set(key, value);

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = JSON.parse(body);
      const products = Array.isArray(payload.products)
        ? payload.products
        : Array.isArray(payload.data?.products) ? payload.data.products : undefined;
      if (!products) throw new Error("products array absent");
      return { products, total: Number(payload.total ?? payload.data?.total), url: url.toString(), version };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250 + attempt * 75);
    }
  }
  throw new Error(`${brand} page ${page}: ${lastError}`);
}

const capturedAt = new Date().toISOString();
const observationsById = new Map();
const partitions = [];
const errors = [];

for (const brand of brands) {
  let rawSeen = 0;
  let discovered = 0;
  let page = 1;
  let exhausted = false;
  let previousIds = "";
  try {
    while (page <= 50) {
      const result = await fetchPage(brand, page);
      const ids = result.products.map((item) => String(item.id ?? item.nmId ?? "")).join(",");
      if (result.products.length === 0 || (previousIds && ids === previousIds)) {
        exhausted = true;
        break;
      }
      previousIds = ids;
      rawSeen += result.products.length;

      for (const item of result.products) {
        const listingId = String(item.id ?? item.nmId ?? "").trim();
        const product = String(item.name ?? item.title ?? "").trim();
        if (!/^\d+$/.test(listingId) || !product || !matchesBrand(product, brand)) continue;
        const reviews = Number(item.nmFeedbacks);
        const rawRating = Number(item.nmReviewRating);
        if (!Number.isSafeInteger(reviews) || reviews < 0) {
          throw new Error(`nmFeedbacks absent for nmId ${listingId}`);
        }
        const rating = reviews === 0 ? null : Number.isFinite(rawRating) && rawRating > 0 && rawRating <= 5 ? rawRating : null;
        if (!observationsById.has(listingId)) {
          observationsById.set(listingId, {
            domain: "wildberries.ru",
            platform: "wildberries",
            listingId,
            brand,
            canonicalUrl: `https://www.wildberries.ru/catalog/${listingId}/detail.aspx`,
            product,
            reviews,
            rating,
            ...(rating !== null ? { rawRating: rating, rawRatingScale: 5 } : {}),
            status: reviews === 0 ? "no_reviews" : rating !== null ? "ok" : "needs_review",
            capturedAt,
            evidenceRef: result.url,
            ...(item.root || item.imtId ? { groupId: String(item.root ?? item.imtId) } : {}),
            source: `wildberries-search-v${result.version}-nm-fields`
          });
          discovered += 1;
        }
      }

      if (Number.isFinite(result.total) && rawSeen >= result.total) {
        exhausted = true;
        break;
      }
      page += 1;
      await sleep(650);
    }
    if (!exhausted) throw new Error("pagination cap reached before exhaustion");
    partitions.push({ brand, status: discovered ? "complete" : "no_results", discovered });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    partitions.push({ brand, status: "blocked", discovered, message });
    errors.push({ brand, message });
  }
  process.stdout.write(`${brand}: ${discovered}\n`);
  await sleep(650);
}

const observations = [...observationsById.values()].sort((a, b) =>
  brands.indexOf(a.brand) - brands.indexOf(b.brand) || a.product.localeCompare(b.product, "ru") || Number(a.listingId) - Number(b.listingId)
);
const output = { capturedAt, region: "Москва", domain: "wildberries.ru", brands, partitions, errors, total: observations.length, observations };
await mkdir(resolve("outputs"), { recursive: true });
await writeFile(resolve("outputs/wb-quick.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`TOTAL=${observations.length}; ERRORS=${errors.length}\n`);
