import { describe, expect, it } from "vitest";
import { buildBrandSheetDocument, buildSheetDocument } from "../src/server/sheets/model.js";
import type { Observation, ProductRecord, RunRequest } from "../src/shared/types.js";

const request: RunRequest = {
  sheetUrl: "https://docs.google.com/spreadsheets/d/test_sheet_123/edit",
  month: "2026-07", region: "Москва", domains: ["ozon.ru"], brands: ["Кагоцел"]
};
const observation = (listingId: string, monthReviews = 100): Observation => ({
  domain: "ozon.ru", platform: "ozon", listingId, brand: "Кагоцел",
  canonicalUrl: `https://www.ozon.ru/product/kagotsel-${listingId}/`, product: "Кагоцел таблетки 12 мг №20",
  reviews: monthReviews, rating: 4.7, status: "ok", capturedAt: "2026-07-13T10:00:00.000Z"
});

describe("Google Sheets model", () => {
  it("writes one Khondrofen product for brand aggregates when only one variant is proven", () => {
    const familyIdentity: NonNullable<Observation["productIdentity"]> = {
      label: "Общий рейтинг бренда",
      granularity: "family" as const,
      confidence: "partial" as const,
      missing: [],
      reasons: ["Площадка публикует единый рейтинг без списка товарных вариантов"]
    };
    const exactIdentity: NonNullable<Observation["productIdentity"]> = {
      label: "мазь 30 г", granularity: "variant", confidence: "exact", missing: [], reasons: []
    };
    const sources: Array<[string, string, string, NonNullable<Observation["productIdentity"]>]> = [
      ["wildberries.ru", "822669171", "Хондрофен мазь для наружного применения 30 г 1 шт", exactIdentity],
      ["irecommend.ru", "3232715", "Лекарственный препарат Биосинтез ХОНДРОФЕН мазь для наружного применения", familyIdentity],
      ["med-otzyv.ru", "751", "Хондрофен", familyIdentity],
      ["review.example", "khondrofen", "Мазь Биосинтез Хондрофен", familyIdentity]
    ];
    const observations = sources.map(([domain, listingId, product, productIdentity]): Observation => ({
      domain, platform: domain, listingId, brand: "Хондрофен",
      canonicalUrl: `https://${domain}/product/${listingId}`, product,
      reviews: 1, rating: 4.8, status: "ok", capturedAt: "2026-07-15T00:00:00.000Z",
      productIdentity
    }));
    const khondrofenRequest: RunRequest = {
      ...request,
      domains: sources.map(([domain]) => domain),
      brands: ["Хондрофен"]
    };
    const document = buildSheetDocument({ values: [] }, khondrofenRequest, [], {
      "2026-07": Object.fromEntries(observations.map((item) => [`${item.domain}:${item.listingId}`, item]))
    });

    expect(document.values
      .filter((_row, index) => document.rowKinds[index] === "product")
      .map((row) => [row[2], row[0]]))
      .toEqual([
        ["мазь 30 г", "iRecommend"],
        ["мазь 30 г", "Мед-отзыв"],
        ["мазь 30 г", "review.example"],
        ["мазь 30 г", "Wildberries"]
      ]);
  });

  it("publishes one human product label for equivalent variants from different sites", () => {
    const variants: Observation[] = [
      ["megamarket.ru", "100024502669", "Оциллококцинум гранулы гомеопатические 1 г №30"],
      ["apteka.ru", "5e3268eaca7bdc000192d316", "Оциллококцинум гранулы №30"],
      ["otzyv.pro", "62074", "Оциллококцинум 30 доз гранулы гомеопатические"]
    ].map(([domain, listingId, product]) => ({
      domain,
      platform: domain,
      listingId,
      brand: "Оциллококцинум",
      canonicalUrl: `https://${domain}/product/${listingId}`,
      product,
      reviews: 1,
      rating: 5,
      status: "ok" as const,
      capturedAt: "2026-07-15T00:00:00.000Z",
      productIdentity: {
        label: product.replace(/^Оциллококцинум\s+/u, ""),
        granularity: "variant" as const,
        confidence: "exact" as const,
        missing: [],
        reasons: []
      }
    }));
    const variantRequest: RunRequest = {
      ...request,
      domains: [...new Set(variants.map((item) => item.domain))],
      brands: ["Оциллококцинум"]
    };
    const document = buildSheetDocument({ values: [] }, variantRequest, [], {
      "2026-07": Object.fromEntries(variants.map((item) => [`${item.domain}:${item.listingId}`, item]))
    });

    expect(document.values
      .filter((_row, index) => document.rowKinds[index] === "product")
      .map((row) => row[2]))
      .toEqual(["гранулы №30", "гранулы №30", "гранулы №30"]);
  });

  it("updates the existing July pair without duplicating the legacy Ozon SKU", () => {
    const existing = { values: [
      ["Сайты отзывов, интернет-аптеки", null, null, "Июль"],
      [null, null, null, "Отзывы", "Рейтинг"],
      ["маркетплейсы", "Продукт"],
      ["https://www.ozon.ru/product/kagotsel-tabletki-149024614/?at=tracking", "таблетки 12мг №20", null, 5728, 4.9]
    ] };
    const current = observation("149024614", 5800);
    const document = buildSheetDocument(existing, request, [], { "2026-07": { "ozon.ru:149024614": current } });
    expect(document.months).toEqual(["2026-07"]);
    expect(document.values.filter((_, index) => document.rowKinds[index] === "product")).toHaveLength(1);
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row.slice(0, 6)).toEqual(["Ozon", current.canonicalUrl, "таблетки 12 мг №20", null, 5800, 4.7]);
    expect(document.values[0].slice(0, 5)).toEqual(["Рейтинги: Кагоцел", null, null, null, "Рейтинги товаров · Москва"]);
    expect(document.values[1].slice(0, 5)).toEqual(["Площадка", "Ссылка", "Продукт", null, "Июль 2026"]);
    expect(document.values[2].slice(4, 6)).toEqual(["Отзывы / оценки", "Рейтинг"]);
    expect(document.merges).toContainEqual({ startRow: 0, endRow: 1, startColumn: 0, endColumn: 4 });
    expect(document.merges).toContainEqual({ startRow: 1, endRow: 3, startColumn: 0, endColumn: 1 });
    expect(document.merges).toContainEqual({ startRow: 1, endRow: 3, startColumn: 1, endColumn: 2 });
    expect(document.merges).toContainEqual({ startRow: 1, endRow: 3, startColumn: 2, endColumn: 3 });
    expect(document.merges).toContainEqual({ startRow: 1, endRow: 3, startColumn: 3, endColumn: 4 });
    const summaryRows = document.rowKinds
      .map((kind, index) => kind === "summary" ? index : -1)
      .filter((index) => index >= 0);
    for (const summaryRow of summaryRows) {
      expect(document.merges).toContainEqual({ startRow: summaryRow, endRow: summaryRow + 1, startColumn: 0, endColumn: 3 });
    }
    expect(document.merges).toContainEqual({
      startRow: document.rowKinds.indexOf("footnote"),
      endRow: document.rowKinds.indexOf("footnote") + 1,
      startColumn: 0,
      endColumn: 3
    });
  });

  it("merges a legacy URL-hash row into a new stable platform ID without losing history", () => {
    const irecRequest: RunRequest = {
      ...request,
      domains: ["irecommend.ru"],
      brands: ["Анвифен"]
    };
    const url = "https://irecommend.ru/content/nootropnoe-sredstvo-rfarma-anvifen";
    const existing = { values: [
      [null, null, null, "Июнь 2026"],
      [null, null, null, "Отзывы", "Рейтинг"],
      ["irecommend.ru", "Продукт"],
      [url, "Анвифен — старое название", null, 5, 3.6]
    ] };
    const current: Observation = {
      domain: "irecommend.ru", platform: "irecommend.ru", listingId: "10168327", brand: "Анвифен",
      canonicalUrl: `${url}/`, product: "Ноотропное средство Рафарма Анвифен",
      reviews: 6, rating: 3.7, status: "ok", capturedAt: "2026-07-14T00:00:00.000Z"
    };

    const document = buildSheetDocument(existing, irecRequest, [], {
      "2026-07": { "irecommend.ru:10168327": current }
    });
    const rows = document.values.filter((_, index) => document.rowKinds[index] === "product");

    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 8)).toEqual([
      "iRecommend", `${url}/`, "Общая карточка бренда", null, 5, 3.6, 6, 3.7
    ]);
  });

  it("normalizes line breaks and tabs in product names before clipboard publication", () => {
    const noisy = { ...observation("149024615"), product: "Кагоцел\tтаблетки\r\n 12 мг №20" };
    const document = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024615": noisy }
    });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row[1]).toBe("https://www.ozon.ru/product/kagotsel-149024615/");
    expect(row[2]).toBe("таблетки 12 мг №20");
  });

  it("densifies sparse summary rows into explicit nulls for JSON publication", () => {
    const document = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024615": observation("149024615") }
    });

    for (const row of [...document.values, ...document.formulas]) {
      expect(row).toHaveLength(document.columnCount);
      expect(Array.from({ length: document.columnCount }, (_, column) => Object.hasOwn(row, column)))
        .not.toContain(false);
      expect(row).not.toContain(undefined);
    }
    const summaryHeader = document.rowKinds.indexOf("summaryHeader");
    expect(document.values[summaryHeader].slice(0, 4)).toEqual([null, null, null, null]);
  });

  it("adds exactly one pair for August and leaves July empty for a new SKU", () => {
    const product: ProductRecord = {
      key: "ozon.ru:2", domain: "ozon.ru", listingId: "2", brand: "Кагоцел", platform: "ozon",
      canonicalUrl: "https://www.ozon.ru/product/kagotsel-2/", product: "Кагоцел — таблетки №2",
      firstSeenMonth: "2026-08", lastSeenMonth: "2026-08"
    };
    const augustRequest = { ...request, month: "2026-08" };
    const document = buildSheetDocument({ values: [[null, null, null, "Июль 2026"]] }, augustRequest, [product], {
      "2026-08": { "ozon.ru:2": observation("2", 8) }
    });
    expect(document.months).toEqual(["2026-07", "2026-08"]);
    expect(document.columnCount).toBe(8);
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row.slice(4, 8)).toEqual([null, null, 8, 4.7]);
  });

  it("keeps a vanished SKU and uses dynamic summary ranges", () => {
    const existing = { values: [
      [null, null, null, "Июль 2026"], [null, null, null, "Отзывы", "Рейтинг"],
      ["ozon.ru", "Продукт"], ["https://www.ozon.ru/product/kagotsel-99/", "Кагоцел — таблетки", null, 10, 3.9]
    ] };
    const augustRequest = { ...request, month: "2026-08" };
    const document = buildSheetDocument(existing, augustRequest, [], { "2026-08": {} });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row.slice(4, 8)).toEqual([10, 3.9, null, null]);
    const formulas = document.formulas.flat().filter(Boolean).join("\n");
    expect(formulas).toContain('"\u003e=4"'.replace("\\u003e", ">"));
    expect(formulas).not.toContain("34");
  });

  it("publishes one human product row for variants sharing one proven Ozon aggregate", () => {
    const shared = "ozon:variants:148170210,148170802";
    const variants = [
      { listingId: "148170210", pack: 12, aggregateGroupId: shared },
      { listingId: "148170802", pack: 30, aggregateGroupId: shared }
    ].map(({ listingId, pack, aggregateGroupId }): Observation => ({
      domain: "ozon.ru", platform: "ozon", listingId, brand: "Оциллококцинум",
      canonicalUrl: `https://www.ozon.ru/product/otsillokoktsinum-${listingId}/`,
      product: `Оциллококцинум гранулы 1 г №${pack}`,
      reviews: 2454, rating: 4.9, status: "ok", capturedAt: "2026-07-15T00:00:00.000Z",
      aggregateGroupId,
      productIdentity: { label: `гранулы 1 г №${pack}`, granularity: "variant", confidence: "exact", missing: [], reasons: [] }
    }));
    const document = buildSheetDocument({ values: [] }, {
      ...request, brands: ["Оциллококцинум"]
    }, [], {
      "2026-07": Object.fromEntries(variants.map((item) => [`ozon.ru:${item.listingId}`, item]))
    });
    const rows = document.values.filter((_row, index) => document.rowKinds[index] === "product");
    const summary = document.formulas.filter((_row, index) => document.rowKinds[index] === "summary");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.slice(0, 6)).toEqual([
      "Ozon", "https://www.ozon.ru/product/otsillokoktsinum-148170210/",
      "гранулы 1 г №12 и №30", null, 2454, 4.9
    ]);
    expect(summary[0][4]).toBe("=SUM(E5)");
    expect(summary[1][4]).toBe('=COUNTIFS({F5};">=4";{E5};">0")');
  });

  it("never merges distinct listings merely because rating and review count match", () => {
    const first = {
      ...observation("baktoblis-sachet", 30),
      brand: "Бактоблис",
      product: "Бактоблис порошок в саше 1500 мг №15",
      rating: 4.9
    };
    const second = {
      ...observation("baktoblis-tablets", 30),
      brand: "Бактоблис",
      product: "Бактоблис таблетки для рассасывания №30",
      rating: 4.9
    };
    const document = buildSheetDocument({ values: [] }, {
      ...request, brands: ["Бактоблис"]
    }, [], {
      "2026-07": {
        [`ozon.ru:${first.listingId}`]: first,
        [`ozon.ru:${second.listingId}`]: second
      }
    });

    const rows = document.values.filter((_row, index) => document.rowKinds[index] === "product");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row[2])).toEqual([
      "порошок в саше 1500 мг №15",
      "таблетки для рассасывания №30"
    ]);
  });

  it("keeps shared-group variants separate when their monthly metrics conflict", () => {
    const shared = "ozon:variants:1,2";
    const first = { ...observation("149024614", 100), aggregateGroupId: shared };
    const second = { ...observation("149024615", 101), aggregateGroupId: shared };
    const document = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024614": first, "ozon.ru:149024615": second }
    });

    expect(document.values.filter((_row, index) => document.rowKinds[index] === "product")).toHaveLength(2);
  });

  it("does not merge unrelated cards merely because their metrics are equal", () => {
    const first = observation("149024614", 2454);
    const second = observation("149024615", 2454);
    const document = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024614": first, "ozon.ru:149024615": second }
    });
    const summary = document.formulas.filter((_row, index) => document.rowKinds[index] === "summary");

    expect(summary[0][4]).toBe("=SUM(E5;E6)");
  });

  it("clears the current pair when a SKU disappears on a same-month rerun", () => {
    const existing = { values: [
      [null, null, null, "Июль 2026"], [null, null, null, "Отзывы", "Рейтинг"],
      ["ozon.ru", "Продукт"], ["https://www.ozon.ru/product/kagotsel-99/", "Кагоцел — таблетки", null, 10, 3.9]
    ] };
    const document = buildSheetDocument(existing, request, [], { "2026-07": {} });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row.slice(4, 6)).toEqual([null, null]);
  });

  it("keeps an out-of-scope brand out of a dedicated brand sheet", () => {
    const existing = { values: [
      [null, null, null, "Июль 2026"], [null, null, null, "Отзывы", "Рейтинг"],
      ["ozon.ru", "Продукт"],
      ["https://www.ozon.ru/product/kagotsel-99/", "Кагоцел — таблетки №20", null, 10, 4.9]
    ] };
    const partialRequest = { ...request, brands: ["Бактоблис"] };

    const document = buildBrandSheetDocument(existing, partialRequest, "Бактоблис", [], { "2026-07": {} });
    expect(document.values.filter((_row, index) => document.rowKinds[index] === "product")).toEqual([]);
  });

  it("migrates a stored draft identity to a final human product label", () => {
    const record: ProductRecord = {
      key: "ozon.ru:99", domain: "ozon.ru", listingId: "99", brand: "Кагоцел", platform: "ozon",
      canonicalUrl: "https://www.ozon.ru/product/kagotsel-99/",
      product: "Вариант не определён · известно: таблетки №20",
      productIdentity: {
        label: "Вариант не определён · известно: таблетки №20",
        granularity: "unresolved", confidence: "partial", missing: ["strength_or_detail"], reasons: ["legacy"]
      },
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-07"
    };
    const document = buildSheetDocument({ values: [] }, request, [record], {});
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row.slice(0, 4)).toEqual(["Ozon", record.canonicalUrl, "таблетки №20", null]);
  });

  it("emits one section and one row per historical product when a domain or brand repeats", () => {
    const records: ProductRecord[] = ["1", "2"].map((listingId) => ({
      key: `history.example:${listingId}`, domain: "history.example", listingId, brand: "Исторический бренд",
      platform: "history", canonicalUrl: `https://history.example/p/${listingId}`,
      product: `Исторический бренд — упаковка ${listingId}`, firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    }));
    const document = buildSheetDocument({ values: [] }, request, records, {});
    const sections = document.values.filter((_, index) => document.rowKinds[index] === "section").map((row) => row[0]);
    expect(sections).toEqual(["Отзовики"]);
    const section = document.values[document.rowKinds.indexOf("section")];
    expect(section.slice(0, 3)).toEqual(["Отзовики", "Площадок: 1", "Карточек: 2"]);
    expect(document.values.filter((_, index) => document.rowKinds[index] === "product")).toHaveLength(2);
  });

  it("renders only three report sections and preserves platform order inside each section", () => {
    const domains = [
      "wildberries.ru", "otzovik.com", "ozon.ru", "uteka.ru", "irecommend.ru", "eapteka.ru"
    ];
    const brands = ["Альфа", "Бета"];
    const sources: Array<[string, string, string]> = [
      ["wildberries.ru", "wb-alpha", "Альфа"],
      ["otzovik.com", "review-beta", "Бета"],
      ["otzovik.com", "review-alpha", "Альфа"],
      ["ozon.ru", "ozon-alpha", "Альфа"],
      ["uteka.ru", "uteka-alpha", "Альфа"],
      ["irecommend.ru", "irec-alpha", "Альфа"],
      ["eapteka.ru", "eapteka-alpha", "Альфа"]
    ];
    const records: ProductRecord[] = sources.map(([domain, listingId, brand]) => ({
      key: `${domain}:${listingId}`, domain, listingId, brand, platform: domain,
      canonicalUrl: `https://${domain}/product/${listingId}`,
      product: `${brand} таблетки №10`, firstSeenMonth: "2026-07", lastSeenMonth: "2026-07"
    }));
    const document = buildSheetDocument({ values: [] }, { ...request, domains, brands }, records, {});
    const sections = document.values
      .filter((_row, index) => document.rowKinds[index] === "section")
      .map((row) => row[0]);
    const productDomains = document.values
      .filter((_row, index) => document.rowKinds[index] === "product")
      .map((row) => new URL(String(row[1])).hostname);
    const reviewRows = document.values
      .filter((_row, index) => document.rowKinds[index] === "product")
      .filter((row) => String(row[1]).includes("otzovik.com"));

    expect(sections).toEqual(["Отзовики", "Аптеки", "Маркетплейсы"]);
    expect(productDomains).toEqual([
      "otzovik.com", "otzovik.com", "irecommend.ru",
      "uteka.ru", "eapteka.ru",
      "wildberries.ru", "ozon.ru"
    ]);
    expect(reviewRows.map((row) => row[2])).toEqual(["таблетки №10", "таблетки №10"]);
  });

  it("classifies 4.9, 4.0, 3.9, rating zero, no reviews and blank errors without overlap", () => {
    const metric = (listingId: string, reviews: number, rating: number | null, status: "ok" | "no_reviews"): Observation => ({
      ...observation(listingId, reviews), rating, status
    });
    const observations = [
      metric("49", 10, 4.9, "ok"), metric("40", 10, 4.0, "ok"),
      metric("39", 10, 3.9, "ok"), metric("00", 10, 0, "ok"),
      metric("none", 0, null, "no_reviews")
    ];
    const blank: ProductRecord = {
      key: "ozon.ru:blank", domain: "ozon.ru", listingId: "blank", brand: "Кагоцел", platform: "ozon",
      canonicalUrl: "https://www.ozon.ru/product/kagotsel-blank/", product: "Кагоцел — недоступная карточка",
      firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    };
    const document = buildSheetDocument({ values: [] }, request, [blank], {
      "2026-07": Object.fromEntries(observations.map((item) => [`ozon.ru:${item.listingId}`, item]))
    });
    const rows = document.values.filter((_, index) => document.rowKinds[index] === "product");
    expect(rows.filter((row) => typeof row[5] === "number" && row[5] >= 4)).toHaveLength(2);
    expect(rows.filter((row) => typeof row[5] === "number" && row[5] < 4)).toHaveLength(2);
    expect(rows.filter((row) => row[4] === 0 && row[5] === null)).toHaveLength(1);
    expect(rows.filter((row) => row[4] === null && row[5] === null)).toHaveLength(1);

    const summary = document.formulas.filter((_, index) => document.rowKinds[index] === "summary");
    expect(summary[1][4]).toContain('">=4"');
    expect(summary[1][4]).toContain('{E');
    expect(summary[1][4]).toContain('">0"');
    expect(summary[1][4]).not.toContain('$B$3:$B');
    expect(summary[2][4]).toContain('"<4"');
    expect(summary[2][4]).toContain('"<>"');
    expect(summary[3][4]).toContain(';0;');
    expect(summary[3][4]).toContain(';"<>";');
    expect(summary[3][4]).toContain(';"")');
  });

  it("re-reads the new brand/link/product layout without losing history", () => {
    const existing = { values: [
      ["Бренд", "Ссылка", "Продукт", null, "Июнь 2026"],
      [null, null, null, null, "Отзывы / оценки", "Рейтинг"],
      ["ozon.ru", null, "Продукт", null],
      ["Кагоцел", "https://www.ozon.ru/product/kagotsel-99/", "таблетки 12 мг №20", null, 9, 4.8]
    ] };
    const document = buildSheetDocument(existing, request, [], { "2026-07": {} });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(document.months).toEqual(["2026-06", "2026-07"]);
    expect(document.values[2].slice(4, 8)).toEqual(["Отзывы / оценки", "Рейтинг", "Отзывы / оценки", "Рейтинг"]);
    expect(row.slice(0, 8)).toEqual([
      "Ozon", "https://www.ozon.ru/product/kagotsel-99/", "таблетки 12 мг №20", null, 9, 4.8, null, null
    ]);
  });

  it("re-reads the branded Interfox layout without losing the previous month", () => {
    const july = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024614": observation("149024614", 91) }
    });
    const august = buildSheetDocument({ values: july.values }, { ...request, month: "2026-08" }, [], {
      "2026-08": { "ozon.ru:149024614": observation("149024614", 103) }
    });
    const product = august.values.find((_row, index) => august.rowKinds[index] === "product")!;

    expect(august.months).toEqual(["2026-07", "2026-08"]);
    expect(product.slice(4, 8)).toEqual([91, 4.7, 103, 4.7]);
    expect(august.rowKinds.slice(0, 3)).toEqual(["brand", "title", "subheader"]);
  });

  it("uses unified feedback wording in the summary without changing formulas", () => {
    const document = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024615": observation("149024615", 12) }
    });
    const summaryLabels = document.values
      .filter((_row, index) => document.rowKinds[index] === "summary")
      .map((row) => row[0]);
    const footnote = document.values[document.rowKinds.indexOf("footnote")][0];

    expect(summaryLabels).toEqual([
      "Всего отзывов / оценок",
      "Карточки с рейтингом ≥4 баллов",
      "Карточки с рейтингом <4 баллов",
      "Карточки без отзывов / оценок"
    ]);
    expect(footnote).toContain("отзывов, оценок и голосов");
    expect(document.formulas.flat().filter(Boolean).join("\n")).toContain("=SUM(E");
  });

  it("builds an isolated brand report without a repeated brand column", () => {
    const beta: Observation = {
      ...observation("2", 17),
      brand: "Бета",
      canonicalUrl: "https://www.ozon.ru/product/beta-2/",
      product: "Бета таблетки №20"
    };
    const multiBrandRequest = { ...request, brands: ["Кагоцел", "Бета"] };
    const snapshots = {
      "2026-07": {
        "ozon.ru:149024614": observation("149024614", 91),
        "ozon.ru:2": beta
      }
    };

    const kagocel = buildBrandSheetDocument({ values: [] }, multiBrandRequest, "Кагоцел", [], snapshots);
    const betaSheet = buildBrandSheetDocument({ values: [] }, multiBrandRequest, "Бета", [], snapshots);

    expect(kagocel.values[0][0]).toBe("Рейтинги: Кагоцел");
    expect(betaSheet.values[0][0]).toBe("Рейтинги: Бета");
    expect(kagocel.values[1].slice(0, 4)).toEqual(["Площадка", "Ссылка", "Продукт", null]);
    expect(kagocel.values.filter((_row, index) => kagocel.rowKinds[index] === "product")).toHaveLength(1);
    expect(betaSheet.values.filter((_row, index) => betaSheet.rowKinds[index] === "product")).toHaveLength(1);
  });

  it("keeps history when a platform-first brand sheet is published again", () => {
    const julyObservation = observation("149024614", 91);
    const july = buildBrandSheetDocument({ values: [] }, request, "Кагоцел", [], {
      "2026-07": { "ozon.ru:149024614": julyObservation }
    });
    const augustObservation = observation("149024614", 96);
    const august = buildBrandSheetDocument({ values: july.values }, { ...request, month: "2026-08" }, "Кагоцел", [], {
      "2026-08": { "ozon.ru:149024614": augustObservation }
    });
    const row = august.values.find((_value, index) => august.rowKinds[index] === "product")!;

    expect(august.months).toEqual(["2026-07", "2026-08"]);
    expect(row.slice(0, 8)).toEqual([
      "Ozon", julyObservation.canonicalUrl, "таблетки 12 мг №20", null, 91, 4.7, 96, 4.7
    ]);
  });

  it("does not publish a medical article as a product row", () => {
    const article: Observation = {
      domain: "wildberries.ru", platform: "wildberries", listingId: "712021351", brand: "Циклоферон",
      canonicalUrl: "https://www.wildberries.ru/catalog/712021351/detail.aspx",
      product: "Применение Циклоферона в пародонтологии", reviews: 7, rating: 5,
      status: "ok", capturedAt: "2026-07-13T10:00:00.000Z"
    };
    const document = buildSheetDocument({ values: [] }, {
      ...request, domains: ["wildberries.ru"], brands: ["Циклоферон"]
    }, [], { "2026-07": { "wildberries.ru:712021351": article } });

    expect(document.values.filter((_row, index) => document.rowKinds[index] === "product")).toEqual([]);
  });
});
