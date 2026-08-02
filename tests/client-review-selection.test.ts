import { describe, expect, it } from "vitest";
// @ts-expect-error The server-side test tsconfig deliberately excludes JSX; Vitest transforms this client module.
import { canApproveSiteProfile, completeRunPage, retainValidSelection, shouldShowReviewSelectionBar } from "../src/client/App.js";

describe("review selection controls", () => {
  it("keeps the confirmation action visible after selecting a card in the full list", () => {
    expect(shouldShowReviewSelectionBar(1, 1, 0)).toBe(true);

    // The user changes the filter or remains in the full-list view. The selected
    // card is no longer among the visible rows, but its confirmation action stays.
    expect(shouldShowReviewSelectionBar(1, 0, 1)).toBe(true);
  });

  it("keeps a rejection action for unconfirmable review cards and hides it only when review is empty", () => {
    expect(shouldShowReviewSelectionBar(1, 0, 0)).toBe(true);
    expect(shouldShowReviewSelectionBar(0, 0, 0)).toBe(false);
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

  it("keeps ten selected cards while requiring three controls and an explicit counter meaning", () => {
    const tenSelected = new Set(Array.from({ length: 10 }, (_, index) => `ru.otzyv.com:${index + 1}`));
    expect(tenSelected).toHaveLength(10);
    expect(canApproveSiteProfile({ status: "draft", exampleCount: 3, confirmedExampleCount: 2, reviewCountMeaning: "reviews" })).toBe(false);
    expect(canApproveSiteProfile({ status: "draft", exampleCount: 3, confirmedExampleCount: 3, reviewCountMeaning: "unknown" })).toBe(false);
    expect(canApproveSiteProfile({ status: "draft", exampleCount: 3, confirmedExampleCount: 3, reviewCountMeaning: "reviews" })).toBe(true);
    expect(tenSelected).toHaveLength(10);
  });

  it("does not weaken the three-card guardrail when a profile has only two examples", () => {
    expect(canApproveSiteProfile({ status: "draft", exampleCount: 2, confirmedExampleCount: 2, reviewCountMeaning: "reviews" })).toBe(false);
  });

  it("uses the successful review response without an unnecessary follow-up read", async () => {
    const readPage = async () => {
      throw new Error("the first page must not be fetched again");
    };
    const reviewed = {
      id: "reviewed-run",
      status: "review",
      observations: [{ listingId: "confirmed" }],
      observationPage: { offset: 0, limit: 250, total: 1 }
    };

    await expect(completeRunPage(reviewed as never, readPage)).resolves.toBe(reviewed);
  });

  it("loads only the remaining observation pages after a large review response", async () => {
    const calls: Array<[number, number]> = [];
    const readPage = async (offset: number, limit: number) => {
      calls.push([offset, limit]);
      return {
        id: "large-run",
        status: "review",
        observations: [{ listingId: `page-${offset}` }],
        observationPage: { offset, limit, total: 501 }
      };
    };
    const reviewed = {
      id: "large-run",
      status: "review",
      observations: [{ listingId: "first-page" }],
      observationPage: { offset: 0, limit: 250, total: 501 }
    };

    const complete = await completeRunPage(reviewed as never, readPage as never);

    expect(calls).toEqual([[250, 250], [500, 250]]);
    expect(complete.observations.map((item: { listingId: string }) => item.listingId))
      .toEqual(["first-page", "page-250", "page-500"]);
  });
});
