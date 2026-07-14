import { describe, expect, it } from "vitest";
import { analyzeProductIdentity, canonicalProductDescriptor, canonicalProductDescriptors } from "../src/server/utils/product-name.js";

describe("canonical product descriptors", () => {
  it("normalizes form, strength and count independently of wording and order", () => {
    const values = canonicalProductDescriptors([
      { brand: "Кагоцел", product: "Кагоцел табл. 100мг 10 шт" },
      { brand: "Кагоцел", product: "Кагоцел, таблетки 100 мг, №10" },
      { brand: "Кагоцел", product: "Кагоцел №10 — 100 мг, таблетки" }
    ]);
    expect(values).toEqual(Array(3).fill("таблетки 100 мг №10"));
  });

  it("never fills complementary partial names from neighbouring listings", () => {
    const values = canonicalProductDescriptors([
      { brand: "Кагоцел", product: "Кагоцел табл. 10" },
      { brand: "Кагоцел", product: "Кагоцел №10 — 100мг" }
    ]);
    expect(values).toEqual([
      "таблетки №10",
      "100 мг №10"
    ]);
  });

  it("maps total sachet-pack weight and per-sachet strength to one real product", () => {
    const values = canonicalProductDescriptors([
      { brand: "Бактоблис", product: "Бактоблис 1500 мг порошок 15 саше" },
      { brand: "Бактоблис", product: "БактоБЛИС порошок, 15 саше-пакетов по 1500 мг" },
      { brand: "Бактоблис", product: "БактоБЛИС порошок 22,5 г саше №15" }
    ]);
    expect(values).toEqual(Array(3).fill("порошок в саше 1500 мг №15"));
  });

  it("keeps meaningful product modifiers and removes every brand spelling", () => {
    expect(canonicalProductDescriptor(
      "Бактоблис",
      "Бакто БЛИС Плюс таблетки для рассасывания 950мг No30 без сахара"
    )).toBe("Плюс без сахара таблетки для рассасывания 950 мг №30");
  });

  it("uses a clear brand-level label when a review page has no product variant", () => {
    expect(canonicalProductDescriptor("Анвифен", "Анвифен — отзывы, инструкция, цена и аналоги"))
      .toBe("Общая карточка бренда");
  });

  it("does not merge conflicting strengths or package counts", () => {
    const values = canonicalProductDescriptors([
      { brand: "Анвифен", product: "Анвифен капсулы 50 мг 20 шт" },
      { brand: "Анвифен", product: "Анвифен капсулы 250 мг 20 шт" },
      { brand: "Анвифен", product: "Анвифен капсулы 250 мг 10 шт" }
    ]);
    expect(new Set(values).size).toBe(3);
  });

  it("uses a canonical URL slug when a marketplace stored only a model label", () => {
    const values = canonicalProductDescriptors([
      {
        brand: "Амиксин",
        product: "Амиксин — Модель 1964045468",
        url: "https://reviews.yandex.ru/product/amiksin-tab-p-o-plen--1964045468"
      },
      {
        brand: "Бактоблис",
        product: "Бактоблис саше",
        url: "https://reviews.yandex.ru/product/baktoblis-vkus-klubniki-poroshok-dlia-priema-vnutr-sashe-paket-1500mg-30sht--1437465355"
      }
    ]);
    expect(values).toEqual(["Общая карточка формы «таблетки»", "вкус клубники порошок в саше 1500 мг №30"]);
  });

  it("removes transliterated brands left by legacy URL hints", () => {
    expect(canonicalProductDescriptor("Амиксин", "Модель 128489946 amiksin"))
      .toBe("Общая карточка бренда");
    expect(canonicalProductDescriptor("Бактоблис", "+ baktoblis"))
      .toBe("Общая карточка бренда");
  });

  it("turns abbreviated marketplace slugs into human aggregate labels", () => {
    expect(canonicalProductDescriptors([{
      brand: "Гриппферон", product: "Гриппферон",
      url: "https://reviews.yandex.ru/product/grippferon-s-loratadinom--228041358"
    }])[0]).toBe("Общая карточка серии «с лоратадином»");
    expect(canonicalProductDescriptors([{
      brand: "Полиоксидоний", product: "Полиоксидоний",
      url: "https://reviews.yandex.ru/product/polioksidonii-supp-vag-i-rekt--5852852613"
    }])[0]).toBe("Общая карточка формы «суппозитории вагинальные и ректальные»");
    expect(canonicalProductDescriptors([{
      brand: "Анвифен", product: "Анвифен",
      url: "https://otzyv.pro/category/lekarstvennyie-sredstva/25226-anvifen.html"
    }])[0]).toBe("Общая карточка бренда");
  });

  it("removes a Russian brand inflection and ignores technical URL filenames", () => {
    expect(canonicalProductDescriptors([{
      brand: "Циклоферон",
      product: "Применение Циклоферона в пародонтологии detail.aspx",
      url: "https://www.wildberries.ru/catalog/712021351/detail.aspx"
    }])[0]).toBe("Не товарная карточка");
  });

  it("uses clean labels for partial evidence and treats form plus pack as a complete product", () => {
    expect(analyzeProductIdentity({ brand: "Бактоблис", product: "Бактоблис Плюс" })).toMatchObject({
      granularity: "family", confidence: "partial", label: "Общая карточка бренда"
    });
    expect(analyzeProductIdentity({ brand: "Кагоцел", product: "Ниармедик плюс Кагоцел" })).toMatchObject({
      granularity: "family", confidence: "partial", label: "Общая карточка бренда"
    });
    expect(analyzeProductIdentity({ brand: "Анвифен", product: "Анвифен капсулы" })).toMatchObject({ granularity: "unresolved", label: "Общая карточка формы «капсулы»", missing: ["pack"] });
    expect(analyzeProductIdentity({ brand: "Кагоцел", product: "Кагоцел таблетки №20" })).toMatchObject({ granularity: "variant", confidence: "exact", label: "таблетки №20", missing: [] });
    expect(analyzeProductIdentity({ brand: "Кагоцел", product: "Кагоцел 12 мг №20" })).toMatchObject({ granularity: "variant", confidence: "exact", label: "12 мг №20", missing: [] });
    expect(analyzeProductIdentity({ brand: "Анвифен", product: "Анвифен капсулы 10 шт" })).toMatchObject({ granularity: "variant", confidence: "exact", label: "капсулы №10", missing: [] });
    expect(analyzeProductIdentity({ brand: "Цитовир-3", product: "Цитовир-3 саше №15" })).toMatchObject({ granularity: "variant", confidence: "exact", label: "саше №15", missing: [] });
    expect(analyzeProductIdentity({ brand: "Анаферон", product: "Анаферон детский" })).toMatchObject({ granularity: "unresolved", label: "Общая карточка серии «детский»" });
    expect(analyzeProductIdentity({ brand: "Арбидол", product: "Арбидол Максимум капсулы" })).toMatchObject({ granularity: "unresolved", label: "Общая карточка: Максимум капсулы" });
    expect(analyzeProductIdentity({ brand: "Кагоцел", product: "Кагоцел таблетки 12 мг №20" })).toMatchObject({ granularity: "variant", label: "таблетки 12 мг №20" });
  });

  it("does not promote a marketing modifier or an administration dose to an exact product", () => {
    expect(analyzeProductIdentity({ brand: "Бактоблис", product: "Бактоблис Плюс №20" })).toMatchObject({
      granularity: "unresolved", confidence: "partial", label: "№20"
    });
    expect(analyzeProductIdentity({ brand: "Анвифен", product: "Анвифен: принимать по 2 капсулы 3 раза в день" })).toMatchObject({
      granularity: "unresolved", confidence: "partial", label: "Общая карточка формы «капсулы»"
    });
    expect(analyzeProductIdentity({ brand: "Цитовир-3", product: "Цитовир-3 сироп принимать по 5 мл 3 раза в день" })).toMatchObject({
      granularity: "unresolved", confidence: "partial", label: "Общая карточка формы «сироп»"
    });
  });

  it("prefers a compatible richer proof and uses image or instruction metadata only as fallback", () => {
    expect(analyzeProductIdentity({
      brand: "Кагоцел",
      product: "Кагоцел таблетки №20",
      evidence: {
        scope: "listing",
        signals: [
          { source: "json_ld", text: "Кагоцел таблетки 12 мг №20" },
          { source: "image_alt", text: "Кагоцел таблетки 24 мг №20" }
        ],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    })).toMatchObject({ granularity: "variant", confidence: "exact", label: "таблетки 12 мг №20" });

    expect(analyzeProductIdentity({
      brand: "Анвифен",
      product: "Анвифен",
      evidence: {
        scope: "listing",
        signals: [{ source: "image_alt", text: "Анвифен капсулы 50 мг №20" }],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    })).toMatchObject({ granularity: "variant", confidence: "exact", label: "капсулы 50 мг №20" });
  });

  it("never exposes draft wording in product labels", () => {
    const labels = canonicalProductDescriptors([
      { brand: "Амиксин", product: "Модель 128489946 amiksin" },
      { brand: "Анвифен", product: "Анвифен капсулы" },
      { brand: "Бактоблис", product: "Бактоблис Плюс" },
      { brand: "Кагоцел", product: "Кагоцел таблетки №20" }
    ]);
    expect(labels.join(" ")).not.toContain("Вариант не определён");
  });

  it("represents a review page with several variants as a family aggregate", () => {
    expect(analyzeProductIdentity({
      brand: "Бактоблис",
      product: "Бактоблис Плюс отзывы",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Бактоблис Плюс отзывы" }],
        variants: ["1500 мг, порошок, 15 саше", "таблетки для рассасывания без сахара, 30 шт"],
        identifiers: [], imageUrls: [], instructionUrls: []
      }
    })).toMatchObject({ granularity: "family", label: "Общая карточка бренда (2 варианта)", variantCount: 2 });
  });

  it("counts distinct named lines and uses correct Russian plural forms in family labels", () => {
    const identity = analyzeProductIdentity({
      brand: "Бактоблис",
      product: "Бактоблис отзывы",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Бактоблис отзывы" }],
        variants: ["Бактоблис таблетки №20", "Бактоблис Плюс таблетки №20"],
        identifiers: [], imageUrls: [], instructionUrls: []
      }
    });
    expect(identity).toMatchObject({ granularity: "family", label: "Общая карточка бренда (2 варианта)", variantCount: 2 });
  });

  it("keeps compound strength and is idempotent across repeated publications", () => {
    expect(canonicalProductDescriptor("Полиоксидоний", "Полиоксидоний раствор 6 мг/мл, флакон 5 мл, 1 шт"))
      .toBe("раствор 6 мг/мл 5 мл №1");
    const once = canonicalProductDescriptors([{ brand: "Полиоксидоний", product: "Лиоф. д/приг. р-ра, фл. polioksidonii", url: "https://example.ru/polioksidonii" }])[0];
    const twice = canonicalProductDescriptors([{ brand: "Полиоксидоний", product: once, url: "https://example.ru/polioksidonii" }])[0];
    expect(twice).toBe(once);
    expect(canonicalProductDescriptor("Бактоблис", "Общая карточка бренда (3 варианта)"))
      .toBe("Общая карточка бренда (3 варианта)");
    expect(canonicalProductDescriptor("Бактоблис", "Общая карточка линейки «Плюс» (2 варианта)"))
      .toBe("Общая карточка бренда (2 варианта)");
  });
});
