import { mkdir, writeFile } from "node:fs/promises";

import { YandexAdapter } from "../src/server/adapters/yandex.js";
import type { AdapterContext, Observation, ProductRef } from "../src/shared/types.js";
import { aliasesForBrand } from "../src/server/utils/normalize.js";

const brands = [
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

const quickFetch: typeof globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
      if (response.status === 404 && /\/ugcpub\/sitemap_model_/i.test(url)) {
        return new Response("<?xml version=\"1.0\"?><urlset></urlset>", {
          status: 200,
          headers: { "content-type": "application/xml" }
        });
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
};

const context: AdapterContext = { region: "Москва", fetch: quickFetch };
const adapter = new YandexAdapter({
  fetch: quickFetch,
  sitemapConcurrency: 12,
  maxSitemaps: 400,
  maxCandidates: 300
});

const allRefs = new Map<string, ProductRef>();
const firstRefs = await adapter.discover(brands[0], context);
for (const ref of firstRefs) allRefs.set(ref.listingId, ref);
process.stderr.write(`SITEMAPS_READY; ${brands[0]}=${firstRefs.length}\n`);

type SitemapCache = Map<string, { value: Promise<string> }>;
const sitemapCache = (adapter as unknown as { sitemapCache: SitemapCache }).sitemapCache;
const xmlDocuments = await Promise.all([...sitemapCache.values()].map(({ value }) => value));
const brandCandidates = new Map(
  brands.map((brand) => [
    brand,
    aliasesForBrand(brand)
      .flatMap((alias) => [normalizeSlug(alias), normalizeSlug(transliterate(alias))])
      .filter(Boolean)
  ])
);

for (const xml of xmlDocuments) {
  for (const match of xml.matchAll(/<loc\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/gi)) {
    const url = decodeXml((match[1] ?? match[2] ?? "").trim());
    const id = url.match(/--(\d+)(?:[/?#]|$)/)?.[1];
    if (!id || allRefs.has(id) || !url.startsWith("https://reviews.yandex.ru/product/")) continue;
    const lastPart = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
    const slug = normalizeSlug(lastPart.replace(/--\d+$/, ""));
    const wrappedSlug = ` ${slug} `;
    const brand = brands.find((candidateBrand) =>
      brandCandidates.get(candidateBrand)?.some((candidate) => wrappedSlug.includes(` ${candidate} `))
    );
    if (!brand) continue;
    allRefs.set(id, {
      domain: "market.yandex.ru",
      platform: "yandex",
      listingId: id,
      brand,
      url: url.split("?")[0],
      title: lastPart.replace(/--\d+$/, "").replace(/[-_]+/g, " "),
      metadata: { discovery: "reviews_sitemap_quick" }
    });
  }
}

const discoveredCounts = Object.fromEntries(
  brands.map((brand) => [brand, [...allRefs.values()].filter((ref) => ref.brand === brand).length])
);
process.stderr.write(`DISCOVERED ${allRefs.size}: ${JSON.stringify(discoveredCounts)}\n`);

const refs = [...allRefs.values()];
const observations: Observation[] = [];
const errors: Array<{ listingId: string; brand: string; url: string; error: string }> = [];
let cursor = 0;
const workers = Array.from({ length: Math.min(10, refs.length) }, async () => {
  while (cursor < refs.length) {
    const index = cursor++;
    const ref = refs[index];
    try {
      observations.push(await adapter.collect(ref, context));
    } catch (error) {
      errors.push({
        listingId: ref.listingId,
        brand: ref.brand,
        url: ref.url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if ((index + 1) % 25 === 0 || index + 1 === refs.length) {
      process.stderr.write(`COLLECT ${index + 1}/${refs.length}; ok=${observations.length}; errors=${errors.length}\n`);
    }
  }
});
await Promise.all(workers);

observations.sort(
  (a, b) =>
    brands.indexOf(a.brand as (typeof brands)[number]) - brands.indexOf(b.brand as (typeof brands)[number]) ||
    a.product.localeCompare(b.product, "ru") ||
    Number(a.listingId) - Number(b.listingId)
);
errors.sort((a, b) => a.brand.localeCompare(b.brand, "ru") || Number(a.listingId) - Number(b.listingId));

await mkdir("outputs", { recursive: true });
await Promise.all([
  writeFile("outputs/yandex-quick.json", `${JSON.stringify(observations, null, 2)}\n`, "utf8"),
  writeFile("outputs/yandex-quick-errors.json", `${JSON.stringify(errors, null, 2)}\n`, "utf8")
]);

const counts = Object.fromEntries(
  brands.map((brand) => [brand, observations.filter((observation) => observation.brand === brand).length])
);
process.stdout.write(`${JSON.stringify({ discovered: refs.length, collected: observations.length, errors: errors.length, counts })}\n`);

function normalizeSlug(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transliterate(value: string): string {
  const table: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "iu", я: "ia"
  };
  return [...value.toLocaleLowerCase("ru-RU")].map((character) => table[character] ?? character).join("");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
