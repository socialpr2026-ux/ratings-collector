export const MAX_RATING_DECIMAL_PLACES = 2;

/** Normalize a source score to 0-5 while retaining meaningful hundredths. */
export function normalizeRatingToFive(value: number, scale = 5): number {
  if (!Number.isFinite(value) || !Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("Rating and rating scale must be finite; scale must be positive");
  }
  const normalized = Math.max(0, Math.min(5, value / scale * 5));
  const factor = 10 ** MAX_RATING_DECIMAL_PLACES;
  // Ratings are bounded by five. A scale-aware epsilon makes decimal ties
  // such as 9.87/10 = 4.935 deterministic despite IEEE-754 representation.
  return Math.round((normalized + Number.EPSILON * factor) * factor) / factor;
}

/** Display only the precision carried by the value, up to hundredths. */
export function formatRatingValue(value: number | null, locale = "ru-RU"): string {
  return value === null
    ? "—"
    : value.toLocaleString(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: MAX_RATING_DECIMAL_PLACES
      });
}
