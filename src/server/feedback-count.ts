import type { Observation } from "../shared/types.js";

const FEEDBACK_STATUSES = new Set<Observation["status"]>(["ok", "no_reviews", "needs_review"]);

/**
 * Convert separately labelled reviews/ratings/votes into the employee-facing
 * feedback count. Counts describe overlapping people, so the safest complete
 * value is their maximum, never their sum. Raw counters and evidence remain on
 * the observation for audit.
 */
export function normalizeObservationFeedback(observation: Observation): void {
  if (!FEEDBACK_STATUSES.has(observation.status)) return;

  const writtenReviews = observation.reviews;
  const ratingCount = observation.ratingCount ?? null;
  const candidates = [writtenReviews, ratingCount].filter((value): value is number => value !== null);
  if (candidates.length === 0) return;

  const feedbackCount = Math.max(...candidates);
  if (feedbackCount !== writtenReviews) {
    if (!("writtenReviewCount" in observation)) observation.writtenReviewCount = writtenReviews;
    observation.reviews = feedbackCount;
  }

  if (feedbackCount > 0) {
    if (observation.status === "no_reviews") observation.status = "ok";
    return;
  }

  observation.rating = null;
  delete observation.ratingUnavailable;
  if (observation.status === "ok") observation.status = "no_reviews";
}
