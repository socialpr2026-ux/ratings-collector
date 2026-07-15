import { describe, expect, it } from "vitest";
import { formatRatingValue, normalizeRatingToFive } from "../src/shared/rating.js";
import { observationSchema } from "../src/shared/types.js";

describe("rating precision contract", () => {
  it("retains source hundredths and does not invent trailing precision", () => {
    expect(normalizeRatingToFive(4.93)).toBe(4.93);
    expect(normalizeRatingToFive(4.9)).toBe(4.9);
    expect(normalizeRatingToFive(4.0)).toBe(4);

    expect(formatRatingValue(4.93)).toBe("4,93");
    expect(formatRatingValue(4.9)).toBe("4,9");
    expect(formatRatingValue(4.0)).toBe("4");
  });

  it("normalizes alternate scales to 0-5 with at most two decimals", () => {
    expect(normalizeRatingToFive(9.87, 10)).toBe(4.94);
    expect(normalizeRatingToFive(87, 100)).toBe(4.35);
    expect(normalizeRatingToFive(11, 10)).toBe(5);
  });

  it("quantizes the public observation while preserving its raw source value", () => {
    const parsed = observationSchema.parse({
      domain: "example.com",
      platform: "Example",
      listingId: "one",
      brand: "Бренд",
      canonicalUrl: "https://example.com/product/one",
      product: "Бренд — таблетки №10",
      reviews: 12,
      rating: 4.938,
      rawRating: 4.938,
      rawRatingScale: 5,
      status: "ok",
      capturedAt: "2026-07-16T00:00:00.000Z"
    });

    expect(parsed.rating).toBe(4.94);
    expect(parsed.rawRating).toBe(4.938);
  });
});
