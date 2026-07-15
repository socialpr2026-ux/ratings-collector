import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../google-apps-script/Code.gs", import.meta.url), "utf8");

describe("Google Apps Script bridge source", () => {
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
    expect(source).toContain("sheet.setFrozenColumns(Math.min(3, columns));");
    expect(source).toContain("sheet.setHiddenGridlines(true);");
    expect(source).toContain('sheet.setTabColor("#ff4d00");');
    expect(source).toContain("sheet.setColumnWidth(metricColumn, 110);");
    expect(source).toContain("sheet.setColumnWidth(metricColumn + 1, 82);");
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
