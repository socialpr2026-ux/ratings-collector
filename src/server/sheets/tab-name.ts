export const RATINGS_TAB_NAME = "Ratings" as const;
export const LEGACY_RATINGS_TAB_NAME = "Рейтинги" as const;
export const BRAND_RATINGS_TAB_PREFIX = "Ratings " as const;

export type RatingsTabName = string;

const INVALID_TAB_CHARACTERS = /[\[\]*?:\\/]/gu;
const HAS_INVALID_TAB_CHARACTER = /[\[\]*?:\\/]/u;

export function ratingsTabNameForBrand(brand: string): RatingsTabName {
  const normalized = brand
    .normalize("NFKC")
    .replace(INVALID_TAB_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) throw new Error("Название бренда не подходит для вкладки Google Sheets");
  return `${BRAND_RATINGS_TAB_PREFIX}${normalized}`.slice(0, 100).trimEnd();
}

export function isRatingsTabName(value: unknown): value is RatingsTabName {
  if (value === RATINGS_TAB_NAME || value === LEGACY_RATINGS_TAB_NAME) return true;
  return typeof value === "string" &&
    value.length <= 100 &&
    value.startsWith(BRAND_RATINGS_TAB_PREFIX) &&
    value.length > BRAND_RATINGS_TAB_PREFIX.length &&
    !HAS_INVALID_TAB_CHARACTER.test(value);
}
