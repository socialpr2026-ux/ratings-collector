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
    expect(source).toContain("sheet.setFrozenRows(Math.min(2, rows));");
    expect(source).toContain("sheet.setFrozenColumns(Math.min(3, columns));");
    expect(source).toContain("sheet.setHiddenGridlines(true);");
    expect(source).toContain('sheet.setTabColor("#154f3d");');
    expect(source).toContain("sheet.setColumnWidth(metricColumn, 112);");
    expect(source).toContain("sheet.setColumnWidth(metricColumn + 1, 86);");
  });
});
