import { describe, expect, it } from "vitest";
import {
  BRAND_SHEET_COLUMNS_TEXT,
  brandSheetDestinationText,
  canConfirmObservation,
  canRetryFailedPartitions,
  finalProductLabel,
  friendlyErrorMessage,
  friendlyIssueText,
  observationIssueText,
  observationMatchesQuery,
  productProofLines,
  reviewIntroText,
  setupReadinessText,
  summarizeIssues
} from "../src/client/review-copy.js";

describe("review summary copy", () => {
  it("describes per-brand sheets without a duplicate brand column", () => {
    expect(BRAND_SHEET_COLUMNS_TEXT).toBe("Столбцы каждого листа: Площадка · Ссылка · Продукт · Отзывы / оценки · Рейтинг.");
    expect(BRAND_SHEET_COLUMNS_TEXT).not.toContain("Бренд ·");
    expect(brandSheetDestinationText(1)).toBe("листе бренда");
    expect(brandSheetDestinationText(2)).toBe("отдельных листах брендов");
  });

  it("distinguishes clean cards from an incomplete blocked collection", () => {
    expect(reviewIntroText(0, 2)).toBe(
      "Спорных карточек нет, но сбор завершён не полностью. Не завершено проверок: 2. Запись отключена, чтобы в таблицу не попали частичные данные."
    );
  });

  it("keeps the normal clean-run message when every partition completed", () => {
    expect(reviewIntroText(0, 0)).toBe(
      "Все карточки определены. Результат готов к записи в таблицу."
    );
  });

  it("uses natural singular and plural forms", () => {
    expect(reviewIntroText(1, 0)).toContain("1 карточка требует решения");
    expect(reviewIntroText(3, 0)).toContain("3 карточки требуют решения");
    expect(reviewIntroText(15, 0)).toContain("15 карточек требуют решения");
  });
});

describe("setup readiness copy", () => {
  const ready = {
    configLoaded: true,
    sheetProvided: true,
    sheetValid: true,
    monthProvided: true,
    regionValid: true,
    domainCount: 3,
    brandCount: 1,
    checkCount: 3,
    maxChecks: 600
  };

  it("points to the first missing setup field", () => {
    expect(setupReadinessText({ ...ready, sheetProvided: false })).toBe("Добавьте ссылку на Google Таблицу.");
    expect(setupReadinessText({ ...ready, brandCount: 0 })).toBe("Добавьте хотя бы один бренд.");
  });

  it("explains a partition-limit blocker", () => {
    expect(setupReadinessText({ ...ready, checkCount: 601 })).toBe("Слишком много проверок — максимум 600.");
  });

  it("summarizes the ready run in plain language", () => {
    expect(setupReadinessText(ready)).toBe("Готово: 3 площадки × 1 бренд.");
  });
});

describe("plain-language feedback", () => {
  it("hides infrastructure wording in common errors", () => {
    expect(friendlyErrorMessage(new Error("Failed to fetch"), "start")).toBe("Нет связи с сервисом. Проверьте интернет и повторите.");
    expect(friendlyErrorMessage("quota_exceeded: Apify limit reached", "start")).toBe("Доступный лимит сбора исчерпан. Повторите позже или временно уберите эту площадку.");
    expect(friendlyErrorMessage("POST /api/runs returned status code 500", "start")).toBe("Не удалось запустить сбор. Проверьте настройки и повторите.");
    expect(friendlyErrorMessage("permission denied", "publish")).toContain("доступ «Редактор»");
  });

  it("does not misreport a Sheets layout failure as missing edit access", () => {
    const message = friendlyErrorMessage(
      "Sorry, you can't freeze columns which contain only part of a merged cell.",
      "publish"
    );
    expect(message).toBe("Не удалось применить оформление таблицы. Результат сбора сохранён — повторите запись.");
    expect(message).not.toContain("Редактор");
  });

  it("keeps unknown publication failures retryable without blaming permissions", () => {
    const message = friendlyErrorMessage("Неожиданная ошибка оформления", "publish");
    expect(message).toBe("Не удалось записать данные в Google Таблицу. Результат сбора сохранён — повторите запись.");
    expect(message).not.toContain("Редактор");
  });

  it("keeps the affected site while simplifying QA blockers", () => {
    expect(friendlyIssueText("ozon.ru / Анвифен: quota_exceeded: квота исчерпана")).toBe("ozon.ru / Анвифен: исчерпан доступный лимит сбора.");
    expect(friendlyIssueText("wildberries.ru: HTTP 429 blocked")).toBe("wildberries.ru: площадка временно ограничила сбор. Повторите позже.");
    expect(friendlyIssueText("medum.ru: parser_changed: blocked_free_mode")).toBe("medum.ru: площадка пока не поддерживается в бесплатном режиме.");
  });

  it("groups the same site failure across brands", () => {
    expect(summarizeIssues([
      "ozon.ru / Тикализис: quota_exceeded: квота исчерпана",
      "ozon.ru / Даксабрис: quota_exceeded: квота исчерпана",
      "irecommend.ru:11557796: статус needs_review"
    ])).toEqual([
      "ozon.ru: исчерпан доступный лимит сбора (2 проверки).",
      "irecommend.ru: проверьте найденную карточку выше."
    ]);
  });

  it("explains why a card cannot be confirmed", () => {
    const exact = { label: "таблетки №20", granularity: "variant" as const, confidence: "exact" as const, missing: [], reasons: [] };
    expect(observationIssueText({ reviews: null, rating: null, productIdentity: exact })).toBe("Отзывы / оценки не получены");
    expect(observationIssueText({ reviews: 0, rating: 4.8, productIdentity: exact })).toBe("Проверьте число отзывов / оценок");
    expect(observationIssueText({ reviews: 12, rating: null, productIdentity: exact })).toBe("Рейтинг не получен");
    expect(observationIssueText({ reviews: 12, rating: 4.8, productIdentity: { ...exact, granularity: "unresolved", confidence: "partial" } })).toBe("Не хватает данных о варианте");
  });

  it("finds a long-list card by brand, site, product or id", () => {
    const item = { domain: "market.yandex.ru", brand: "Кагоцел", product: "Таблетки №20", listingId: "265149860", productIdentity: undefined };
    expect(observationMatchesQuery(item, "кагоцел")).toBe(true);
    expect(observationMatchesQuery(item, "таблетки №20")).toBe(true);
    expect(observationMatchesQuery(item, "265149860")).toBe(true);
    expect(observationMatchesQuery(item, "озон")).toBe(false);
  });
});

describe("review confirmation eligibility", () => {
  it("allows only cards with complete publishable metrics", () => {
    const exact = { label: "таблетки 100 мг №10", granularity: "variant" as const, confidence: "exact" as const, missing: [], reasons: [] };
    expect(canConfirmObservation({ reviews: 12, rating: 4.8, productIdentity: exact })).toBe(true);
    expect(canConfirmObservation({ reviews: 0, rating: null, productIdentity: exact })).toBe(true);
    expect(canConfirmObservation({ reviews: 0, rating: 4.8 })).toBe(false);
    expect(canConfirmObservation({ reviews: null, rating: null })).toBe(false);
    expect(canConfirmObservation({ reviews: 12, rating: null })).toBe(false);
    expect(canConfirmObservation({ reviews: 12, rating: 4.8, productIdentity: { ...exact, label: "Общая карточка формы «таблетки»", granularity: "unresolved", confidence: "partial" } })).toBe(false);
    expect(canConfirmObservation({
      reviews: 12,
      rating: 4.8,
      productIdentity: { ...exact, label: "Общая карточка бренда", granularity: "family", confidence: "partial" },
      productEvidence: { scope: "product_family", signals: [], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] }
    })).toBe(true);
    expect(canConfirmObservation({
      domain: "irecommend.ru",
      reviews: 12,
      rating: 4.8,
      productIdentity: { ...exact, label: "Общая карточка бренда", granularity: "family", confidence: "partial" },
      productEvidence: { scope: "listing", signals: [], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] }
    })).toBe(true);
    expect(canConfirmObservation({
      domain: "market.yandex.ru",
      reviews: 3,
      rating: 4.9,
      productIdentity: { ...exact, label: "Общая карточка бренда", granularity: "unresolved", confidence: "partial" },
      productEvidence: { scope: "listing", signals: [], variants: [], identifiers: [], imageUrls: [], instructionUrls: [] }
    })).toBe(true);
    expect(canConfirmObservation({ reviews: 12, rating: 4.8, productIdentity: { ...exact, label: "Не товарная карточка", granularity: "not_product", confidence: "ambiguous" } })).toBe(false);
  });
});

describe("final product labels", () => {
  it("removes draft wording from older saved runs", () => {
    expect(finalProductLabel("Вариант не определён · известно: таблетки №20", "Кагоцел таблетки №20")).toBe("таблетки №20");
    expect(finalProductLabel("Вариант не определён", "Кагоцел таблетки №10")).toBe("Кагоцел таблетки №10");
  });

  it("keeps already final product labels unchanged", () => {
    expect(finalProductLabel("таблетки №20", "Кагоцел таблетки №20")).toBe("таблетки №20");
  });

  it("shows semantic product proof without leaking raw review-page fragments", () => {
    const productIdentity = {
      label: "гранулы №30",
      granularity: "variant" as const,
      confidence: "exact" as const,
      missing: [],
      reasons: ["Единственный товарный вариант подтверждён названием карточки"]
    };
    expect(productProofLines({ productIdentity })).toEqual([
      "Определён товарный вариант: гранулы №30",
      "Единственный товарный вариант подтверждён названием карточки"
    ]);
    expect(productProofLines({ productIdentity }).join(" ")).not.toContain("Гранулы или плацебо?");
  });
});

describe("failed partition retry eligibility", () => {
  it("offers retry only for a finished incomplete run", () => {
    expect(canRetryFailedPartitions("review", 1)).toBe(true);
    expect(canRetryFailedPartitions("failed", 3)).toBe(true);
    expect(canRetryFailedPartitions("review", 0)).toBe(false);
    expect(canRetryFailedPartitions("running", 1)).toBe(false);
    expect(canRetryFailedPartitions("publishing", 1)).toBe(false);
    expect(canRetryFailedPartitions("published", 1)).toBe(false);
  });
});
