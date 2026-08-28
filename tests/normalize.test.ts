import { describe, expect, it } from "vitest";
import { aliasesForBrand, matchesBrand } from "../src/server/utils/normalize.js";

describe("brand aliases", () => {
  it("recognizes common Бактоблис spellings without changing the requested brand", () => {
    expect(aliasesForBrand("Бактоблис")).toContain("Bactoblis");
    expect(matchesBrand("Бакто БЛИС таблетки для рассасывания", "Бактоблис")).toBe(true);
    expect(matchesBrand("Bactoblis №30", "Бактоблис")).toBe(true);
    expect(matchesBrand("Другой препарат", "Бактоблис")).toBe(false);
  });

  it("keeps configured aliases independent of employee-entered brand casing", () => {
    for (const brand of ["Кагоцел", "кагоцел", "КАГОЦЕЛ", "Kagocel", "KAGOCEL", "Kagotsel"]) {
      expect(aliasesForBrand(brand)).toEqual(expect.arrayContaining(["Kagocel", "Kagotsel"]));
      expect(matchesBrand("Kagocel tablets 12 mg No. 20", brand)).toBe(true);
      expect(matchesBrand("Kagotsel tablets 12 mg No. 30", brand)).toBe(true);
      expect(matchesBrand("Кагоцел таблетки 12 мг №10", brand)).toBe(true);
    }
  });
});
