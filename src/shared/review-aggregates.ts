import type { Observation } from "./types.js";

const REVIEW_AGGREGATE_DOMAINS = new Set([
  "irecommend.ru",
  "otzovik.com",
  "otzyv.pro",
  "vseotzyvy.ru",
  "otzyvru.com",
  "pravogolosa.net",
  "ru.otzyv.com",
  "uteka.ru",
  "megapteka.ru",
  "med-otzyv.ru",
  // The Yandex Reviews adapter publishes one stable modelId aggregate and
  // already de-duplicates seller offers. Some model pages are brand-level
  // rather than a dosage/pack SKU, so they need the same explicit operator
  // confirmation path as other proven review aggregates.
  "market.yandex.ru",
  "reviews.yandex.ru"
]);

/** These adapters collect a review aggregate for a product family, not a seller SKU. */
export function isKnownReviewAggregateDomain(domain: string | undefined): boolean {
  return Boolean(domain && REVIEW_AGGREGATE_DOMAINS.has(domain.toLocaleLowerCase("ru-RU").replace(/^www\./, "")));
}

function canonicalBelongsToDomain(domain: string, canonicalUrl: string): boolean {
  try {
    const hostname = new URL(canonicalUrl).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    const normalizedDomain = domain.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (normalizedDomain === "market.yandex.ru") return hostname === "market.yandex.ru" || hostname === "reviews.yandex.ru";
    return hostname === normalizedDomain;
  } catch {
    return false;
  }
}

/**
 * A dedicated adapter may publish a family/model aggregate without asking an
 * employee to approve it again. Generic profiles remain review-only: they
 * carry profileVersion and deliberately fail this proof gate.
 */
export function hasDeterministicAggregateProof(item: Pick<
  Observation,
  "domain" | "listingId" | "canonicalUrl" | "reviews" | "rating" | "ratingUnavailable" |
  "evidenceRef" | "source" | "productEvidence" | "productIdentity" | "profileVersion"
>): boolean {
  const identity = item.productIdentity;
  const evidence = item.productEvidence;
  if (item.profileVersion !== undefined || !isKnownReviewAggregateDomain(item.domain)) return false;
  if (!identity || !["family", "line"].includes(identity.granularity) || identity.confidence === "ambiguous") return false;
  if (!evidence || !item.evidenceRef?.trim() || !item.source?.trim() || !item.listingId.trim()) return false;
  if (!canonicalBelongsToDomain(item.domain, item.canonicalUrl)) return false;
  if (item.reviews === null || item.reviews < 0) return false;
  if (item.reviews === 0 ? item.rating !== null : item.rating === null && item.ratingUnavailable !== true) return false;

  const stableModel = evidence.identifiers.some((identifier) =>
    ["model_id", "product_id", "gtin", "registration_id"].includes(identifier.type) && identifier.value.trim().length > 0
  );
  return evidence.scope === "product_family" || stableModel;
}
