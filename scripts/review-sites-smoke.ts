import { MemoryEvidenceStore } from "../src/server/evidence.js";
import { REVIEW_SITE_DEFINITIONS, ReviewSiteAdapter } from "../src/server/adapters/review-sites.js";

const brand = process.argv[2]?.trim() || "Анвифен";
const limit = Number(process.argv[3] ?? 25);

for (const definition of REVIEW_SITE_DEFINITIONS.filter((item) => item.domain !== "irecommend.ru")) {
  const adapter = new ReviewSiteAdapter(definition, new MemoryEvidenceStore(), fetch);
  try {
    const health = await adapter.healthCheck({ region: "Москва" });
    if (!health.ok) {
      console.log(JSON.stringify({ domain: definition.domain, health }));
      continue;
    }
    const refs = await adapter.discover(brand, { region: "Москва" });
    const rows: unknown[] = [];
    for (const ref of refs.slice(0, limit)) {
      try {
        const item = await adapter.collect(ref, { region: "Москва" });
        rows.push({
          id: item.listingId,
          url: item.canonicalUrl,
          product: item.product,
          reviews: item.reviews,
          rating: item.rating,
          status: item.status
        });
      } catch (error) {
        rows.push({ url: ref.url, error: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log(JSON.stringify({ domain: definition.domain, total: refs.length, rows }));
  } catch (error) {
    console.log(JSON.stringify({ domain: definition.domain, error: error instanceof Error ? error.message : String(error) }));
  }
}
