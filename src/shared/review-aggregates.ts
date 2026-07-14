const REVIEW_AGGREGATE_DOMAINS = new Set([
  "irecommend.ru",
  "otzovik.com",
  "otzyv.pro",
  "vseotzyvy.ru",
  "otzyvru.com",
  "pravogolosa.net",
  "ru.otzyv.com",
  "uteka.ru",
  "megapteka.ru"
]);

/** These adapters collect a review aggregate for a product family, not a seller SKU. */
export function isKnownReviewAggregateDomain(domain: string | undefined): boolean {
  return Boolean(domain && REVIEW_AGGREGATE_DOMAINS.has(domain.toLocaleLowerCase("ru-RU").replace(/^www\./, "")));
}
