import { readFile, writeFile } from "node:fs/promises";

import { YandexAdapter } from "../src/server/adapters/yandex.js";
import type { AdapterContext, Observation, ProductRef } from "../src/shared/types.js";

type RefSeed = { listingId: string; brand: string; url: string };

const seeds = JSON.parse(await readFile("outputs/yandex-quick-errors.json", "utf8")) as RefSeed[];
const browserFetch: typeof globalThis.fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set(
    "user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  headers.set("accept-language", "ru-RU,ru;q=0.9,en;q=0.7");
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(input, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError;
};

const context: AdapterContext = { region: "Москва", fetch: browserFetch };
const adapter = new YandexAdapter({ fetch: browserFetch });
const refs: ProductRef[] = seeds.map((seed) => ({
  domain: "market.yandex.ru",
  platform: "yandex",
  listingId: seed.listingId,
  brand: seed.brand,
  url: seed.url,
  metadata: { discovery: "reviews_sitemap_quick" }
}));

const observations: Observation[] = [];
const errors: Array<RefSeed & { error: string }> = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(8, refs.length) }, async () => {
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
      if ((index + 1) % 20 === 0 || index + 1 === refs.length) {
        process.stderr.write(`COLLECT ${index + 1}/${refs.length}; ok=${observations.length}; errors=${errors.length}\n`);
      }
    }
  })
);

observations.sort((a, b) => a.brand.localeCompare(b.brand, "ru") || a.product.localeCompare(b.product, "ru"));
errors.sort((a, b) => a.brand.localeCompare(b.brand, "ru") || Number(a.listingId) - Number(b.listingId));
await Promise.all([
  writeFile("outputs/yandex-quick.json", `${JSON.stringify(observations, null, 2)}\n`, "utf8"),
  writeFile("outputs/yandex-quick-errors.json", `${JSON.stringify(errors, null, 2)}\n`, "utf8")
]);

const counts = Object.fromEntries(
  [...new Set(seeds.map(({ brand }) => brand))].map((brand) => [
    brand,
    observations.filter((observation) => observation.brand === brand).length
  ])
);
process.stdout.write(`${JSON.stringify({ collected: observations.length, errors: errors.length, counts })}\n`);
