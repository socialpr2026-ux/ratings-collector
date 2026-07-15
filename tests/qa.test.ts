import { describe, expect, it } from "vitest";
import type { RunState } from "../src/shared/types.js";
import { validateRun } from "../src/server/qa.js";

function runWithCounts(discovered: number, collected: number, includeObservation = true): RunState {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    request: {
      sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
      month: "2026-07",
      region: "Москва",
      domains: ["example.com"],
      brands: ["Бренд"]
    },
    status: "review",
    createdAt: now,
    updatedAt: now,
    progress: { totalPartitions: 1, completedPartitions: 1 },
    partitions: [{ domain: "example.com", brand: "Бренд", status: "complete", discovered, collected }],
    observations: includeObservation ? [{
      domain: "example.com",
      platform: "example",
      listingId: "1",
      brand: "Бренд",
      canonicalUrl: "https://example.com/product/1",
      product: "Бренд — упаковка",
      reviews: 2,
      rating: 4.5,
      status: "ok",
      capturedAt: now
    }] : [],
    errors: []
  };
}

describe("partition completeness QA", () => {
  it("blocks a partition when not every discovered card was collected", () => {
    const qa = validateRun(runWithCounts(2, 1));
    expect(qa.ok).toBe(false);
    expect(qa.blockers.join(" ")).toContain("собрано 1 из 2");
  });

  it("blocks a partition when collected metadata has no matching observation", () => {
    const qa = validateRun(runWithCounts(1, 1, false));
    expect(qa.ok).toBe(false);
    expect(qa.blockers.join(" ")).toContain("в снимке 0 карточек");
  });

  it("accepts a domain whose every brand was exhaustively checked with no results", () => {
    const run = runWithCounts(0, 0, false);
    run.partitions[0].status = "no_results";

    expect(validateRun(run)).toMatchObject({ ok: true, blockers: [] });
  });

  it("accepts only explicit historical not_found observations with empty metrics", () => {
    const historical = runWithCounts(1, 1);
    historical.observations[0] = {
      ...historical.observations[0],
      reviews: null,
      rating: null,
      status: "not_found",
      historical: true
    };
    expect(validateRun(historical).ok).toBe(true);

    const unregistered = structuredClone(historical);
    delete unregistered.observations[0].historical;
    const qa = validateRun(unregistered);
    expect(qa.ok).toBe(false);
    expect(qa.blockers.join(" ")).toContain("not_found допустим только для исторической карточки");
  });

  it("accepts a verified product with reviews when the platform has no aggregate rating", () => {
    const run = runWithCounts(1, 1);
    run.observations[0] = {
      ...run.observations[0],
      rating: null,
      rawRating: 0,
      ratingUnavailable: true
    };

    const qa = validateRun(run);
    expect(qa.ok).toBe(true);
    expect(qa.warnings.join(" ")).toContain("не рассчитала общий рейтинг");
  });

  it("accepts an explicit null raw rating when the platform does not calculate an aggregate", () => {
    const run = runWithCounts(1, 1);
    run.observations[0] = {
      ...run.observations[0],
      rating: null,
      rawRating: null,
      ratingUnavailable: true
    };

    expect(validateRun(run)).toMatchObject({
      ok: true,
      blockers: [],
      warnings: [expect.stringContaining("не рассчитала общий рейтинг")]
    });
  });

  it("blocks an unknown or contradictory missing aggregate rating", () => {
    const missingProof = runWithCounts(1, 1);
    missingProof.observations[0] = {
      ...missingProof.observations[0],
      rating: null,
      rawRating: null
    };

    const missingRawValue = runWithCounts(1, 1);
    missingRawValue.observations[0] = {
      ...missingRawValue.observations[0],
      rating: null,
      ratingUnavailable: true
    };

    const contradictory = runWithCounts(1, 1);
    contradictory.observations[0] = {
      ...contradictory.observations[0],
      rating: null,
      rawRating: 4.5,
      ratingUnavailable: true
    };

    expect(validateRun(missingProof).ok).toBe(false);
    expect(validateRun(missingRawValue).ok).toBe(false);
    expect(validateRun(contradictory).ok).toBe(false);
  });

  it("does not warn when ratings outnumber written reviews", () => {
    const run = runWithCounts(1, 1);
    run.observations[0] = {
      ...run.observations[0],
      reviews: 0,
      rating: null,
      ratingCount: 1,
      status: "no_reviews"
    };

    expect(validateRun(run)).toMatchObject({ ok: true, warnings: [] });
  });

  it("does not warn when confirmed feedback counters differ", () => {
    const run = runWithCounts(1, 1);
    run.observations[0].ratingCount = 1;

    expect(validateRun(run).warnings).toEqual([]);
  });

  it("shows one concise blocker for a failed partition instead of repeating its technical error", () => {
    const run = runWithCounts(0, 0, false);
    run.partitions[0] = {
      ...run.partitions[0],
      status: "blocked",
      message: "quota_exceeded: месячная квота исчерпана"
    };
    run.errors.push({
      partition: "example.com/Бренд",
      message: "quota_exceeded: месячная квота исчерпана"
    });

    const qa = validateRun(run);

    expect(qa.blockers).toEqual([
      "example.com / Бренд: quota_exceeded: месячная квота исчерпана"
    ]);
  });
});
