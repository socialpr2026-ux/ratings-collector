import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { productAliasSchema, productMasterCatalogSchema, type ProductFact } from "../src/shared/product-master.js";
import { conflictingProductFacts, createProvisionalVariant, hasCompleteOfficialVariantFacts } from "../src/server/product-master.js";

const observedAt = "2026-08-11T00:00:00.000Z";
const fact = (field: ProductFact["field"], normalizedValue: string): ProductFact => ({
  field,
  value: normalizedValue,
  normalizedValue,
  sourceKind: "source_title",
  sourceRef: "ozon.ru/sku/1",
  extractorVersion: "2",
  observedAt
});

describe("Product Master v2 contracts", () => {
  it("treats known incompatible strength and product line facts as hard negatives", () => {
    expect(conflictingProductFacts(
      [fact("line", "синбиотик"), fact("strength", "50")],
      [fact("line", "премиум"), fact("strength", "250")]
    )).toEqual(["line", "strength"]);
  });

  it("does not treat a missing discriminator as equality or as a fabricated conflict", () => {
    expect(conflictingProductFacts([fact("form", "капсулы")], [fact("form", "капсулы"), fact("strength", "50")]))
      .toEqual([]);
    expect(hasCompleteOfficialVariantFacts([fact("form", "капсулы")])).toBe(false);
  });

  it("creates a stable opaque provisional ID without deriving it from mutable facts", () => {
    const brandId = randomUUID();
    const familyId = randomUUID();
    const variant = createProvisionalVariant({
      brandId,
      familyId,
      label: "Анвифен капсулы 50 мг №20",
      facts: [fact("form", "капсулы"), fact("strength", "50 мг"), fact("pack", "20")],
      now: observedAt
    });
    expect(variant).toMatchObject({ brandId, familyId, status: "provisional", revision: 1 });
    expect(() => createProvisionalVariant({ brandId, familyId, label: "Анвифен капсулы", facts: [fact("form", "капсулы")] }))
      .toThrow("requires form");
  });

  it("forbids an operator-only alias from becoming global", () => {
    expect(productAliasSchema.safeParse({
      id: randomUUID(),
      variantId: randomUUID(),
      label: "Анвифен капсулы",
      normalizedLabel: "анвифен капсулы",
      scope: "global",
      supportCount: 1,
      provenance: "operator",
      createdAt: observedAt,
      updatedAt: observedAt
    }).success).toBe(false);
  });

  it("accepts an empty versioned global catalog for shadow rollout", () => {
    expect(productMasterCatalogSchema.parse({
      schemaVersion: 2,
      revision: 0,
      brands: [], families: [], variants: [], identifiers: [], crosswalks: [], aliases: [],
      aggregates: [], decisions: [], legacyIds: [], updatedAt: observedAt
    })).toMatchObject({ schemaVersion: 2, revision: 0 });
  });
});
