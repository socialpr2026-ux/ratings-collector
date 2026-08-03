import { describe, expect, it, vi } from "vitest";
import {
  appsScriptReadbacksMatchDocuments,
  brandTabNames,
  cachedAppsScriptPreflight,
  rememberAppsScriptPreflight,
  rollbackBrowserTabs
} from "../agents/sheet-publisher/index.js";
import { BrowserSheetRollbackError, type BrowserSheetPublication } from "../src/server/sheets/browser-publisher.js";
import type { AppsScriptSheetReadback } from "../src/server/sheets/apps-script-publisher.js";
import type { SheetDocument } from "../src/server/sheets/model.js";
import type { RunState } from "../src/shared/types.js";

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

  it("reuses the exact preflight preimage instead of rereading every brand tab before publication", () => {
    const tabNames = brandTabNames(["Alpha", "Beta"]);
    const run = {
      id: "00000000-0000-4000-8000-000000000001",
      request: {
        sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
        month: "2026-08", region: "Moscow", domains: ["example.com"], brands: ["Alpha", "Beta"]
      },
      status: "review", createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
      progress: { totalPartitions: 2, completedPartitions: 2 }, observations: [], partitions: [], errors: []
    } satisfies RunState;
    const readbacks = tabNames.map((tabName, index): AppsScriptSheetReadback => ({
      spreadsheetId: "test_sheet", tabName, values: [[`value-${index}`]], formulas: [[null]], merges: [],
      revision: String(index + 1).repeat(64), rows: 1, columns: 1
    }));

    rememberAppsScriptPreflight(run, "test_sheet", readbacks, "2026-08-02T00:01:00.000Z");

    expect(cachedAppsScriptPreflight(run, "test_sheet", tabNames)).toEqual(readbacks);
    expect(cachedAppsScriptPreflight(run, "another_sheet", tabNames)).toBeUndefined();
    expect(cachedAppsScriptPreflight(run, "test_sheet", [...tabNames].reverse())).toEqual([...readbacks].reverse());
  });

  it("recognizes a verified cached postimage so publication can resume without rewriting", () => {
    const [tabName] = brandTabNames(["Alpha"]);
    const document = {
      values: [["Alpha", 7], [null, null]],
      formulas: [[null, null], ["=SUM(B1)", null]],
      merges: [],
      rowKinds: ["brand", "summary"],
      months: ["2026-08"],
      productStartRow: 0,
      productEndRow: 0,
      columnCount: 2,
      summaryStartRow: 1
    } satisfies SheetDocument;
    const readback: AppsScriptSheetReadback = {
      spreadsheetId: "test_sheet",
      tabName,
      values: [["Alpha", 7], [0, null]],
      formulas: [[null, null], ["=SUM(B1)", null]],
      merges: [],
      revision: "a".repeat(64),
      rows: 2,
      columns: 2
    };

    expect(appsScriptReadbacksMatchDocuments([readback], [{ tabName, document }])).toBe(true);
    expect(appsScriptReadbacksMatchDocuments(
      [{ ...readback, formulas: [[null, null], ["=SUM(B1:B1)", null]] }],
      [{ tabName, document }]
    )).toBe(false);
  });
});
