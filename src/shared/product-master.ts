import { z } from "zod";

const timestamp = z.string().datetime();
const entityId = z.string().uuid();

export const productFactFieldSchema = z.enum([
  "trade_name",
  "line",
  "form",
  "strength",
  "concentration",
  "volume",
  "pack",
  "route",
  "release",
  "audience",
  "flavor",
  "manufacturer",
  "unmodeled_discriminator"
]);

export const productFactSchema = z.object({
  field: productFactFieldSchema,
  value: z.string().min(1).max(500),
  normalizedValue: z.string().min(1).max(500),
  unit: z.string().min(1).max(50).optional(),
  sourceKind: z.enum([
    "registry",
    "gtin_registry",
    "source_json",
    "json_ld",
    "source_title",
    "operator",
    "model_suggestion"
  ]),
  sourceRef: z.string().min(1).max(2_000),
  extractorVersion: z.string().min(1).max(100),
  observedAt: timestamp
});

export type ProductFact = z.infer<typeof productFactSchema>;

export const canonicalBrandSchema = z.object({
  id: entityId,
  label: z.string().min(1).max(300),
  normalizedLabel: z.string().min(1).max(300),
  aliases: z.array(z.string().min(1).max(300)).default([]),
  createdAt: timestamp,
  updatedAt: timestamp
});

export const productFamilySchema = z.object({
  id: entityId,
  brandId: entityId,
  label: z.string().min(1).max(500),
  normalizedLabel: z.string().min(1).max(500),
  createdAt: timestamp,
  updatedAt: timestamp
});

export const productVariantSchema = z.object({
  id: entityId,
  brandId: entityId,
  familyId: entityId,
  label: z.string().min(1).max(1_000),
  status: z.enum(["provisional", "confirmed", "retired"]),
  facts: z.array(productFactSchema),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp
});

export const externalIdentifierSchema = z.object({
  namespace: z.enum(["gtin", "registration_id", "model_id", "sku", "product_id", "nm_id"]),
  value: z.string().min(1).max(300),
  variantId: entityId,
  domain: z.string().min(1).max(253).optional(),
  verified: z.boolean(),
  authority: z.string().min(1).max(300).optional(),
  verifiedAt: timestamp.optional()
}).superRefine((identifier, context) => {
  if (identifier.verified && (!identifier.authority || !identifier.verifiedAt)) {
    context.addIssue({ code: "custom", message: "Verified identifiers require authority and verifiedAt" });
  }
  if (["model_id", "sku", "product_id", "nm_id"].includes(identifier.namespace) && !identifier.domain) {
    context.addIssue({ code: "custom", message: "Source identifiers require domain scope" });
  }
});

export const sourceListingCrosswalkSchema = z.object({
  domain: z.string().min(1).max(253),
  listingId: z.string().min(1).max(500),
  variantId: entityId,
  sourceSignature: z.string().min(1).max(256),
  confirmedAt: timestamp,
  lastObservedAt: timestamp,
  catalogRevision: z.number().int().positive()
});

export const productAliasSchema = z.object({
  id: entityId,
  variantId: entityId,
  label: z.string().min(1).max(1_000),
  normalizedLabel: z.string().min(1).max(1_000),
  scope: z.enum(["listing", "domain", "global"]),
  domain: z.string().min(1).max(253).optional(),
  listingId: z.string().min(1).max(500).optional(),
  supportCount: z.number().int().positive(),
  provenance: z.enum(["operator", "authoritative_id", "cross_domain_consensus"]),
  createdAt: timestamp,
  updatedAt: timestamp
}).superRefine((alias, context) => {
  if (alias.scope === "listing" && (!alias.domain || !alias.listingId)) {
    context.addIssue({ code: "custom", message: "Listing aliases require domain and listingId" });
  }
  if (alias.scope === "domain" && !alias.domain) {
    context.addIssue({ code: "custom", message: "Domain aliases require domain" });
  }
  if (alias.scope === "global" && alias.provenance === "operator") {
    context.addIssue({ code: "custom", message: "Operator aliases cannot become global without independent proof" });
  }
});

export const ratingAggregateSchema = z.object({
  id: entityId,
  domain: z.string().min(1).max(253),
  sourceAggregateKey: z.string().min(1).max(500),
  scope: z.enum(["brand", "line", "closed_variant_set", "open_variant_set"]),
  memberVariantIds: z.array(entityId),
  membershipComplete: z.boolean(),
  evidenceRef: z.string().min(1).max(2_000),
  proofVersion: z.string().min(1).max(100),
  observedAt: timestamp
});

export const resolutionDecisionSchema = z.object({
  id: entityId,
  domain: z.string().min(1).max(253),
  listingId: z.string().min(1).max(500),
  outcome: z.enum(["linked", "created_provisional", "aggregate", "excluded", "unresolved"]),
  variantId: entityId.optional(),
  aggregateId: entityId.optional(),
  probability: z.number().min(0).max(1).optional(),
  candidates: z.array(z.object({
    variantId: entityId,
    probability: z.number().min(0).max(1),
    positiveEvidence: z.array(z.string().max(500)),
    negativeEvidence: z.array(z.string().max(500))
  })).max(20),
  policyVersion: z.string().min(1).max(100),
  modelVersion: z.string().min(1).max(200).optional(),
  catalogRevision: z.number().int().positive(),
  actorId: z.string().min(1).max(300),
  decidedAt: timestamp
});

export const legacyVariantIdMapSchema = z.object({
  legacyId: z.string().min(1).max(500),
  variantId: entityId,
  migratedAt: timestamp,
  catalogRevision: z.number().int().positive()
});

export const productMasterCatalogSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  brands: z.array(canonicalBrandSchema),
  families: z.array(productFamilySchema),
  variants: z.array(productVariantSchema),
  identifiers: z.array(externalIdentifierSchema),
  crosswalks: z.array(sourceListingCrosswalkSchema),
  aliases: z.array(productAliasSchema),
  aggregates: z.array(ratingAggregateSchema),
  decisions: z.array(resolutionDecisionSchema),
  legacyIds: z.array(legacyVariantIdMapSchema),
  updatedAt: timestamp
});

export type CanonicalBrand = z.infer<typeof canonicalBrandSchema>;
export type ProductFamily = z.infer<typeof productFamilySchema>;
export type ProductVariant = z.infer<typeof productVariantSchema>;
export type ExternalIdentifier = z.infer<typeof externalIdentifierSchema>;
export type SourceListingCrosswalk = z.infer<typeof sourceListingCrosswalkSchema>;
export type ProductAlias = z.infer<typeof productAliasSchema>;
export type RatingAggregate = z.infer<typeof ratingAggregateSchema>;
export type ResolutionDecision = z.infer<typeof resolutionDecisionSchema>;
export type LegacyVariantIdMap = z.infer<typeof legacyVariantIdMapSchema>;
export type ProductMasterCatalog = z.infer<typeof productMasterCatalogSchema>;

