import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../google-apps-script/Code.gs", import.meta.url), "utf8");

describe("Google Apps Script bridge source", () => {
  it("creates the canonical Ratings tab and preserves a legacy tab", () => {
    expect(source).toContain('var RATINGS_TAB = "Ratings";');
    expect(source).toContain('var LEGACY_RATINGS_TAB = "Рейтинги";');
    expect(source).toContain("spreadsheet.getSheetByName(RATINGS_TAB) || spreadsheet.getSheetByName(LEGACY_RATINGS_TAB)");
    expect(source).toContain("spreadsheet.insertSheet(payload.tabName)");
    expect(source).toContain("tabName: sheet.getName()");
    expect(source).not.toContain('serviceError_("tab_not_found"');
  });

  it("preserves ru-RU formula separators on write", () => {
    expect(source).toContain("function normalizeFormulaForWrite_(formula)");
    expect(source).toContain("return String(formula);");
    expect(source).not.toContain('return String(formula).replace(/;/g, ",");');
  });

  it("fails closed when a written formula displays a spreadsheet error", () => {
    expect(source).toContain("displayValues = range.getDisplayValues()");
    expect(source).toContain("ошибка вычисления");
    expect(source).toContain("/^\\s*#/u.test(displayed)");
  });

  it("keeps the operational sheet readable during monthly work", () => {
    expect(source).toContain("sheet.setFrozenRows(Math.min(3, rows));");
    expect(source).toContain("sheet.setFrozenColumns(Math.min(4, columns));");
    expect(source).not.toContain("sheet.setFrozenColumns(Math.min(3, columns));");
    expect(source).toContain("sheet.setHiddenGridlines(true);");
    expect(source).toContain('sheet.setTabColor("#ff4d00");');
    expect(source).toContain("sheet.setColumnWidth(1, 150);");
    expect(source).toContain("sheet.setColumnWidth(2, 320);");
    expect(source).toContain("sheet.setColumnWidth(3, 310);");
    expect(source).toContain("sheet.setColumnWidth(4, 24);");
    expect(source).toContain("sheet.getRange(productBlockStart + 1, 2, productCount, 1).setFontColor");
    expect(source).not.toContain("sheet.getRange(productBlockStart + 1, 1, productCount, 1).setFontColor");
    expect(source).toContain("sheet.setColumnWidth(metricColumn, 110);");
    expect(source).toContain("sheet.setColumnWidth(metricColumn + 1, 82);");
    expect(source).toContain('rowFormats.push("0.##")');
    expect(source).not.toContain('rowFormats.push("0.0")');
  });

  it("publishes all brand tabs under one lock and rolls the batch back together", () => {
    expect(source).toContain('payload.action === "readBatch"');
    expect(source).toContain('payload.action === "writeBatch"');
    expect(source).toContain("function writeBatchAction_(payload)");
    expect(source).toContain("entries.forEach(function (entry)");
    expect(source).toContain("restoreBackup_(");
    expect(source).toContain('"rollback_failed"');
    expect(source).toContain('/^Ratings [^\\[\\]*?:\\\\/]+$/');
  });

  it("applies the Interfox visual system to brand, section and summary rows", () => {
    expect(source).toContain("brand: true");
    expect(source).toContain('.setFontFamily("Inter")');
    expect(source).toContain('kind === "brand"');
    expect(source).toContain('.setBackground("#120755")');
    expect(source).toContain('"#ff4d00", SpreadsheetApp.BorderStyle.SOLID_THICK');
    expect(source).toContain('.setBackground("#f0effa")');
    expect(source).toContain('.setBackground("#e7e5f7")');
  });
});
