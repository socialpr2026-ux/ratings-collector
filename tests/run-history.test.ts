import { describe, expect, it } from "vitest";
import {
  completedCollectionHistory,
  formatCollectionDuration,
  historyBrandLabel
} from "../src/client/run-history.js";

describe("compact collection history", () => {
  it("formats brand, start and duration data without exposing technical status", () => {
    expect(formatCollectionDuration(42_000)).toBe("42 сек");
    expect(formatCollectionDuration(8 * 60_000)).toBe("8 мин");
    expect(formatCollectionDuration(68 * 60_000)).toBe("1 ч 08 мин");
    expect(historyBrandLabel(["Бивиарт", "Окусалин", "Таустин"])).toBe("Бивиарт, Окусалин +1");
    expect(completedCollectionHistory([
      { id: "done", brands: ["Бивиарт"], createdAt: "2026-07-24T08:00:00.000Z", collectionStartedAt: "2026-07-24T08:00:00.000Z", collectionFinishedAt: "2026-07-24T08:01:00.000Z", durationMs: 60_000 },
      { id: "active", brands: ["Таустин"], createdAt: "2026-07-24T09:00:00.000Z", collectionStartedAt: "2026-07-24T09:00:00.000Z", durationMs: null }
    ]).map((item) => item.id)).toEqual(["done"]);
  });
});
