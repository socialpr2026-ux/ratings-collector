import { describe, expect, it } from "vitest";
import {
  analyzeProductIdentity,
  canonicalProductDescriptor,
  canonicalProductDescriptors,
  canonicalProductVariants
} from "../src/server/utils/product-name.js";

describe("canonical product descriptors", () => {
  it("resolves abbreviated Farmlend oral solutions as exact zero-review products", () => {
    for (const [product, expected] of [
      ["Церетон 120мг/мл 100мл р-р д/пр.внутр. фл. Сотекс фармфирма зао_2 в Уфе", "раствор для приема внутрь 120 мг/мл 100 мл"],
      ["Церетон 120мг/мл 30мл р-р д/пр.внутр. фл. Сотекс фармфирма зао_2 в Уфе", "раствор для приема внутрь 120 мг/мл 30 мл"]
    ] as const) {
      expect(analyzeProductIdentity({ brand: "Церетон", product })).toEqual({
        label: expected,
        granularity: "variant",
        confidence: "exact",
        missing: [],
        reasons: []
      });
    }
  });

  it("normalizes form, strength and count independently of wording and order", () => {
    const values = canonicalProductDescriptors([
      { brand: "Кагоцел", product: "Кагоцел табл. 100мг 10 шт" },
      { brand: "Кагоцел", product: "Кагоцел, таблетки 100 мг, №10" },
      { brand: "Кагоцел", product: "Кагоцел №10 — 100 мг, таблетки" }
    ]);
    expect(values).toEqual(Array(3).fill("таблетки 100 мг №10"));
  });

  it("does not turn the ordinary word 'про' into a product line", () => {
    const identity = analyzeProductIdentity({
      brand: "Кагоцел",
      product: "Кагоцел, таблетки 12 мг, 10 шт.",
      evidence: {
        scope: "listing",
        signals: [
          { source: "title", text: "Кагоцел, таблетки 12 мг, 10 шт." },
          { source: "description", text: "Отзывы про Кагоцел, таблетки 12 мг, 10 шт." }
        ],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    });

    expect(identity).toMatchObject({
      label: "таблетки 12 мг №10",
      granularity: "variant",
      confidence: "exact"
    });
    expect(canonicalProductDescriptor("Кагоцел", "Кагоцел Форте, таблетки 12 мг, 10 шт."))
      .toBe("Форте таблетки 12 мг №10");
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

  it("uses one short label and semantic key for the same real product across sites", () => {
    const richIdentity = analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: "Оциллококцинум гранулы гомеопатические 1 г №30"
    });
    const oscillococcinum = canonicalProductVariants([
      { brand: "Оциллококцинум", product: "Оциллококцинум", productIdentity: richIdentity },
      { brand: "Оциллококцинум", product: "Оциллококцинум гранулы №30" }
    ]);
    expect(oscillococcinum.map((item) => item.label)).toEqual(["гранулы №30", "гранулы №30"]);
    expect(new Set(oscillococcinum.map((item) => item.variantKey)).size).toBe(1);

    const anvifen = canonicalProductVariants([
      { brand: "Анвифен", product: "Анвифен капсулы 50 мг №20" },
      { brand: "Анвифен", product: "Анвифен капсулы №20" }
    ]);
    expect(anvifen.map((item) => item.label)).toEqual(["капсулы №20", "капсулы №20"]);
    expect(new Set(anvifen.map((item) => item.variantKey)).size).toBe(1);
  });

  it("uses the physical pack instead of a per-item dose in marketplace titles", () => {
    const marketplaceTitle = "Оциллококцинум гранулы 1 г 1 доза 30 шт";
    expect(analyzeProductIdentity({ brand: "Оциллококцинум", product: marketplaceTitle })).toMatchObject({
      label: "гранулы 1 г №30",
      granularity: "variant",
      confidence: "exact"
    });
    expect(canonicalProductDescriptors([
      { brand: "Оциллококцинум", product: marketplaceTitle },
      { brand: "Оциллококцинум", product: "Оциллококцинум гранулы №30" }
    ])).toEqual(["гранулы №30", "гранулы №30"]);
  });

  it("treats an explicit one-piece measured container as the same real product", () => {
    const variants = canonicalProductVariants([
      { brand: "Хондрофен", product: "Хондрофен мазь для наружного применения 30 г 1 шт" },
      { brand: "Хондрофен", product: "Хондрофен мазь 30 г" },
      { brand: "Хондрофен", product: "Хондрофен мазь 50 г" },
      { brand: "Хондрофен", product: "Хондрофен мазь 30 г 2 шт" }
    ]);

    expect(variants.map((item) => item.label)).toEqual([
      "мазь 30 г",
      "мазь 30 г",
      "мазь 50 г",
      "мазь 30 г №2"
    ]);
    expect(variants[0].variantKey).toBe(variants[1].variantKey);
    expect(new Set(variants.map((item) => item.variantKey)).size).toBe(3);
  });

  it("reconciles equivalent source-bound consumer wording without merging real differences", () => {
    const exactConsumer = (label: string) => ({
      label,
      granularity: "variant" as const,
      confidence: "exact" as const,
      missing: [],
      reasons: []
    });
    const variants = canonicalProductVariants([
      {
        brand: "Canpol Babies",
        product: "Canpol Babies бутылочка антиколиковая 120 мл, 1 шт",
        productIdentity: exactConsumer("бутылочка антиколиковая 120 мл, 1 шт")
      },
      {
        brand: "Canpol Babies",
        product: "Canpol Babies антиколиковая бутылочка 120мл",
        productIdentity: exactConsumer("антиколиковая бутылочка 120мл")
      },
      {
        brand: "Canpol Babies",
        product: "Canpol Babies бутылочка антиколиковая 240 мл",
        productIdentity: exactConsumer("бутылочка антиколиковая 240 мл")
      },
      {
        brand: "Canpol Babies",
        product: "Canpol Babies бутылочка антиколиковая 120 мл, 2 шт",
        productIdentity: exactConsumer("бутылочка антиколиковая 120 мл, 2 шт")
      },
      {
        brand: "Canpol Babies",
        product: "Canpol Babies соска для бутылочки 120 мл",
        productIdentity: exactConsumer("соска для бутылочки 120 мл")
      },
      {
        brand: "Canpol Babies",
        product: "Canpol Babies бутылочка с соской 120 мл",
        productIdentity: exactConsumer("бутылочка с соской 120 мл")
      }
    ]);

    expect(variants[0]).toEqual(variants[1]);
    expect(variants[0].label).toBe("антиколиковая бутылочка 120 мл");
    expect(new Set(variants.map((item) => item.variantKey)).size).toBe(5);
  });

  it("never hides conflicting strengths while reconciling a shorter title", () => {
    const variants = canonicalProductVariants([
      { brand: "Анвифен", product: "Анвифен капсулы 50 мг №20" },
      { brand: "Анвифен", product: "Анвифен капсулы 250 мг №20" },
      { brand: "Анвифен", product: "Анвифен капсулы №20" }
    ]);
    expect(variants.map((item) => item.label)).toEqual([
      "капсулы 50 мг №20",
      "капсулы 250 мг №20",
      "капсулы №20"
    ]);
    expect(new Set(variants.map((item) => item.variantKey)).size).toBe(3);
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

  it("does not mix neighbouring packs or administration counts into an exact listing", () => {
    expect(analyzeProductIdentity({
      brand: "Кагоцел",
      product: "Кагоцел таблетки 12 мг 10 шт",
      evidence: {
        scope: "listing",
        signals: [
          { source: "title", text: "Кагоцел таблетки 12 мг 10 шт" },
          { source: "json_ld", text: "Кагоцел таблетки 12 мг 10 шт" },
          { source: "description", text: "1 таблетка содержит 12 мг кагоцела, масса таблетки 100 мг" },
          { source: "instruction", text: "Всего на курс 18 таблеток. Другие формы: Кагоцел таблетки 12 мг 20 шт и 30 шт" },
          { source: "image_alt", text: "Купить Кагоцел таблетки 12 мг 30 шт" }
        ],
        variants: ["Кагоцел таблетки 12 мг 10 шт"],
        identifiers: [{ type: "product_id", value: "208826" }],
        imageUrls: [], instructionUrls: []
      }
    })).toMatchObject({ granularity: "variant", confidence: "exact", label: "таблетки 12 мг №10" });
  });

  it("keeps the exact Oscillococcinum listing separate from ingredient doses and neighbouring packs", () => {
    expect(analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: "Оциллококцинум гранулы гомеопатические 12 шт",
      evidence: {
        scope: "listing",
        signals: [
          { source: "title", text: "Оциллококцинум гранулы гомеопатические 12 шт" },
          { source: "json_ld", text: "Оциллококцинум гранулы гомеопатические 12 шт" },
          { source: "description", text: "Основное вещество 200К — 0,01 мл. Формы выпуска: гранулы 6 шт, 12 шт и 30 шт" },
          { source: "instruction", text: "Принимать по 1 дозе утром и вечером" },
          { source: "image_alt", text: "Купить Оциллококцинум гранулы гомеопатические 30 шт" }
        ],
        variants: ["Оциллококцинум гранулы гомеопатические 12 шт"],
        identifiers: [{ type: "product_id", value: "212495" }],
        imageUrls: [], instructionUrls: []
      }
    })).toMatchObject({
      granularity: "variant",
      confidence: "exact",
      label: "гранулы №12"
    });
  });

  it("normalizes proven Oscillococcinum dose equivalents without filling missing evidence", () => {
    const provenEquivalentTitles = [
      "Оциллококцинум гранулы 1 г, 12 шт.",
      "Оциллококцинум гранулы гомеопатические 1 доза №12",
      "Оциллококцинум 1000 мг №12"
    ];

    for (const product of provenEquivalentTitles) {
      expect(analyzeProductIdentity({ brand: "Оциллококцинум", product })).toMatchObject({
        granularity: "variant",
        confidence: "exact",
        label: "гранулы 1 г №12"
      });
    }

    expect(analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: "Оциллококцинум гранулы №12"
    })).toMatchObject({
      granularity: "variant",
      confidence: "exact",
      label: "гранулы №12"
    });
    expect(analyzeProductIdentity({
      brand: "Другой бренд",
      product: "Другой бренд гранулы 1000 мг №12"
    }).label).toBe("гранулы 1000 мг №12");
  });

  it("keeps Oscillococcinum package identities separate after dose normalization", () => {
    expect([6, 12, 30].map((count) => analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: `Оциллококцинум гранулы гомеопатические 1 доза №${count}`
    }).label)).toEqual([
      "гранулы 1 г №6",
      "гранулы 1 г №12",
      "гранулы 1 г №30"
    ]);
  });

  it("keeps a one-variant review page as a variant even when the rating scope is aggregate", () => {
    const identity = analyzeProductIdentity({
      brand: "Оциллококцинум",
      product: "Оциллококцинум 30 доз гранулы гомеопатические",
      url: "https://otzyv.pro/category/badyi/62074-ocillokokcinum-30-doz-grangomeopaticheskie.html",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Оциллококцинум 30 доз гранулы гомеопатические" }],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    });

    expect(identity).toMatchObject({
      label: "гранулы №30",
      granularity: "variant",
      confidence: "exact"
    });
    expect(identity.label).not.toContain("Общий рейтинг");
  });

  it("resolves a source-bound concentrated oral solution and removes SANOFI only after exact brand match", () => {
    const title = "Раствор для приема внутрь SANOFI Когитум 25мг/мл";
    const identity = analyzeProductIdentity({
      brand: "Когитум",
      product: title,
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: title }],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    });

    expect(identity).toEqual({
      label: "раствор для приема внутрь 25 мг/мл",
      granularity: "variant",
      confidence: "exact",
      missing: [],
      reasons: []
    });
    expect(analyzeProductIdentity({
      brand: "Когитум",
      product: "SANOFI Когитум продукт"
    }).label).not.toContain("SANOFI");
    expect(analyzeProductIdentity({
      brand: "Когитум",
      product: "SANOFI другой продукт"
    }).label).toContain("SANOFI");
  });

  it("keeps conflicting oral-solution concentrations ambiguous", () => {
    const identity = analyzeProductIdentity({
      brand: "Когитум",
      product: "Когитум раствор для приема внутрь 25 мг/мл",
      evidence: {
        scope: "listing",
        signals: [
          { source: "title", text: "Когитум раствор для приема внутрь 25 мг/мл" },
          { source: "json_ld", text: "Когитум раствор для приема внутрь 50 мг/мл" }
        ],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    });

    expect(identity).toMatchObject({
      granularity: "unresolved",
      confidence: "ambiguous"
    });
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
    const input = {
      brand: "Бактоблис",
      product: "Бактоблис Плюс отзывы",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Бактоблис Плюс отзывы" }],
        variants: ["1500 мг, порошок, 15 саше", "таблетки для рассасывания без сахара, 30 шт"],
        identifiers: [], imageUrls: [], instructionUrls: []
      }
    } satisfies Parameters<typeof analyzeProductIdentity>[0];
    const identity = analyzeProductIdentity(input);
    expect(identity).toMatchObject({ granularity: "family", variantCount: 2 });
    expect(identity.label).toContain("порошок");
    expect(identity.label).toContain("1500 мг");
    expect(identity.label).toContain("№15");
    expect(identity.label).toContain("таблетки для рассасывания");
    expect(identity.label).toContain("№30");
    expect(canonicalProductVariants([input])).toEqual([{ label: identity.label }]);
  });

  it("does not invent one unnamed variant for a brand aggregate", () => {
    const identity = analyzeProductIdentity({
      brand: "Кагоцел",
      product: "Кагоцел отзывы",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Кагоцел отзывы" }],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    });

    expect(identity).toMatchObject({
      granularity: "family",
      confidence: "partial",
      label: "Общий рейтинг бренда"
    });
    expect(identity.variantCount).toBeUndefined();
  });

  it("keeps a source-bound Canpol consumer product as its own exact human variant", () => {
    const identity = analyzeProductIdentity({
      brand: "Canpol Babies",
      product: "Canpol Babies бутылочка антиколиковая 120 мл 6 мес+ в Москве",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Canpol Babies бутылочка антиколиковая 120 мл 6 мес+ в Москве" }],
        variants: [],
        identifiers: [{ type: "product_id", value: "canpol-120" }],
        imageUrls: [],
        instructionUrls: []
      }
    });

    expect(identity).toMatchObject({
      label: "бутылочка антиколиковая 120 мл 6 мес+",
      granularity: "variant",
      confidence: "exact",
      missing: []
    });
  });

  it("does not auto-exact a consumer title without a stable product id", () => {
    const identity = analyzeProductIdentity({
      brand: "Canpol Babies",
      product: "Canpol Babies пустышка силиконовая",
      evidence: {
        scope: "product_family",
        signals: [{ source: "title", text: "Canpol Babies пустышка силиконовая" }],
        variants: [], identifiers: [], imageUrls: [], instructionUrls: []
      }
    });

    expect(identity.granularity).not.toBe("variant");
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
    expect(identity).toMatchObject({ granularity: "family", variantCount: 2 });
    expect(identity.label).toContain("таблетки №20");
    expect(identity.label).not.toContain("Вариант не определён");
  });

  it("keeps compound strength and is idempotent across repeated publications", () => {
    expect(canonicalProductDescriptor("Полиоксидоний", "Полиоксидоний раствор 6 мг/мл, флакон 5 мл, 1 шт"))
      .toBe("раствор 6 мг/мл 5 мл");
    const once = canonicalProductDescriptors([{ brand: "Полиоксидоний", product: "Лиоф. д/приг. р-ра, фл. polioksidonii", url: "https://example.ru/polioksidonii" }])[0];
    const twice = canonicalProductDescriptors([{ brand: "Полиоксидоний", product: once, url: "https://example.ru/polioksidonii" }])[0];
    expect(twice).toBe(once);
    expect(canonicalProductDescriptor("Бактоблис", "Общая карточка бренда (3 варианта)"))
      .toBe("Общая карточка бренда (3 варианта)");
    expect(canonicalProductDescriptor("Бактоблис", "Общая карточка линейки «Плюс» (2 варианта)"))
      .toBe("Общая карточка бренда (2 варианта)");
  });
});
