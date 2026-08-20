import type { Observation } from "./types.js";

const REVIEW_AGGREGATE_DOMAINS = new Set([
  "irecommend.ru",
  "otzovik.com",
  "otzyv.pro",
  "vseotzyvy.ru",
  "otzyvru.com",
  "pravogolosa.net",
  "ru.otzyv.com",
  "009.xn--p1ai",
  "uteka.ru",
  "megapteka.ru",
  "ozerki.ru",
  "med-otzyv.ru",
  // Yandex Reviews is its own review source. Yandex Market is a marketplace
  // and must never borrow this aggregate or completeness contract.
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
