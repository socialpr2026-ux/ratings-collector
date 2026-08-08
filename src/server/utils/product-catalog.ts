import { createHash } from "node:crypto";
import type { Observation, ProductEvidence, ProductIdentity, ProductRecord } from "../../shared/types.js";
import { normalizeText } from "./normalize.js";
import { analyzeProductIdentity, canonicalProductVariants } from "./product-name.js";

export const PRODUCT_VARIANT_KEY_VERSION = 1;

type CatalogTarget = {
  id: string;
  label: string;
};

function variantId(variantKey: string): string {
  const digest = createHash("sha256").update(`v${PRODUCT_VARIANT_KEY_VERSION}\u0000${variantKey}`).digest("hex");
  return `variant:v${PRODUCT_VARIANT_KEY_VERSION}:${digest.slice(0, 32)}`;
}

function aliasKey(brand: string, product: string): string {
  return `${normalizeText(brand)}\u0000${normalizeText(product)}`;
}

function isValidGtin(value: string): boolean {
  if (![8, 12, 13, 14].includes(value.length)) return false;
  const checkDigit = Number(value.at(-1));
  let sum = 0;
  for (let index = value.length - 2, position = 0; index >= 0; index -= 1, position += 1) {
    sum += Number(value[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - sum % 10) % 10 === checkDigit;
}

function gtinKeys(
  brand: string,
  evidence: Observation["productEvidence"] | ProductRecord["productEvidence"]
): string[] {
  return [...new Set((evidence?.identifiers ?? [])
    .filter(({ type }) => type === "gtin")
    .map(({ value }) => value.replace(/\D/g, ""))
    .filter(isValidGtin)
    .map((value) => `${normalizeText(brand)}\u0000${value}`))];
}

/** Product records keep only compact cross-source identifiers; full evidence remains in monthly snapshots. */
export function compactProductCatalogEvidence(evidence: ProductEvidence | undefined): ProductEvidence | undefined {
  const identifiers = (evidence?.identifiers ?? []).filter(({ type, value }) =>
    type === "gtin" && isValidGtin(value.replace(/\D/g, ""))
  );
  if (identifiers.length === 0) return undefined;
  return {
    scope: evidence?.scope ?? "listing",
    signals: [],
    variants: [],
    identifiers,
    imageUrls: [],
    instructionUrls: []
  };
}

function isSafeGlobalAlias(item: Pick<Observation, "brand" | "product" | "productOverride"> | ProductRecord): boolean {
  if (item.productOverride?.trim()) return true;
  const rawIdentity = analyzeProductIdentity({ brand: item.brand, product: item.product });
  return rawIdentity.granularity === "variant" && rawIdentity.confidence === "exact";
}

function addTarget(map: Map<string, Map<string, CatalogTarget>>, key: string, target: CatalogTarget): void {
  const targets = map.get(key) ?? new Map<string, CatalogTarget>();
  targets.set(target.id, target);
  map.set(key, targets);
}

function uniqueTarget(
  maps: Array<Map<string, Map<string, CatalogTarget>>>,
  keys: string[]
): CatalogTarget | undefined {
  const targets = new Map<string, CatalogTarget>();
  for (const map of maps) {
    for (const key of keys) {
      for (const target of map.get(key)?.values() ?? []) targets.set(target.id, target);
    }
  }
  return targets.size === 1 ? targets.values().next().value : undefined;
}

function resolvedIdentity(
  identity: ProductIdentity,
  target: CatalogTarget,
  method: NonNullable<ProductIdentity["resolutionMethod"]>
): ProductIdentity {
  return {
    ...identity,
    label: target.label,
    granularity: "variant",
    confidence: "exact",
    missing: [],
    reasons: method === "catalog_alias"
      ? [...new Set([...identity.reasons, "Название сопоставлено с подтверждённым каталогом вариантов"])]
      : [...identity.reasons],
    canonicalVariantId: target.id,
    variantKeyVersion: PRODUCT_VARIANT_KEY_VERSION,
    resolutionMethod: method
  };
}

function catalogConflictIdentity(identity: ProductIdentity, label: string): ProductIdentity {
  return {
    ...identity,
    label,
    granularity: "unresolved",
    confidence: "ambiguous",
    missing: [],
    reasons: [...new Set([...identity.reasons, "Каталог содержит несколько идентификаторов этого варианта"])],
    canonicalVariantId: undefined,
    variantKeyVersion: PRODUCT_VARIANT_KEY_VERSION,
    resolutionMethod: undefined
  };
}

/**
 * Builds the brand-wide catalog after collection, then assigns stable IDs to
 * exact real variants. Raw source titles and source-bound aggregate semantics
 * remain untouched. Published aliases and GTINs may resolve an incomplete
 * title only when they point to exactly one non-conflicting catalog target.
 */
export function reconcileProductCatalog(
  observations: readonly Observation[],
  published: readonly ProductRecord[] = []
): Observation[] {
  const result = observations.map((item) => structuredClone(item));
  const aliases = new Map<string, Map<string, CatalogTarget>>();
  const gtinTargets = new Map<string, Map<string, CatalogTarget>>();
  const publishedVariants = published.filter((record) =>
    record.productIdentity?.granularity === "variant" &&
    record.productIdentity.confidence === "exact"
  );
  const combinedInputs = [
    ...publishedVariants.map((record) => ({
      brand: record.brand,
      product: record.product,
      url: record.canonicalUrl,
      evidence: record.productEvidence,
      productIdentity: record.productIdentity
    })),
    ...result.map((item) => ({
    brand: item.brand,
    product: item.product,
    url: item.canonicalUrl,
    evidence: item.productEvidence,
    productIdentity: item.productIdentity
    }))
  ];
  const combinedVariants = canonicalProductVariants(combinedInputs);
  const variantTargets = new Map<string, Map<string, CatalogTarget>>();
  const targetVariantKeys = new Map<string, Set<string>>();

  publishedVariants.forEach((record, index) => {
    const identity = record.productIdentity!;
    const variantKey = combinedVariants[index]?.variantKey;
    if (!variantKey) return;
    const target = { id: identity.canonicalVariantId ?? variantId(variantKey), label: identity.label };
    if (isSafeGlobalAlias(record)) addTarget(aliases, aliasKey(record.brand, record.product), target);
    for (const gtin of gtinKeys(record.brand, record.productEvidence)) addTarget(gtinTargets, gtin, target);
    addTarget(variantTargets, variantKey, target);
    const keys = targetVariantKeys.get(target.id) ?? new Set<string>();
    keys.add(variantKey);
    targetVariantKeys.set(target.id, keys);
  });

  result.forEach((item, index) => {
    const identity = item.productIdentity;
    const variant = combinedVariants[publishedVariants.length + index]!;
    if (identity?.granularity !== "variant" || identity.confidence !== "exact" || !variant.variantKey) return;
    const compatibleTargets = new Map<string, CatalogTarget>(variantTargets.get(variant.variantKey));
    for (const gtin of gtinKeys(item.brand, item.productEvidence)) {
      for (const target of gtinTargets.get(gtin)?.values() ?? []) {
        const knownKeys = targetVariantKeys.get(target.id);
        if (!knownKeys || knownKeys.has(variant.variantKey)) compatibleTargets.set(target.id, target);
      }
    }
    if (compatibleTargets.size > 1) {
      item.productIdentity = catalogConflictIdentity(identity, variant.label);
      return;
    }
    const target = compatibleTargets.size === 1
      ? { ...compatibleTargets.values().next().value!, label: variant.label }
      : { id: variantId(variant.variantKey), label: variant.label };
    item.productIdentity = resolvedIdentity(
      identity,
      target,
      item.productOverride ? "operator_override" : "source_facts"
    );
    if (isSafeGlobalAlias(item)) addTarget(aliases, aliasKey(item.brand, item.product), target);
    for (const gtin of gtinKeys(item.brand, item.productEvidence)) addTarget(gtinTargets, gtin, target);
    addTarget(variantTargets, variant.variantKey, target);
  });

  result.forEach((item) => {
    const identity = item.productIdentity;
    if (identity?.granularity !== "unresolved" || identity.confidence !== "partial") return;
    const target = uniqueTarget(
      [aliases, gtinTargets],
      [aliasKey(item.brand, item.product), ...gtinKeys(item.brand, item.productEvidence)]
    );
    if (!target) return;
    item.productIdentity = resolvedIdentity(identity, target, "catalog_alias");
  });

  return result;
}
