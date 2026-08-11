import { describe, expect, it } from "vitest";
import type { Observation, ProductRecord } from "../src/shared/types.js";
import { analyzeProductIdentity, canonicalProductVariants } from "../src/server/utils/product-name.js";
import { compactProductCatalogEvidence, reconcileProductCatalog } from "../src/server/utils/product-catalog.js";

function observation(listingId: string, product: string, brand = "Оциллококцинум"): Observation {
  return {
    domain: `${listingId}.example`, platform: "test", listingId, brand,
    canonicalUrl: `https://${listingId}.example/product/${listingId}`,
    product, reviews: 1, rating: 5, status: "ok", capturedAt: "2026-08-08T00:00:00.000Z",
    productIdentity: analyzeProductIdentity({ brand, product })
  };
}

describe("persistent product catalog", () => {
  it("keeps only explicitly verified GTIN claims in the persistent catalog", () => {
    const base = { scope: "listing" as const, signals: [], variants: [], imageUrls: [], instructionUrls: [] };

    expect(compactProductCatalogEvidence({
      ...base, identifiers: [{ type: "gtin", value: "4006381333931" }]
    })).toBeUndefined();
    expect(compactProductCatalogEvidence({
      ...base, identifiers: [{ type: "gtin", value: "verified:4006381333931" }]
    })?.identifiers).toEqual([{ type: "gtin", value: "verified:4006381333931" }]);
  });

  it("assigns one stable variant to equivalent real products across sources", () => {
    const source = [
      observation("one", "Оциллококцинум гранулы гомеопатические 1 г №30"),
      observation("two", "Оциллококцинум гранулы №30"),
      observation("three", "Оциллококцинум 30 доз гранулы гомеопатические")
    ];
    const resolved = reconcileProductCatalog(source);

    expect(new Set(resolved.map((item) => item.productIdentity?.canonicalVariantId)).size).toBe(1);
    expect(new Set(resolved.map((item) => item.productIdentity?.label))).toEqual(new Set(["гранулы №30"]));
    expect(resolved.map((item) => item.product)).toEqual(source.map((item) => item.product));
  });

  it("keeps real strength and pack differences as distinct variants", () => {
    const resolved = reconcileProductCatalog([
      observation("a", "Анвифен капсулы 50 мг №20", "Анвифен"),
      observation("b", "Анвифен капсулы 250 мг №20", "Анвифен"),
      observation("c", "Анвифен капсулы 50 мг №10", "Анвифен")
    ]);

    expect(new Set(resolved.map((item) => item.productIdentity?.canonicalVariantId)).size).toBe(3);
  });

  it("does not promote an operator-confirmed generic alias across sources", () => {
    const brand = "Анвифен";
    const raw = "Анвифен капсулы";
    const manual = observation("old", raw, brand);
    manual.productOverride = "капсулы 100 мг №20";
    manual.productIdentity = analyzeProductIdentity({ brand, product: `${brand} ${manual.productOverride}` });
    const catalogued = reconcileProductCatalog([manual])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand,
      canonicalUrl: manual.canonicalUrl, product: raw, platform: "test",
      productIdentity: catalogued.productIdentity, productOverride: manual.productOverride,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };
    const next = observation("new", raw, brand);

    const resolved = reconcileProductCatalog([next], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({
      granularity: "unresolved",
      confidence: "partial",
      label: "Общая карточка формы «капсулы»"
    });
    expect(resolved.productIdentity?.canonicalVariantId).toBeUndefined();
    expect(resolved.product).toBe(raw);
  });

  it("reuses an operator-confirmed generic alias only on its source domain", () => {
    const brand = "Анвифен";
    const raw = "Анвифен капсулы";
    const manual = observation("old", raw, brand);
    manual.productOverride = "капсулы 100 мг №20";
    manual.productIdentity = analyzeProductIdentity({ brand, product: `${brand} ${manual.productOverride}` });
    const catalogued = reconcileProductCatalog([manual])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand,
      canonicalUrl: manual.canonicalUrl, product: raw, platform: "test",
      productIdentity: catalogued.productIdentity, productOverride: manual.productOverride,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };
    const next = observation("new", raw, brand);
    next.domain = prior.domain;

    const resolved = reconcileProductCatalog([next], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({
      canonicalVariantId: catalogued.productIdentity?.canonicalVariantId,
      label: "капсулы 100 мг №20",
      resolutionMethod: "catalog_alias"
    });
  });

  it("keeps the published ID when a later snapshot adds a shorter equivalent spelling", () => {
    const long = observation("old", "Оциллококцинум гранулы гомеопатические 1 г №30");
    const publishedObservation = reconcileProductCatalog([long])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand: long.brand,
      canonicalUrl: long.canonicalUrl, product: long.product, platform: "test",
      productIdentity: publishedObservation.productIdentity,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };

    const resolved = reconcileProductCatalog([
      observation("new", "Оциллококцинум гранулы №30")
    ], [prior]);

    expect(new Set(resolved.map((item) => item.productIdentity?.canonicalVariantId))).toEqual(
      new Set([publishedObservation.productIdentity?.canonicalVariantId])
    );
  });

  it("does not reuse an operator alias when fresh exact facts contradict it", () => {
    const brand = "Анвифен";
    const raw = "Анвифен капсулы";
    const manual = observation("old", raw, brand);
    manual.productOverride = "капсулы 100 мг №20";
    manual.productIdentity = analyzeProductIdentity({ brand, product: `${brand} ${manual.productOverride}` });
    const catalogued = reconcileProductCatalog([manual])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand,
      canonicalUrl: manual.canonicalUrl, product: raw, platform: "test",
      productIdentity: catalogued.productIdentity, productOverride: manual.productOverride,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };
    const current = observation("new", raw, brand);
    current.productEvidence = {
      scope: "listing", signals: [], variants: [`${brand} капсулы 250 мг №20`],
      identifiers: [], imageUrls: [], instructionUrls: []
    };
    current.productIdentity = analyzeProductIdentity({ brand, product: raw, evidence: current.productEvidence });

    const resolved = reconcileProductCatalog([current], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({ label: "капсулы 250 мг №20", granularity: "variant" });
    expect(resolved.productIdentity?.canonicalVariantId).not.toBe(catalogued.productIdentity?.canonicalVariantId);
  });

  it("does not promote an evidence-only generic title to a global alias", () => {
    const brand = "Анвифен";
    const raw = "Анвифен капсулы";
    const source = observation("old", raw, brand);
    source.productEvidence = {
      scope: "listing", signals: [], variants: [`${brand} капсулы 100 мг №20`],
      identifiers: [], imageUrls: [], instructionUrls: []
    };
    source.productIdentity = analyzeProductIdentity({ brand, product: raw, evidence: source.productEvidence });
    const catalogued = reconcileProductCatalog([source])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand,
      canonicalUrl: source.canonicalUrl, product: raw, platform: "test",
      productIdentity: catalogued.productIdentity, productEvidence: source.productEvidence,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };

    const resolved = reconcileProductCatalog([observation("new", raw, brand)], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({ granularity: "unresolved", confidence: "partial" });
    expect(resolved.productIdentity?.canonicalVariantId).toBeUndefined();
  });

  it("never promotes a checksum-valid but unverified GTIN to exact", () => {
    const first = observation("old", "Анвифен капсулы 100 мг №20", "Анвифен");
    first.productEvidence = {
      scope: "listing", signals: [], variants: [],
      identifiers: [{ type: "gtin", value: "4006381333931" }], imageUrls: [], instructionUrls: []
    };
    const catalogued = reconcileProductCatalog([first])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand: first.brand,
      canonicalUrl: first.canonicalUrl, product: first.product, platform: "test",
      productIdentity: catalogued.productIdentity, productEvidence: first.productEvidence,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };
    const incomplete = observation("new", "Анвифен капсулы", "Анвифен");
    incomplete.productEvidence = {
      scope: "listing", signals: [], variants: [],
      identifiers: [{ type: "gtin", value: "4006381333931" }], imageUrls: [], instructionUrls: []
    };

    const resolved = reconcileProductCatalog([incomplete], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({ granularity: "unresolved", confidence: "partial" });
    expect(resolved.productIdentity?.canonicalVariantId).toBeUndefined();
  });

  it("uses an explicitly verified GTIN only when semantic facts do not conflict", () => {
    const source = observation("old", "Анвифен капсулы 100 мг №20", "Анвифен");
    source.productEvidence = {
      scope: "listing", signals: [], variants: [],
      identifiers: [{ type: "gtin", value: "verified:4006381333931" }], imageUrls: [], instructionUrls: []
    };
    const catalogued = reconcileProductCatalog([source])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand: source.brand,
      canonicalUrl: source.canonicalUrl, product: source.product, platform: "test",
      productIdentity: catalogued.productIdentity, productEvidence: source.productEvidence,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };
    const incomplete = observation("new", "Анвифен капсулы", "Анвифен");
    incomplete.productEvidence = {
      scope: "listing", signals: [], variants: [],
      identifiers: [{ type: "gtin", value: "verified:4006381333931" }], imageUrls: [], instructionUrls: []
    };

    const resolved = reconcileProductCatalog([incomplete], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({
      canonicalVariantId: catalogued.productIdentity?.canonicalVariantId,
      label: "капсулы 100 мг №20",
      resolutionMethod: "catalog_alias"
    });
  });

  it("rejects a verified GTIN when fresh semantic facts conflict", () => {
    const source = observation("old", "Анвифен капсулы 100 мг №20", "Анвифен");
    source.productEvidence = {
      scope: "listing", signals: [], variants: [],
      identifiers: [{ type: "gtin", value: "verified:4006381333931" }], imageUrls: [], instructionUrls: []
    };
    const catalogued = reconcileProductCatalog([source])[0]!;
    const prior: ProductRecord = {
      key: "old.example:old", domain: "old.example", listingId: "old", brand: source.brand,
      canonicalUrl: source.canonicalUrl, product: source.product, platform: "test",
      productIdentity: catalogued.productIdentity, productEvidence: source.productEvidence,
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    };
    const conflicting = observation("new", "Анвифен капсулы 250 мг №20", "Анвифен");
    conflicting.productEvidence = {
      scope: "listing", signals: [], variants: [],
      identifiers: [{ type: "gtin", value: "verified:4006381333931" }], imageUrls: [], instructionUrls: []
    };

    const resolved = reconcileProductCatalog([conflicting], [prior])[0]!;

    expect(resolved.productIdentity).toMatchObject({ granularity: "unresolved", confidence: "ambiguous" });
    expect(resolved.productIdentity?.canonicalVariantId).toBeUndefined();
  });

  it("rejects conflicting verified GTIN facts inside one fresh snapshot", () => {
    const observations = ["100", "250"].map((strength, index) => {
      const item = observation(String(index), `Анвифен капсулы ${strength} мг №20`, "Анвифен");
      item.productEvidence = {
        scope: "listing", signals: [], variants: [],
        identifiers: [{ type: "gtin", value: "verified:4006381333931" }], imageUrls: [], instructionUrls: []
      };
      return item;
    });

    const resolved = reconcileProductCatalog(observations);

    expect(resolved.map((item) => item.productIdentity?.granularity)).toEqual(["unresolved", "unresolved"]);
    expect(resolved.map((item) => item.productIdentity?.confidence)).toEqual(["ambiguous", "ambiguous"]);
    expect(resolved.every((item) => item.productIdentity?.canonicalVariantId === undefined)).toBe(true);
  });

  it("assigns one official SKU to base and seller-bundle offers", () => {
    const resolved = reconcileProductCatalog([
      observation("base", "Максилак Премиум капсулы №10", "Максилак"),
      observation("bundle", "Максилак Премиум капсулы №10, 2 упаковки", "Максилак")
    ]);

    expect(new Set(resolved.map((item) => item.productIdentity?.canonicalVariantId)).size).toBe(1);
    expect(resolved.map((item) => item.productIdentity?.label)).toEqual([
      "Премиум капсулы №10",
      "Премиум капсулы №10 ×2 упаковки"
    ]);
  });

  it("does not equate a missing strength with a known strength", () => {
    const resolved = reconcileProductCatalog([
      observation("known", "Анвифен капсулы 50 мг №20", "Анвифен"),
      observation("missing", "Анвифен капсулы №20", "Анвифен")
    ]);

    expect(new Set(resolved.map((item) => item.productIdentity?.canonicalVariantId)).size).toBe(2);
  });

  it("fails closed when historical records assign two IDs to one semantic variant", () => {
    const current = observation("new", "Анвифен капсулы 100 мг №20", "Анвифен");
    const prior = ["variant:v1:first", "variant:v1:second"].map((canonicalVariantId, index): ProductRecord => ({
      key: `old.example:${index}`, domain: "old.example", listingId: String(index), brand: current.brand,
      canonicalUrl: `https://old.example/${index}`, product: current.product, platform: "test",
      productIdentity: { ...current.productIdentity!, canonicalVariantId },
      firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    }));

    const resolved = reconcileProductCatalog([current], prior)[0]!;

    expect(resolved.productIdentity).toMatchObject({ granularity: "unresolved", confidence: "ambiguous" });
    expect(resolved.productIdentity?.canonicalVariantId).toBeUndefined();
  });

  it("fails closed when one historical ID contains incompatible semantic facts", () => {
    const canonicalVariantId = "variant:v1:conflicted";
    const current = observation("new", "Анвифен капсулы 50 мг №20", "Анвифен");
    const prior = ["50", "250"].map((strength, index): ProductRecord => {
      const item = observation(`old-${index}`, `Анвифен капсулы ${strength} мг №20`, "Анвифен");
      return {
        key: `old.example:${index}`, domain: "old.example", listingId: String(index), brand: item.brand,
        canonicalUrl: `https://old.example/${index}`, product: item.product, platform: "test",
        productIdentity: { ...item.productIdentity!, canonicalVariantId },
        firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
      };
    });

    const resolved = reconcileProductCatalog([current], prior)[0]!;

    expect(resolved.productIdentity).toMatchObject({ granularity: "unresolved", confidence: "ambiguous" });
    expect(resolved.productIdentity?.canonicalVariantId).toBeUndefined();
  });

  it("does not attach an aggregate to the only variant seen in a partial snapshot", () => {
    const brand = "Хондрофен";
    const family = observation("family", "Хондрофен", brand);
    family.productIdentity = {
      label: "Общий рейтинг бренда", granularity: "family", confidence: "partial",
      missing: [], reasons: ["source aggregate"]
    };
    const exact = observation("exact", "Хондрофен мазь 30 г", brand);

    const variants = canonicalProductVariants([
      { brand, product: family.product, productIdentity: family.productIdentity },
      { brand, product: exact.product, productIdentity: exact.productIdentity }
    ]);
    const resolved = reconcileProductCatalog([family, exact]);

    expect(variants[0]).toEqual({ label: "Общий рейтинг бренда" });
    expect(resolved[0]!.productIdentity?.canonicalVariantId).toBeUndefined();
    expect(resolved[1]!.productIdentity?.canonicalVariantId).toBeTruthy();
  });
});
