import { describe, expect, it } from "vitest";
import { aliasesForBrand, matchesBrand } from "../src/server/utils/normalize.js";

describe("brand aliases", () => {
  it("recognizes common Бактоблис spellings without changing the requested brand", () => {
    expect(aliasesForBrand("Бактоблис")).toContain("Bactoblis");
    expect(matchesBrand("Бакто БЛИС таблетки для рассасывания", "Бактоблис")).toBe(true);
    expect(matchesBrand("Bactoblis №30", "Бактоблис")).toBe(true);
    expect(matchesBrand("Другой препарат", "Бактоблис")).toBe(false);
  });
});
