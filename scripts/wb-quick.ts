import { mkdir, writeFile } from "node:fs/promises";
import { WildberriesAdapter } from "../src/server/adapters/wildberries.js";
import type { Observation } from "../src/shared/types.js";

const brands = ["Арбидол","Кагоцел","Рафамин","Эргоферон","Анаферон","Гриппферон","Ингавирин","Циклоферон","Полиоксидоний","Трекрезан","Цитовир-3","Бронхо-мунал","Амиксин","Номидес","Триазавирин","Нобазит","Исмиген"];
const adapter = new WildberriesAdapter({
  searchEndpoint: "https://u-search.wb.ru/exactmatch/ru/common/v18/search",
  requestIntervalMs: 100,
  maxPages: 50
});
const context = { region: "Москва" };
const byId = new Map<string, Observation>();
const errors: Array<{ brand: string; listingId?: string; error: string }> = [];

for (const brand of brands) {
  try {
    const refs = await adapter.discover(brand, context);
    for (const ref of refs) {
      const reviews = Number(ref.metadata.nmFeedbacks);
      const rating = Number(ref.metadata.nmReviewRating);
      if (!Number.isInteger(reviews) || reviews < 0 || (reviews > 0 && (!Number.isFinite(rating) || rating <= 0 || rating > 5))) {
        errors.push({ brand, listingId: ref.listingId, error: "missing nm-specific metrics in search result" });
        continue;
      }
      const observation: Observation = {
        domain: "wildberries.ru",
        platform: "wildberries",
        listingId: ref.listingId,
        brand,
        canonicalUrl: ref.url,
        product: ref.title ?? brand,
        reviews,
        rating: reviews === 0 ? null : rating,
        rawRating: reviews === 0 ? null : rating,
        rawRatingScale: 5,
        status: reviews === 0 ? "no_reviews" : "ok",
        capturedAt: new Date().toISOString(),
        groupId: typeof ref.metadata.rootId === "string" ? ref.metadata.rootId : undefined,
        source: "wildberries-search-v18-urgent"
      };
      const previous = byId.get(ref.listingId);
      if (previous && previous.brand !== brand) {
        errors.push({ brand, listingId: ref.listingId, error: `duplicate across brands: ${previous.brand}` });
        continue;
      }
      byId.set(ref.listingId, observation);
    }
    process.stderr.write(`WB ${brand}: refs=${refs.length}; total=${byId.size}\n`);
  } catch (error) {
    errors.push({ brand, error: error instanceof Error ? error.message : String(error) });
  }
}

const observations = [...byId.values()].sort((a, b) => brands.indexOf(a.brand) - brands.indexOf(b.brand) || a.product.localeCompare(b.product, "ru") || Number(a.listingId) - Number(b.listingId));
await mkdir("outputs", { recursive: true });
await Promise.all([
  writeFile("outputs/wb-quick.json", `${JSON.stringify(observations, null, 2)}\n`, "utf8"),
  writeFile("outputs/wb-quick-errors.json", `${JSON.stringify(errors, null, 2)}\n`, "utf8")
]);
process.stdout.write(`${JSON.stringify({ collected: observations.length, errors: errors.length, byBrand: Object.fromEntries(brands.map((brand) => [brand, observations.filter((item) => item.brand === brand).length])) })}\n`);
