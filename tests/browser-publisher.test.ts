import { describe, expect, it, vi } from "vitest";
import type { Observation, RunRequest } from "../src/shared/types.js";
import { buildSheetDocument, type SheetDocument } from "../src/server/sheets/model.js";
import {
  BrowserSheetsPublisher,
  BrowserSheetVerificationError,
  buildBrowserSheetClipboardPlan,
  verifyBrowserSheetReadback
} from "../src/server/sheets/browser-publisher.js";
import type {
  BrowserSheetReadback,
  SheetsUiDriver
} from "../src/server/sheets/browser-ui-driver.js";
import {
  buildFormulaAwareClipboardPayload,
  parseBrowserClipboardPayload
} from "../src/server/sheets/browser-ui-driver.js";
import {
  assertOpenPublisherMode,
  isAllowedGoogleSheetsResource
} from "../agents/sheet-publisher/index.js";

const request: RunRequest = {
  sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet/edit",
  month: "2026-07", region: "Москва", domains: ["example.com"], brands: ["Бренд"]
};

function sheetDocument(): SheetDocument {
  const observation: Observation = {
    domain: "example.com", platform: "example", listingId: "1", brand: "Бренд",
    canonicalUrl: "https://example.com/p/1", product: "Бренд — упаковка",
    reviews: 12, rating: 4.9, status: "ok", capturedAt: "2026-07-13T00:00:00.000Z"
  };
  return buildSheetDocument({ values: [] }, request, [], { "2026-07": { "example.com:1": observation } });
}

function readbackFromDocument(document: SheetDocument): BrowserSheetReadback {
  return {
    payload: { plainText: "copied", htmlText: "<table></table>" },
    cells: document.values.map((row, rowIndex) => row.map((value, columnIndex) => {
      const formula = document.formulas[rowIndex]?.[columnIndex];
      if (formula) return { text: "calculated", formula };
      if (typeof value === "number") return { text: String(value).replace(".", ",") };
      return { text: value ?? "" };
    })),
    merges: document.merges.map((merge) => ({ ...merge })),
    htmlAvailable: true
  };
}

function backup(text = "старое значение"): BrowserSheetReadback {
  return {
    payload: { plainText: text, htmlText: `<table><tr><td>${text}</td></tr></table>` },
    cells: [[{ text }]], merges: [], htmlAvailable: true
  };
}

function mockDriver(options: {
  current?: BrowserSheetReadback;
  readbacks?: BrowserSheetReadback[];
} = {}): SheetsUiDriver & Record<string, ReturnType<typeof vi.fn>> {
  const queue = [...(options.readbacks ?? [])];
  return {
    open: vi.fn(async () => undefined),
    selectTab: vi.fn(async () => undefined),
    ensureTab: vi.fn(async (preferredTitle: string) => preferredTitle),
    assertEditable: vi.fn(async () => undefined),
    captureCurrentRegion: vi.fn(async () => options.current ?? backup()),
    clearRange: vi.fn(async () => undefined),
    unmergeRange: vi.fn(async () => true),
    writeClipboard: vi.fn(async () => undefined),
    pasteAt: vi.fn(async () => undefined),
    readRange: vi.fn(async () => queue.shift() ?? (() => { throw new Error("Нет mock readback"); })()),
    waitForSettled: vi.fn(async () => undefined)
  };
}

describe("browser-only Google Sheets publisher", () => {
  it("publishes through the UI and returns success only after exact readback", async () => {
    const document = sheetDocument();
    const driver = mockDriver({ readbacks: [readbackFromDocument(document)] });
    const publisher = new BrowserSheetsPublisher(driver);
    const result = await publisher.publish({ sheetUrl: request.sheetUrl, document });
    expect(result.status).toBe("published");
    expect(result.attempts).toBe(1);
    expect(result.range).toBe(`A1:F${document.values.length}`);
    expect(driver.ensureTab).toHaveBeenCalledWith("Ratings", ["Рейтинги"]);
    expect(result.tabName).toBe("Ratings");
    expect(driver.writeClipboard).toHaveBeenCalledTimes(1);
    expect(driver.clearRange).toHaveBeenCalledTimes(1);
    expect(driver.readRange).toHaveBeenCalledWith(result.range, document.values.length, document.columnCount);
  });

  it("retries one idempotent clear/paste when the first readback differs", async () => {
    const document = sheetDocument();
    const bad = readbackFromDocument(document);
    bad.cells[0][0] = { text: "неверно" };
    const driver = mockDriver({ readbacks: [bad, readbackFromDocument(document)] });
    const result = await new BrowserSheetsPublisher(driver).publish({ sheetUrl: request.sheetUrl, document });
    expect(result.attempts).toBe(2);
    expect(driver.writeClipboard).toHaveBeenCalledTimes(2);
    expect(driver.clearRange).toHaveBeenCalledTimes(2);
    expect(driver.pasteAt).toHaveBeenCalledTimes(2);
  });

  it("commits an exact replay without mutating an already matching sheet", async () => {
    const document = sheetDocument();
    const existing = readbackFromDocument(document);
    const driver = mockDriver({ current: existing });
    const result = await new BrowserSheetsPublisher(driver).publish({
      sheetUrl: request.sheetUrl,
      document,
      preimage: existing
    });
    expect(result.attempts).toBe(0);
    expect(result.limitations[0]).toContain("повторная запись не выполнялась");
    expect(driver.clearRange).not.toHaveBeenCalled();
    expect(driver.writeClipboard).not.toHaveBeenCalled();
    expect(driver.pasteAt).not.toHaveBeenCalled();
  });

  it("restores the captured sheet and still fails closed after two bad readbacks", async () => {
    const document = sheetDocument();
    const original = backup();
    const bad = readbackFromDocument(document);
    bad.cells[0][0] = { text: "неверно" };
    const driver = mockDriver({ current: original, readbacks: [bad, bad, original] });
    const publisher = new BrowserSheetsPublisher(driver);
    await expect(publisher.publish({ sheetUrl: request.sheetUrl, document })).rejects.toBeInstanceOf(BrowserSheetVerificationError);
    expect(driver.writeClipboard).toHaveBeenCalledTimes(3);
    expect(driver.clearRange).toHaveBeenCalledTimes(3);
    expect(driver.pasteAt).toHaveBeenCalledTimes(3);
    expect(driver.writeClipboard).toHaveBeenLastCalledWith(original.payload);
  });

  it("compensates a state-storage failure after a verified UI publication", async () => {
    const document = sheetDocument();
    const original = backup();
    const driver = mockDriver({
      current: original,
      readbacks: [readbackFromDocument(document), original]
    });
    const publisher = new BrowserSheetsPublisher(driver);
    const publication = { sheetUrl: request.sheetUrl, document, preimage: original };

    await publisher.publish(publication);
    await publisher.rollbackVerifiedPublication(publication, new Error("Blob unavailable"));

    expect(driver.clearRange).toHaveBeenCalledTimes(2);
    expect(driver.writeClipboard).toHaveBeenLastCalledWith(original.payload);
  });

  it("does not mutate when the browser cannot preserve formulas in the backup", async () => {
    const document = sheetDocument();
    const unsafeBackup: BrowserSheetReadback = {
      payload: { plainText: "1" }, cells: [[{ text: "1", formula: "=1" }]], merges: [], htmlAvailable: false
    };
    const driver = mockDriver({ current: unsafeBackup });
    await expect(new BrowserSheetsPublisher(driver).publish({ sheetUrl: request.sheetUrl, document }))
      .rejects.toThrow("публикация не начата");
    expect(driver.writeClipboard).not.toHaveBeenCalled();
    expect(driver.clearRange).not.toHaveBeenCalled();
  });

  it("protects literal strings from formula injection and includes rich formula/merge clipboard data", () => {
    const document = sheetDocument();
    document.values[0][0] = "=IMPORTXML(\"https://evil.example\")";
    const plan = buildBrowserSheetClipboardPlan(document);
    expect(plan.payload.plainText).toContain("'=IMPORTXML");
    expect(plan.payload.htmlText).toContain("data-sheets-formula=");
    expect(plan.payload.htmlText).toContain("colspan=\"2\"");
    expect(plan.payload.htmlText).toContain("rowspan=\"2\"");
    expect(plan.payload.htmlText).toContain("background-color:#120755");
    expect(plan.payload.htmlText).toContain("border-bottom:3px solid #ff4d00");
    expect(plan.payload.htmlText).toContain("background-color:#f0effa");
    expect(plan.payload.htmlText).toContain("font-family:Inter,Arial,sans-serif");
    expect(plan.payload.htmlText).toContain('<col width="150">');
    expect(plan.payload.htmlText).toContain('<col width="320">');
    expect(plan.payload.htmlText).toContain('href="https://example.com/p/1"');
    const productCells = plan.cells.find((_row, index) => document.rowKinds[index] === "product")!;
    expect(productCells[1].value).toBe("example.com");
    expect(productCells[2].value).toBe("https://example.com/p/1");
  });

  it("rejects non-Google targets before opening a browser page", async () => {
    const driver = mockDriver();
    await expect(new BrowserSheetsPublisher(driver).publish({
      sheetUrl: "https://example.com/spreadsheets/d/test", document: sheetDocument()
    })).rejects.toThrow("docs.google.com");
    expect(driver.open).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing and non-standard-port Google URLs", async () => {
    const document = sheetDocument();
    const driver = mockDriver();
    await expect(new BrowserSheetsPublisher(driver).publish({
      sheetUrl: "https://user:password@docs.google.com/spreadsheets/d/test/edit",
      document
    })).rejects.toThrow("docs.google.com");
    await expect(new BrowserSheetsPublisher(driver).publish({
      sheetUrl: "https://docs.google.com:8443/spreadsheets/d/test/edit",
      document
    })).rejects.toThrow("docs.google.com");
    expect(driver.open).not.toHaveBeenCalled();
  });

  it("runs the publisher only in explicit no-OAuth mode and restricts Chromium resources to Google", () => {
    expect(assertOpenPublisherMode({ RATINGS_ALLOW_UNAUTHENTICATED: "true" })).toEqual({ email: "local@ratings" });
    expect(() => assertOpenPublisherMode({ RATINGS_ALLOW_UNAUTHENTICATED: "false" })).toThrow("Google OAuth");
    expect(isAllowedGoogleSheetsResource("https://docs.google.com/spreadsheets/d/test/edit")).toBe(true);
    expect(isAllowedGoogleSheetsResource("https://ssl.gstatic.com/docs/common/asset.js")).toBe(true);
    expect(isAllowedGoogleSheetsResource("https://docs.google.com.evil.example/payload.js")).toBe(false);
    expect(isAllowedGoogleSheetsResource("http://docs.google.com/spreadsheets/d/test/edit")).toBe(false);
  });

  it("parses Google clipboard HTML outside the Trusted Types page context", () => {
    const parsed = parseBrowserClipboardPayload({
      plainText: "Июль 2026\t\r\n=SUM(A2:A3)\t4,9",
      htmlText: '<table><tr><td colspan="2">Июль 2026</td></tr>' +
        '<tr><td data-sheets-formula="=SUM(A2:A3)">15</td><td>4,9</td></tr></table>'
    });
    expect(parsed.htmlAvailable).toBe(true);
    expect(parsed.cells[0]).toEqual([{ text: "Июль 2026" }, { text: "" }]);
    expect(parsed.cells[1][0]).toEqual({ text: "15", formula: "=SUM(A2:A3)" });
    expect(parsed.merges).toEqual([{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }]);
  });

  it("keeps blank rows when determining an exact exported TSV preimage", () => {
    const parsed = parseBrowserClipboardPayload({ plainText: "A\tB\r\n\t\r\nИтог\t4,9" });
    expect(parsed.cells).toHaveLength(3);
    expect(parsed.cells[1]).toEqual([{ text: "" }, { text: "" }]);
    expect(parsed.cells[2][0].text).toBe("Итог");
  });

  it("rebuilds a rollback payload with formulas while retaining copied HTML styles and merges", () => {
    const current: BrowserSheetReadback = {
      payload: {
        plainText: "2\tзаголовок",
        htmlText: '<table><tr><td style="background:#20124d" colspan="2">2</td></tr></table>'
      },
      cells: [[{ text: "2", formula: "=1+1" }, { text: "" }]],
      merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
      htmlAvailable: true
    };
    const payload = buildFormulaAwareClipboardPayload(current);
    expect(payload.plainText).toContain("=1+1");
    expect(payload.htmlText).toContain("background:#20124d");
    expect(payload.htmlText).toContain('colspan="2"');
    expect(payload.htmlText).toContain('data-sheets-formula="=1+1"');
  });

  it("accepts localized show-formulas readback as equivalent to model formulas", () => {
    const document = sheetDocument();
    const actual = readbackFromDocument(document);
    for (const row of actual.cells) for (const cell of row) if (cell.formula) {
      cell.formula = cell.formula
        .replace(/COUNTIFS/g, "СЧЁТЕСЛИМН")
        .replace(/IFERROR/g, "ЕСЛИОШИБКА")
        .replace(/SUM/g, "СУММ");
    }
    const plan = buildBrowserSheetClipboardPlan(document);
    expect(verifyBrowserSheetReadback(actual, plan.cells, plan.merges)).toEqual([]);
  });
});
