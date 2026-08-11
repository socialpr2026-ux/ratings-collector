import { describe, expect, it } from "vitest";

import {
  createYandexShardProof,
  hashYandexBrandSet,
  planYandexShardProofs,
  validateAndHashYandexManifest,
  YandexManifestValidationError
} from "../src/server/adapters/yandex-shard-proof.js";

const INDEX = "https://reviews.yandex.ru/ugcpub/sitemap.xml";
const MAP_A = "https://reviews.yandex.ru/ugcpub/sitemap_model_0-9999999-0.xml";
const MAP_B = "https://reviews.yandex.ru/ugcpub/sitemap_model_260000000-269999999-0.xml";
const MAP_C = "https://reviews.yandex.ru/ugcpub/sitemap_model_500000000-509999999-0.xml";
const SHOP = "https://reviews.yandex.ru/ugcpub/sitemap_shop_a-b-0.xml";

describe("Yandex shard proof foundation", () => {
  it("validates and hashes the exact manifest while retaining per-shard revisions", async () => {
    const xml = sitemapIndex([
      { url: MAP_A, lastmod: "2026-08-10" },
      { url: SHOP, lastmod: "2026-08-10T10:11:12Z" },
      { url: MAP_B }
    ]);

    const first = await validateAndHashYandexManifest(xml, INDEX);
    const repeated = await validateAndHashYandexManifest(xml, INDEX);
    const byteChanged = await validateAndHashYandexManifest(`${xml}\n`, INDEX);

    expect(first).toMatchObject({
      version: 1,
      indexUrl: INDEX,
      entries: [
        { url: MAP_A, kind: "model", lastModified: "2026-08-10" },
        { url: SHOP, kind: "shop", lastModified: "2026-08-10T10:11:12Z" },
        { url: MAP_B, kind: "model" }
      ],
      modelEntries: [{ url: MAP_A }, { url: MAP_B }]
    });
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifestHash).toBe(repeated.manifestHash);
    expect(first.manifestHash).not.toBe(byteChanged.manifestHash);
    expect(first.modelEntries[0]!.entryHash).not.toBe(first.modelEntries[1]!.entryHash);
  });

  it("fails closed on an unknown or incomplete manifest entry", async () => {
    const unknownField = `<?xml version="1.0"?><sitemapindex>` +
      `<sitemap><loc>${MAP_A}</loc><changefreq>daily</changefreq></sitemap></sitemapindex>`;
    const missingLocation = "<?xml version=\"1.0\"?><sitemapindex><sitemap></sitemap></sitemapindex>";

    await expect(validateAndHashYandexManifest(unknownField, INDEX))
      .rejects.toBeInstanceOf(YandexManifestValidationError);
    await expect(validateAndHashYandexManifest(missingLocation, INDEX))
      .rejects.toBeInstanceOf(YandexManifestValidationError);
  });

  it("plans only missing and changed shards while reusing intact proofs", async () => {
    const initial = await validateAndHashYandexManifest(sitemapIndex([
      { url: MAP_A, lastmod: "2026-08-10" },
      { url: MAP_B, lastmod: "2026-08-10" }
    ]), INDEX);
    const current = await validateAndHashYandexManifest(sitemapIndex([
      { url: MAP_A, lastmod: "2026-08-10" },
      { url: MAP_B, lastmod: "2026-08-11" },
      { url: MAP_C, lastmod: "2026-08-11" }
    ]), INDEX);
    const brandSetHash = await hashYandexBrandSet(["кагоцел"]);
    const proofA = await createYandexShardProof({
      manifest: initial,
      entry: initial.modelEntries[0]!,
      brandSetHash,
      status: "verified",
      matches: [{
        brand: "Кагоцел",
        url: "https://reviews.yandex.ru/product/kagotsel--111",
        sitemap: MAP_A
      }],
      completedAt: "2026-08-10T12:00:00.000Z"
    });
    const proofB = await createYandexShardProof({
      manifest: initial,
      entry: initial.modelEntries[1]!,
      brandSetHash,
      status: "verified",
      matches: [],
      completedAt: "2026-08-10T12:00:01.000Z"
    });

    const plan = await planYandexShardProofs({
      manifest: current,
      selectedEntries: current.modelEntries,
      brandSetHash,
      brandKeys: new Set(["кагоцел"]),
      stored: [proofA, proofB],
      normalizeBrand: (brand) => brand.toLocaleLowerCase("ru-RU"),
      isAllowedProductUrl: (url) => url.startsWith("https://reviews.yandex.ru/product/")
    });

    expect(plan.reusable.map(({ shardUrl }) => shardUrl)).toEqual([MAP_A]);
    expect(plan.pending).toMatchObject([
      { entry: { url: MAP_B }, reason: "changed" },
      { entry: { url: MAP_C }, reason: "missing" }
    ]);
  });

  it("never reuses a truncated or tampered per-shard proof as an empty result", async () => {
    const manifest = await validateAndHashYandexManifest(sitemapIndex([{ url: MAP_A }]), INDEX);
    const brandSetHash = await hashYandexBrandSet(["кагоцел"]);
    const proof = await createYandexShardProof({
      manifest,
      entry: manifest.modelEntries[0]!,
      brandSetHash,
      status: "verified",
      matches: [],
      completedAt: "2026-08-10T12:00:00.000Z"
    });
    const tampered = { ...proof, status: "tombstoned" as const };

    const plan = await planYandexShardProofs({
      manifest,
      selectedEntries: manifest.modelEntries,
      brandSetHash,
      brandKeys: new Set(["кагоцел"]),
      stored: [tampered],
      normalizeBrand: (brand) => brand.toLocaleLowerCase("ru-RU"),
      isAllowedProductUrl: () => true
    });

    expect(plan.reusable).toEqual([]);
    expect(plan.pending).toMatchObject([{ entry: { url: MAP_A }, reason: "invalid" }]);
  });
});

function sitemapIndex(entries: Array<{ url: string; lastmod?: string }>): string {
  return `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    entries.map(({ url, lastmod }) =>
      `<sitemap><loc>${url}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</sitemap>`
    ).join("") + `</sitemapindex>`;
}
