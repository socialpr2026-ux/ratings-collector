import { describe, expect, it } from "vitest";
// @ts-expect-error The server-side test tsconfig deliberately excludes JSX; Vitest transforms this client module.
import { retainValidSelection, shouldShowReviewSelectionBar } from "../src/client/App.js";

describe("review selection controls", () => {
  it("keeps the confirmation action visible after selecting a card in the full list", () => {
    expect(shouldShowReviewSelectionBar(1, 0)).toBe(true);

    // The user changes the filter or remains in the full-list view. The selected
    // card is no longer among the visible rows, but its confirmation action stays.
    expect(shouldShowReviewSelectionBar(0, 1)).toBe(true);
  });

  it("hides the action only when no confirmable card is visible or selected", () => {
    expect(shouldShowReviewSelectionBar(0, 0)).toBe(false);
  });

  it("drops stale selections after refreshed observations remove a review card", () => {
    const selected = new Set(["irecommend.ru:11557796", "uteka.ru:tikalizis"]);
    const refreshedConfirmableKeys = new Set(["uteka.ru:tikalizis"]);

    expect([...retainValidSelection(selected, refreshedConfirmableKeys)])
      .toEqual(["uteka.ru:tikalizis"]);
  });

  it("preserves the same selection object when every selected card is still valid", () => {
    const selected = new Set(["irecommend.ru:11557796"]);
    expect(retainValidSelection(selected, new Set(selected))).toBe(selected);
  });
});
