import type { Observation, ProductIdentity } from "../../shared/types.js";
import { analyzeProductIdentity } from "./product-name.js";

const MAX_PRODUCT_OVERRIDE_LENGTH = 240;
const EXPLICIT_PACK_COUNT = /(?:№|#|\bN(?:o)?\.?)\s*(\d{1,4})(?!\d)|(?<!\d)(\d{1,4})\s*(?:шт(?:\.|\u0443к[\u0430и]?)?|\u0442аблет(?:\u043eк|\u043a\u0438|\u043a\u0430)?|\u043aапсул(?:\u0430|\u044b)?|\u0430мпул(?:\u0430|\u044b)?|\u0444лакон(?:\u0430|\u043eв|\u044b)?|\u0441аше|\u043fакет(?:\u0430|\u043eв|\u044b)?|\u0434оз(?:\u0430|\u044b)?)(?![\p{L}\p{N}])/giu;

export function normalizeProductOverride(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function explicitPackCounts(value: string): number[] {
  const counts = new Set<number>();
  for (const match of value.matchAll(EXPLICIT_PACK_COUNT)) {
    const count = Number(match[1] ?? match[2]);
    if (Number.isInteger(count) && count > 0) counts.add(count);
  }
  return [...counts];
}

/**
 * Manual review may refine only the human product label. Metrics, URL, brand
 * and platform identity remain immutable. A vague family label is not enough:
 * the edited value must prove one concrete sellable variant.
 */
export function resolveProductOverride(
  item: Pick<Observation, "brand" | "canonicalUrl">,
  value: string
): ProductIdentity | undefined {
  const normalized = normalizeProductOverride(value);
  if (!normalized || normalized.length > MAX_PRODUCT_OVERRIDE_LENGTH) return undefined;
  const identity = analyzeProductIdentity({
    brand: item.brand,
    product: `${item.brand} ${normalized}`,
    url: item.canonicalUrl
  });
  if (identity.granularity !== "variant" || identity.confidence !== "exact") return undefined;
  const packCounts = explicitPackCounts(normalized);
  if (packCounts.length > 1) {
    return {
      label: normalized,
      granularity: "family",
      confidence: "exact",
      missing: [],
      reasons: ["Общая карточка вариантов уточнена и подтверждена оператором"],
      variantCount: packCounts.length
    };
  }
  return {
    ...identity,
    reasons: ["Вариант уточнён и подтверждён оператором"]
  };
}
