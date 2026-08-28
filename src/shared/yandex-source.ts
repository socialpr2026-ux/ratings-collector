export type YandexSourceDomain = "market.yandex.ru" | "reviews.yandex.ru";

export type YandexSourceListing = {
  domain: YandexSourceDomain;
  listingId: string;
  /** Market discovery pages omit `/reviews`; retained collection cards do not. */
  collectionCard: boolean;
};

const REVIEWS_PRODUCT_PATH = /^\/product\/[a-z0-9][a-z0-9_-]*--(\d+)\/?$/i;
const MARKET_CARD_PATH = /^\/card\/[a-z0-9][a-z0-9-]*\/(\d+)(\/reviews)?\/?$/i;

/**
 * Classifies only exact first-party Yandex product routes. Search, sitemap,
 * translated and decorated URLs are deliberately excluded so a retained card
 * can never change source merely because both platforms use numeric IDs.
 */
export function yandexSourceListing(input: string): YandexSourceListing | undefined {
  let url: URL;
  try { url = new URL(input); }
  catch { return undefined; }
  if (
    url.protocol !== "https:" || url.port || url.username || url.password ||
    url.search || url.hash
  ) return undefined;

  if (url.hostname === "reviews.yandex.ru") {
    const match = url.pathname.match(REVIEWS_PRODUCT_PATH);
    return match ? { domain: "reviews.yandex.ru", listingId: match[1]!, collectionCard: true } : undefined;
  }
  if (url.hostname === "market.yandex.ru") {
    const match = url.pathname.match(MARKET_CARD_PATH);
    return match ? {
      domain: "market.yandex.ru",
      listingId: match[1]!,
      collectionCard: match[2] === "/reviews"
    } : undefined;
  }
  return undefined;
}

export function isSourceBoundYandexCard(domain: string, listingId: string, url: string): boolean {
  const listing = yandexSourceListing(url);
  return listing?.domain === domain && listing.listingId === listingId && listing.collectionCard;
}

export function isYandexSourceDomain(domain: string): domain is YandexSourceDomain {
  return domain === "market.yandex.ru" || domain === "reviews.yandex.ru";
}
