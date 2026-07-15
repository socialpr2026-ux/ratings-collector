import { describe, expect, it } from "vitest";
import { normalizeProductOverride, resolveProductOverride } from "../src/server/utils/product-override.js";

const card = {
  brand: "Тромболикс Про",
  canonicalUrl: "https://reviews.yandex.ru/product/tromboliks-pro--1016049020"
};

describe("manual product review override", () => {
  it("accepts one exact human variant without changing the source card", () => {
    const identity = resolveProductOverride(card, "  раствор 2 мл   №10 ");
    expect(identity).toMatchObject({
      label: "раствор 2 мл №10",
      granularity: "variant",
      confidence: "exact",
      reasons: ["Вариант уточнён и подтверждён оператором"]
    });
  });

  it("preserves every explicitly entered pack in one shared-rating product label", () => {
    expect(resolveProductOverride(
      { brand: "Церетон", canonicalUrl: "https://reviews.yandex.ru/product/tsereton--1778172988" },
      "капсулы 400 мг №56 и №112"
    )).toEqual({
      label: "капсулы 400 мг №56 и №112",
      granularity: "family",
      confidence: "exact",
      missing: [],
      reasons: ["Общая карточка вариантов уточнена и подтверждена оператором"],
      variantCount: 2
    });
    expect(resolveProductOverride(card, "раствор 2 мл №1 и №10")).toMatchObject({
      label: "раствор 2 мл №1 и №10",
      granularity: "family",
      confidence: "exact",
      variantCount: 2
    });
  });

  it("rejects a vague form and a family placeholder", () => {
    expect(resolveProductOverride(card, "раствор")).toBeUndefined();
    expect(resolveProductOverride(card, "Общая карточка бренда")).toBeUndefined();
  });

  it("normalizes whitespace before sending the review decision", () => {
    expect(normalizeProductOverride("  капсулы   400 мг  №56 ")).toBe("капсулы 400 мг №56");
  });
});
