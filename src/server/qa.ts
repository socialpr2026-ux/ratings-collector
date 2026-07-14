import { observationSchema, type Observation, type RunState } from "../shared/types.js";
import { productKey } from "./repository.js";

export type QaResult = { ok: boolean; blockers: string[]; warnings: string[] };

export function validateRun(run: RunState): QaResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const expected = run.request.domains.length * run.request.brands.length;
  const expectedPartitions = new Set(
    run.request.domains.flatMap((domain) => run.request.brands.map((brand) => `${domain}\u0000${brand}`))
  );
  const actualPartitions = new Set<string>();
  if (run.progress.totalPartitions !== expected) {
    blockers.push(`Ожидалось разделов ${expected}, в прогрессе указано ${run.progress.totalPartitions}`);
  }
  if (run.progress.completedPartitions !== expected) {
    blockers.push(`Завершено разделов ${run.progress.completedPartitions} из ${expected}`);
  }
  if (run.partitions.length !== expected) {
    blockers.push(`Проверено разделов ${run.partitions.length} из ${expected}`);
  }
  for (const partition of run.partitions) {
    const key = `${partition.domain}\u0000${partition.brand}`;
    if (!expectedPartitions.has(key)) blockers.push(`Лишний раздел: ${partition.domain} / ${partition.brand}`);
    if (actualPartitions.has(key)) blockers.push(`Дублирован раздел: ${partition.domain} / ${partition.brand}`);
    actualPartitions.add(key);
    if (!['complete', 'no_results'].includes(partition.status)) {
      blockers.push(`${partition.domain} / ${partition.brand}: ${partition.message ?? partition.status}`);
    }
    if (partition.status === 'complete' && partition.discovered === 0) {
      blockers.push(`${partition.domain} / ${partition.brand}: complete без найденных карточек`);
    }
    if (partition.status === 'no_results' && (partition.discovered !== 0 || partition.collected !== 0)) {
      blockers.push(`${partition.domain} / ${partition.brand}: некорректный no_results`);
    }
  }
  for (const key of expectedPartitions) {
    if (actualPartitions.has(key)) continue;
    const [domain, brand] = key.split("\u0000");
    blockers.push(`Не проверен раздел: ${domain} / ${brand}`);
  }
  const seen = new Set<string>();
  const observationsByPartition = new Map<string, number>();
  for (const item of run.observations) {
    const parsed = observationSchema.safeParse(item);
    if (!parsed.success) {
      blockers.push(`${item.domain}:${item.listingId}: результат не соответствует контракту`);
      continue;
    }
    if (!run.request.domains.includes(item.domain) || !run.request.brands.includes(item.brand)) {
      blockers.push(`${item.domain}:${item.listingId}: карточка вне запрошенного набора`);
    }
    const partitionKey = `${item.domain}\u0000${item.brand}`;
    observationsByPartition.set(partitionKey, (observationsByPartition.get(partitionKey) ?? 0) + 1);
    const key = productKey(item.domain, item.listingId);
    if (seen.has(key)) blockers.push(`Дубликат устойчивого ID: ${key}`);
    seen.add(key);
    if (!['ok', 'no_reviews', 'not_found'].includes(item.status)) blockers.push(`${key}: статус ${item.status}`);
    if (item.status === 'no_reviews' && (item.reviews !== 0 || item.rating !== null)) {
      blockers.push(`${key}: карточка без отзывов должна иметь 0 и пустой рейтинг`);
    }
    if (item.status === 'ok' && (
      item.reviews === null ||
      item.reviews <= 0 ||
      (item.rating === null && item.ratingUnavailable !== true) ||
      (item.ratingUnavailable === true && (item.rating !== null || item.rawRating !== 0))
    )) {
      blockers.push(`${key}: неполные метрики успешной карточки`);
    }
    if (item.status === 'ok' && item.ratingUnavailable === true) {
      warnings.push(`${key}: площадка ещё не рассчитала общий рейтинг`);
    }
    if (item.status === 'not_found') {
      if (!item.historical) blockers.push(`${key}: not_found допустим только для исторической карточки`);
      if (item.reviews !== null || item.rating !== null) {
        blockers.push(`${key}: исчезнувшая историческая карточка должна иметь пустые метрики`);
      }
    }
    // A rating/vote count greater than the written-review count is normal on
    // marketplaces and review aggregators (notably Megapteka and Yandex).
    // Warn only for the impossible-looking inverse relationship.
    if (item.ratingCount != null && item.reviews != null && item.ratingCount < item.reviews) {
      warnings.push(`${key}: оценок ${item.ratingCount}, текстовых отзывов ${item.reviews}`);
    }
  }
  for (const partition of run.partitions) {
    const key = `${partition.domain}\u0000${partition.brand}`;
    const observationCount = observationsByPartition.get(key) ?? 0;
    if (partition.status === "complete" && partition.collected !== partition.discovered) {
      blockers.push(`${partition.domain} / ${partition.brand}: собрано ${partition.collected} из ${partition.discovered} найденных карточек`);
    }
    if (partition.status === "complete" && observationCount !== partition.collected) {
      blockers.push(`${partition.domain} / ${partition.brand}: в снимке ${observationCount} карточек при collected=${partition.collected}`);
    }
    if (partition.status === "no_results" && observationCount !== 0) {
      blockers.push(`${partition.domain} / ${partition.brand}: no_results содержит ${observationCount} карточек`);
    }
  }
  const failedPartitionErrors = new Set(
    run.partitions
      .filter((partition) => !["complete", "no_results"].includes(partition.status))
      .map((partition) => `${partition.domain}/${partition.brand}`)
  );
  // A failed partition already contributes one concise blocker above. The
  // technical error log is retained on the run, but repeating it in QA made
  // the same quota/parser failure appear two or three times to the employee.
  for (const error of run.errors) {
    if (failedPartitionErrors.has(error.partition)) continue;
    blockers.push(`${error.partition}: ${error.message}`);
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}
