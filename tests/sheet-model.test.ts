import { describe, expect, it } from "vitest";
import { buildSheetDocument } from "../src/server/sheets/model.js";
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
    expect(row.slice(0, 6)).toEqual(["Кагоцел", current.canonicalUrl, "таблетки 12 мг №20", null, 5800, 4.7]);
    expect(document.values[0].slice(0, 5)).toEqual(["Бренд", "Ссылка", "Продукт", null, "Июль 2026"]);
    expect(document.merges).toContainEqual({ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 });
    expect(document.merges).toContainEqual({ startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 });
    expect(document.merges).toContainEqual({ startRow: 0, endRow: 2, startColumn: 2, endColumn: 3 });
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
      "Анвифен", `${url}/`, "Общая карточка бренда", null, 5, 3.6, 6, 3.7
    ]);
  });

  it("normalizes line breaks and tabs in product names before clipboard publication", () => {
    const noisy = { ...observation("149024615"), product: "Кагоцел\tтаблетки\r\n 12 мг №20" };
    const document = buildSheetDocument({ values: [] }, request, [], {
      "2026-07": { "ozon.ru:149024615": noisy }
    });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row[0]).toBe("Кагоцел");
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

  it("clears the current pair when a SKU disappears on a same-month rerun", () => {
    const existing = { values: [
      [null, null, null, "Июль 2026"], [null, null, null, "Отзывы", "Рейтинг"],
      ["ozon.ru", "Продукт"], ["https://www.ozon.ru/product/kagotsel-99/", "Кагоцел — таблетки", null, 10, 3.9]
    ] };
    const document = buildSheetDocument(existing, request, [], { "2026-07": {} });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(row.slice(4, 6)).toEqual([null, null]);
  });

  it("preserves out-of-scope brands and their metrics during a partial-brand run", () => {
    const existing = { values: [
      [null, null, null, "Июль 2026"], [null, null, null, "Отзывы", "Рейтинг"],
      ["ozon.ru", "Продукт"],
      ["https://www.ozon.ru/product/kagotsel-99/", "Кагоцел — таблетки №20", null, 10, 4.9]
    ] };
    const partialRequest = { ...request, brands: ["Бактоблис"] };

    const document = buildSheetDocument(existing, partialRequest, [], { "2026-07": {} });
    const row = document.values.find((value) => value[1] === "https://www.ozon.ru/product/kagotsel-99/")!;

    expect(row.slice(0, 6)).toEqual(["Кагоцел", "https://www.ozon.ru/product/kagotsel-99/", "таблетки №20", null, 10, 4.9]);
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
    expect(row.slice(0, 3)).toEqual(["Кагоцел", record.canonicalUrl, "таблетки №20"]);
  });

  it("emits one section and one row per historical product when a domain or brand repeats", () => {
    const records: ProductRecord[] = ["1", "2"].map((listingId) => ({
      key: `history.example:${listingId}`, domain: "history.example", listingId, brand: "Исторический бренд",
      platform: "history", canonicalUrl: `https://history.example/p/${listingId}`,
      product: `Исторический бренд — упаковка ${listingId}`, firstSeenMonth: "2026-06", lastSeenMonth: "2026-06"
    }));
    const document = buildSheetDocument({ values: [] }, request, records, {});
    const sections = document.values.filter((_, index) => document.rowKinds[index] === "section").map((row) => row[0]);
    expect(sections).toEqual(["history.example"]);
    expect(document.values.filter((_, index) => document.rowKinds[index] === "product")).toHaveLength(2);
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
    expect(summary[1][4]).toContain('E$3:E');
    expect(summary[1][4]).toContain('">0"');
    expect(summary[1][4]).toContain('$B$3:$B');
    expect(summary[2][4]).toContain('"<4"');
    expect(summary[2][4]).toContain('"<>"');
    expect(summary[3][4]).toContain(';0;');
    expect(summary[3][4]).toContain(';"<>";');
    expect(summary[3][4]).toContain(';"";');
  });

  it("re-reads the new brand/link/product layout without losing history", () => {
    const existing = { values: [
      ["Бренд", "Ссылка", "Продукт", null, "Июнь 2026"],
      [null, null, null, null, "Отзывы", "Рейтинг"],
      ["ozon.ru", null, "Продукт", null],
      ["Кагоцел", "https://www.ozon.ru/product/kagotsel-99/", "таблетки 12 мг №20", null, 9, 4.8]
    ] };
    const document = buildSheetDocument(existing, request, [], { "2026-07": {} });
    const row = document.values.find((_, index) => document.rowKinds[index] === "product")!;
    expect(document.months).toEqual(["2026-06", "2026-07"]);
    expect(row.slice(0, 8)).toEqual([
      "Кагоцел", "https://www.ozon.ru/product/kagotsel-99/", "таблетки 12 мг №20", null, 9, 4.8, null, null
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
