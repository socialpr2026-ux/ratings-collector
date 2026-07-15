import { describe, expect, it, vi } from "vitest";
import { brandTabNames, rollbackBrowserTabs } from "../agents/sheet-publisher/index.js";
import { BrowserSheetRollbackError, type BrowserSheetPublication } from "../src/server/sheets/browser-publisher.js";

describe("brand sheet publication batch", () => {
  it("rejects Google-tab collisions after normalization, case folding and truncation", () => {
    expect(brandTabNames(["Кагоцел", "Бактоблис"])).toEqual(["Ratings Кагоцел", "Ratings Бактоблис"]);
    expect(() => brandTabNames(["Кагоцел", "КАГОЦЕЛ"])).toThrow(/одинаковые имена вкладок/i);
    expect(() => brandTabNames([`А${"я".repeat(120)}`, `А${"я".repeat(119)}x`])).toThrow(/одинаковые имена вкладок/i);
  });

  it("attempts every browser rollback even when the newest tab cannot be restored", async () => {
    const publications: BrowserSheetPublication[] = [
      { sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit", document: {} as never, tabName: "Ratings Альфа" },
      { sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit", document: {} as never, tabName: "Ratings Бета" }
    ];
    const rollbackVerifiedPublication = vi.fn()
      .mockRejectedValueOnce(new BrowserSheetRollbackError(new Error("write"), ["Ratings Бета: mismatch"]))
      .mockResolvedValueOnce(undefined);

    const failures = await rollbackBrowserTabs(
      { rollbackVerifiedPublication } as never,
      publications,
      publications.length,
      new Error("write")
    );

    expect(rollbackVerifiedPublication).toHaveBeenCalledTimes(2);
    expect(failures).toEqual(["Ratings Бета: mismatch"]);
  });
});
