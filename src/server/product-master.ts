import { randomUUID } from "node:crypto";
import type { ProductFact, ProductVariant } from "../shared/product-master.js";

const HARD_DISCRIMINATORS = new Set<ProductFact["field"]>([
  "line",
  "form",
  "strength",
  "concentration",
  "volume",
  "pack",
  "route",
  "release",
  "unmodeled_discriminator"
]);

function factsByField(facts: readonly ProductFact[]): Map<ProductFact["field"], Set<string>> {
  const result = new Map<ProductFact["field"], Set<string>>();
  for (const fact of facts) {
    if (!HARD_DISCRIMINATORS.has(fact.field)) continue;
    const values = result.get(fact.field) ?? new Set<string>();
    values.add(`${fact.normalizedValue}\u0000${fact.unit ?? ""}`);
    result.set(fact.field, values);
  }
  return result;
}
/** Missing facts are unknown, never equality. Only explicitly incompatible
 * facts produce a hard conflict; the resolver may ask for review or create a
 * separate provisional variant when either side is incomplete. */
export function conflictingProductFacts(left: readonly ProductFact[], right: readonly ProductFact[]): string[] {
  const leftByField = factsByField(left);
  const rightByField = factsByField(right);
  const conflicts: string[] = [];
  for (const field of HARD_DISCRIMINATORS) {
    const leftValues = leftByField.get(field);
    const rightValues = rightByField.get(field);
    if (!leftValues || !rightValues) continue;
    if (![...leftValues].some((value) => rightValues.has(value))) conflicts.push(field);
  }
  return conflicts;
}

export function hasCompleteOfficialVariantFacts(facts: readonly ProductFact[]): boolean {
  const fields = new Set(facts.map((fact) => fact.field));
  return fields.has("form") && ["strength", "concentration", "volume", "pack"].some((field) => fields.has(field as ProductFact["field"]));
}

export function createProvisionalVariant(input: {
  brandId: string;
  familyId: string;
  label: string;
  facts: ProductFact[];
  now?: string;
}): ProductVariant {
  if (!hasCompleteOfficialVariantFacts(input.facts)) {
    throw new Error("A provisional official SKU requires form and at least one strength, concentration, volume or pack fact");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    id: randomUUID(),
    brandId: input.brandId,
    familyId: input.familyId,
    label: input.label,
    status: "provisional",
    facts: structuredClone(input.facts),
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
}

export type ProductIdentityModelInput = {
  normalizedTitle: string;
  facts: ProductFact[];
  candidateVariantIds: string[];
};

export type ProductIdentityModelResult = {
  candidateVariantId: string;
  probability: number;
  positiveEvidence: string[];
  negativeEvidence: string[];
  modelVersion: string;
};

/** Provider-neutral boundary. Implementations receive product identity facts
 * only; review text, Sheet URLs and credentials never cross this interface. */
export interface ProductIdentityModelProvider {
  rank(input: ProductIdentityModelInput): Promise<ProductIdentityModelResult[]>;
}
