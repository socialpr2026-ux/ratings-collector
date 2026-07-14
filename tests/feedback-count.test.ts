import { describe, expect, it } from "vitest";
import type { Observation } from "../src/shared/types.js";
import { normalizeObservationFeedback } from "../src/server/feedback-count.js";

function observation(overrides: Partial<Observation>): Observation {
  return {
    domain: "example.com",
    platform: "example",
    listingId: "1",
    brand: "Кагоцел",
    canonicalUrl: "https://example.com/product/1",
    product: "Кагоцел таблетки 12 мг №10",
    reviews: 0,
    rating: 5,
    status: "ok",
    capturedAt: "2026-07-14T00:00:00.000Z",
    evidenceRef: "blob://immutable-evidence",
    ...overrides
  };
}

describe("unified feedback count", () => {
  it("uses Yandex ratingCount when it is more complete than written reviews", () => {
    const item = observation({ domain: "market.yandex.ru", reviews: 711, ratingCount: 1828, rating: 4.7 });

    normalizeObservationFeedback(item);

    expect(item).toMatchObject({ reviews: 1828, writtenReviewCount: 711, ratingCount: 1828, evidenceRef: "blob://immutable-evidence" });
  });

  it("promotes a Megapteka no_reviews observation when one rating is proven", () => {
    const item = observation({ domain: "megapteka.ru", reviews: 0, ratingCount: 1, status: "no_reviews" });

    normalizeObservationFeedback(item);

    expect(item).toMatchObject({ reviews: 1, writtenReviewCount: 0, ratingCount: 1, rating: 5, status: "ok" });
  });

  it("uses the larger Zdravcity rating count without losing the written count", () => {
    const item = observation({ domain: "zdravcity.ru", reviews: 12, ratingCount: 21 });

    normalizeObservationFeedback(item);

    expect(item).toMatchObject({ reviews: 21, writtenReviewCount: 12, ratingCount: 21 });
  });

  it("does not add equal counters together", () => {
    const item = observation({ reviews: 20, ratingCount: 20 });

    normalizeObservationFeedback(item);

    expect(item.reviews).toBe(20);
    expect(item).not.toHaveProperty("writtenReviewCount");
  });

  it("does not synthesize metrics for blocked observations", () => {
    const item = observation({ reviews: null, ratingCount: 30, rating: null, status: "blocked" });

    normalizeObservationFeedback(item);

    expect(item).toMatchObject({ reviews: null, ratingCount: 30, rating: null, status: "blocked" });
    expect(item).not.toHaveProperty("writtenReviewCount");
  });
});
