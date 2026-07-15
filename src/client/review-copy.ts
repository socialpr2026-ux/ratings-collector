import type { Observation, RunState } from "../shared/types.js";
import { isKnownReviewAggregateDomain } from "../shared/review-aggregates.js";

export type SetupReadiness = {
  configLoaded: boolean;
  sheetProvided: boolean;
  sheetValid: boolean;
  monthProvided: boolean;
  regionValid: boolean;
  domainCount: number;
  brandCount: number;
  checkCount: number;
  maxChecks: number;
};

export type UserAction = "load" | "restore" | "start" | "retry" | "review" | "profile" | "publish";

const actionFallbacks: Record<UserAction, string> = {
  load: "Не удалось открыть сервис. Обновите страницу через минуту.",
  restore: "Не удалось восстановить последний запуск. Можно начать новый сбор.",
  start: "Не удалось запустить сбор. Проверьте настройки и повторите.",
  retry: "Не удалось повторить проблемные площадки. Попробуйте ещё раз позже.",
  review: "Не удалось сохранить подтверждение. Повторите ещё раз.",
  profile: "Не удалось сохранить правило площадки. Проверьте выбор и повторите.",
  publish: "Не удалось обновить Google Таблицу. Проверьте доступ «Редактор» по ссылке и повторите."
};

function plural(count: number, one: string, few: string, many: string) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function setupReadinessText(state: SetupReadiness) {
  if (!state.configLoaded) return "Загружаем настройки сервиса…";
  if (!state.sheetProvided) return "Добавьте ссылку на Google Таблицу.";
  if (!state.sheetValid) return "Исправьте ссылку на Google Таблицу.";
  if (!state.monthProvided) return "Выберите месяц отчёта.";
  if (!state.regionValid) return "Укажите регион.";
  if (state.domainCount === 0) return "Добавьте хотя бы одну площадку.";
  if (state.brandCount === 0) return "Добавьте хотя бы один бренд.";
  if (state.checkCount > state.maxChecks) return `Слишком много проверок — максимум ${state.maxChecks}.`;
  return `Готово: ${state.domainCount} ${plural(state.domainCount, "площадка", "площадки", "площадок")} × ${state.brandCount} ${plural(state.brandCount, "бренд", "бренда", "брендов")}.`;
}

export function friendlyIssueText(value: string) {
  const raw = value.trim();
  if (!raw) return "Не удалось завершить проверку.";
  const scope = raw.match(/^([^:]{1,120}):\s*/)?.[1]?.trim();
  const prefix = scope ? `${scope}: ` : "";
  if (isQuotaIssue(raw)) {
    return `${prefix}исчерпан доступный лимит сбора.`;
  }
  if (/blocked[_\s-]*free[_\s-]*mode/i.test(raw)) {
    return `${prefix}площадка пока не поддерживается в бесплатном режиме.`;
  }
  if (/captcha|капч|\bpow\b|\b429\b|\b498\b|blocked|заблокирован|ограничил(?:а|и)?\s+(?:доступ|сбор)/i.test(raw)) {
    return `${prefix}площадка временно ограничила сбор. Повторите позже.`;
  }
  if (/parser[_\s-]*changed|парсер|селектор|структур\S*\s+(?:измен|обнов)/i.test(raw)) {
    return `${prefix}площадка изменила страницу и требует повторной настройки.`;
  }
  if (/needs[_\s-]*review/i.test(raw)) return `${prefix}карточка требует проверки.`;
  return raw
    .replace(/\b(?:quota_exceeded|parser_changed|needs_review|blocked|not_found)\s*:?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim() || "Не удалось завершить проверку.";
}

type IssueKind = "quota" | "unsupported" | "blocked" | "parser" | "review" | "other";

function isQuotaIssue(raw: string) {
  return /quota[_\s-]*exceeded|квот|лимит[^.]{0,80}(?:исчерпан|превышен)|limit\s*exceeded/i.test(raw) ||
    /apify[^.]{0,120}(?:quota|квот|лимит|cost\s*(?:cap|limit)|budget)/i.test(raw);
}

function issueKind(raw: string): IssueKind {
  if (isQuotaIssue(raw)) return "quota";
  if (/blocked[_\s-]*free[_\s-]*mode/i.test(raw)) return "unsupported";
  if (/captcha|капч|\bpow\b|\b429\b|\b498\b|blocked|заблокирован|ограничил(?:а|и)?\s+(?:доступ|сбор)/i.test(raw)) return "blocked";
  if (/parser[_\s-]*changed|парсер|селектор|структур\S*\s+(?:измен|обнов)/i.test(raw)) return "parser";
  if (/needs[_\s-]*review/i.test(raw)) return "review";
  return "other";
}

function issueDomain(raw: string): string | undefined {
  return raw.match(/^([a-z0-9.-]+)(?::|\s*\/)/i)?.[1]?.replace(/^www\./, "").toLocaleLowerCase("ru-RU");
}

/** Collapses the same site-level failure across many brands into one actionable line. */
export function summarizeIssues(values: readonly string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const grouped = new Map<string, { domain: string; kind: Exclude<IssueKind, "other">; count: number }>();
  const other: string[] = [];
  for (const raw of unique) {
    const kind = issueKind(raw);
    const domain = issueDomain(raw);
    if (kind === "other" || !domain) {
      other.push(friendlyIssueText(raw));
      continue;
    }
    const key = `${domain}\u0000${kind}`;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, { domain, kind, count: 1 });
  }
  const groupedLines = [...grouped.values()].map(({ domain, kind, count }) => {
    const suffix = count > 1 ? ` (${count} ${plural(count, "проверка", "проверки", "проверок")})` : "";
    if (kind === "quota") return `${domain}: исчерпан доступный лимит сбора${suffix}.`;
    if (kind === "unsupported") return `${domain}: площадка пока не поддерживается в бесплатном режиме${suffix}.`;
    if (kind === "blocked") return `${domain}: площадка не дала завершить автоматический сбор${suffix}.`;
    if (kind === "parser") return `${domain}: требуется повторная настройка сбора${suffix}.`;
    return `${domain}: проверьте найденную карточку выше${suffix}.`;
  });
  return [...groupedLines, ...new Set(other)];
}

export function friendlyErrorMessage(error: unknown, action: UserAction) {
  const raw = (error instanceof Error ? error.message : String(error ?? "")).trim();
  if (!raw) return actionFallbacks[action];
  if (/failed to fetch|network(?:error)?|fetch failed|timeout|timed out|econn|socket hang up/i.test(raw)) {
    return "Нет связи с сервисом. Проверьте интернет и повторите.";
  }
  if (isQuotaIssue(raw)) {
    return "Доступный лимит сбора исчерпан. Повторите позже или временно уберите эту площадку.";
  }
  if (/captcha|капч|\bpow\b|\b429\b|\b498\b|blocked|заблокирован/i.test(raw)) {
    return "Площадка временно ограничила автоматический сбор. Повторите позже.";
  }
  if (/parser[_\s-]*changed|парсер|селектор|структур\S*\s+(?:измен|обнов)/i.test(raw)) {
    return "Площадка изменила страницу. Её нужно повторно проверить перед публикацией.";
  }
  if (action === "review" && /не содержит доказанного товарного варианта/i.test(raw)) {
    return "Карточке не хватает данных для точного определения товара. Обновите страницу; если сообщение останется, не подтверждайте эту карточку.";
  }
  if (action === "publish" && /freeze columns|frozen columns|merged cell|закреп\S* столбц|объедин[её]нн\S* яче/i.test(raw)) {
    return "Не удалось применить оформление таблицы. Результат сбора сохранён — повторите запись.";
  }
  if (action === "publish" && /revision[_\s-]*mismatch|таблиц\S* изменил|изменилась после чтения/i.test(raw)) {
    return "Таблица изменилась во время записи. Результат сбора сохранён — повторите запись.";
  }
  if (action === "publish" && /sheet[_\s-]*too[_\s-]*large|превышает лимит|лист слишком велик/i.test(raw)) {
    return "Лист слишком велик для безопасной записи. Удалите лишние пустые строки или столбцы и повторите.";
  }
  if (/permission|forbidden|public[_\s-]*edit[_\s-]*required|доступ[^.]{0,80}(?:таблиц|редактор)|ролью\s+[«\"]?редактор/i.test(raw)) {
    return actionFallbacks.publish;
  }
  if (action === "publish") {
    return "Не удалось записать данные в Google Таблицу. Результат сбора сохранён — повторите запись.";
  }
  if (/\/api\/|syntaxerror|unexpected token|internal server|service unavailable|status code|\bat\s+\w+\s*\(|\b[a-z]+_[a-z_]+\b|\b(?:typeerror|econn\w*|etimedout)\b/i.test(raw)) {
    return actionFallbacks[action];
  }
  return raw.length <= 240 ? raw : actionFallbacks[action];
}

export function observationMatchesQuery(
  item: Pick<Observation, "domain" | "brand" | "product" | "listingId" | "productIdentity">,
  query: string
) {
  const needle = query.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  if (!needle) return true;
  return [item.domain, item.brand, item.product, item.listingId, item.productIdentity?.label]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .includes(needle);
}

export function observationIssueText(item: Pick<Observation, "reviews" | "rating" | "productIdentity">) {
  const identity = item.productIdentity;
  if (identity?.granularity === "not_product") return "Не является товаром";
  if (item.reviews === null) return "Отзывы / оценки не получены";
  if (item.reviews > 0 && item.rating === null) return "Рейтинг не получен";
  if (item.reviews === 0 && item.rating !== null) return "Проверьте число отзывов / оценок";
  if (!identity || identity.granularity === "unresolved" || identity.confidence !== "exact") return "Не хватает данных о варианте";
  return "Нужно сверить карточку";
}

export function canConfirmObservation(item: Pick<Observation, "reviews" | "rating" | "productIdentity" | "productEvidence"> & { domain?: string }) {
  const identity = item.productIdentity;
  const exactVariant = identity?.granularity === "variant" && identity.confidence === "exact";
  const knownReviewAggregate = Boolean(identity && isKnownReviewAggregateDomain(item.domain) &&
    identity.granularity !== "not_product" && identity.confidence !== "ambiguous");
  const provenAggregate = Boolean(identity && ["family", "line"].includes(identity.granularity) &&
    identity.confidence !== "ambiguous" &&
    (identity.confidence === "exact" || item.productEvidence?.scope === "product_family" || isKnownReviewAggregateDomain(item.domain)));
  const identityCanBeConfirmed = exactVariant || provenAggregate || knownReviewAggregate;
  return identityCanBeConfirmed && (item.reviews === 0
    ? item.rating === null
    : item.reviews !== null && item.reviews > 0 && item.rating !== null);
}

/** Keeps older saved runs presentable after the product-identity rules evolve. */
export function finalProductLabel(identityLabel: string, sourceTitle: string) {
  const knownProduct = identityLabel.match(/^Вариант не определён\s*·\s*известно:\s*(.+)$/i)?.[1]?.trim();
  if (knownProduct) return knownProduct;
  if (/^Вариант не определён$/i.test(identityLabel.trim())) return sourceTitle.trim() || "Продукт по данным площадки";
  return identityLabel.trim() || sourceTitle.trim() || "Продукт по данным площадки";
}

/**
 * Product proof shown to an operator must stay semantic and bounded. Raw
 * `productEvidence.variants` are intentionally excluded here: on review sites
 * a comment card can use the same generic DOM class as a product switcher and
 * its heading must never be presented as a product characteristic.
 */
export function productProofLines(item: Pick<Observation, "productIdentity">): string[] {
  const identity = item.productIdentity;
  if (!identity) return [];
  const result = identity.granularity === "variant"
    ? [`Определён товарный вариант: ${identity.label}`]
    : identity.granularity === "not_product"
      ? []
      : [`Определена общая карточка: ${identity.label}`];
  for (const reason of identity.reasons) {
    const value = reason.trim();
    if (value && !result.includes(value)) result.push(value);
  }
  return result.slice(0, 5);
}

export function canRetryFailedPartitions(status: "queued" | "running" | "review" | "publishing" | "published" | "failed", failedPartitionCount: number) {
  return failedPartitionCount > 0 && (status === "review" || status === "failed");
}

/** Local Chrome is a reserve route, never a first choice or a parser workaround. */
export function ozonCompanionEligibleBrands(
  run: Pick<RunState, "status" | "request" | "partitions">
): string[] {
  if (!["review", "failed"].includes(run.status) || !run.request.domains.includes("ozon.ru")) return [];
  return run.request.brands.filter((brand) => run.partitions.some((partition) =>
    partition.domain === "ozon.ru" &&
    partition.brand === brand &&
    !["complete", "no_results"].includes(partition.status) &&
    /^(?:blocked|quota_exceeded)\s*:/i.test(partition.message?.trim() ?? "")
  ));
}

export function reviewIntroText(reviewCount: number, failedPartitionCount: number) {
  if (failedPartitionCount > 0) {
    const blockerText = `Не завершено проверок: ${failedPartitionCount}. Запись отключена, чтобы в таблицу не попали частичные данные.`;
    return reviewCount > 0
      ? `${reviewCount} ${plural(reviewCount, "карточка требует", "карточки требуют", "карточек требуют")} решения. Откройте карточку, сверьте товар и отметьте подходящие. ${blockerText}`
      : `Спорных карточек нет, но сбор завершён не полностью. ${blockerText}`;
  }
  return reviewCount > 0
    ? `${reviewCount} ${plural(reviewCount, "карточка требует", "карточки требуют", "карточек требуют")} решения. Откройте карточку, сверьте товар и отметьте подходящие.`
    : "Все карточки определены. Результат готов к записи в таблицу.";
}
