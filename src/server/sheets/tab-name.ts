export const RATINGS_TAB_NAME = "Ratings" as const;
export const LEGACY_RATINGS_TAB_NAME = "Рейтинги" as const;

export type RatingsTabName = typeof RATINGS_TAB_NAME | typeof LEGACY_RATINGS_TAB_NAME;

export function isRatingsTabName(value: unknown): value is RatingsTabName {
  return value === RATINGS_TAB_NAME || value === LEGACY_RATINGS_TAB_NAME;
}
