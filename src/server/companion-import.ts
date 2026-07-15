import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Observation, RunState } from "../shared/types.js";
import {
  ozonCompanionImportSchema,
  ozonCompanionSessionStateSchema,
  type OzonCompanionImport,
  type OzonCompanionSession
} from "../shared/companion.js";
import type { Repository } from "./repository.js";
import { productKey } from "./repository.js";
import { validateRun } from "./qa.js";
import { analyzeProductIdentity } from "./utils/product-name.js";
import { titleProductEvidence } from "./utils/product-evidence.js";
import { matchesBrand, normalizeText } from "./utils/normalize.js";

const OZON_DOMAIN = "ozon.ru";
const SESSION_TTL_MS = 30 * 60 * 1000;
const CAPTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ELIGIBLE_FAILURE = /^(?:blocked|quota_exceeded)\s*:/i;
const companionQueues = new Map<string, Promise<void>>();

type CompanionClock = { now?: () => Date };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function secureHashEqual(left: string, right: string): boolean {
  const first = Buffer.from(left, "hex");
  const second = Buffer.from(right, "hex");
  return first.length === second.length && timingSafeEqual(first, second);
}

function assertOwner(run: RunState, ownerEmail: string): void {
  if (run.ownerEmail && run.ownerEmail !== ownerEmail) {
    throw new Error("Этот запуск принадлежит другому сотруднику");
  }
}

function assertImportableRun(run: RunState): void {
  if (!["review", "failed"].includes(run.status)) {
    throw new Error(`Локальный сбор Ozon недоступен для запуска в статусе ${run.status}`);
  }
  if (!run.request.domains.includes(OZON_DOMAIN)) {
    throw new Error("В этом запуске Ozon не запрашивался");
  }
}

export function eligibleOzonCompanionBrands(run: RunState): string[] {
  if (!["review", "failed"].includes(run.status)) return [];
  return run.request.brands.filter((brand) => run.partitions.some((partition) =>
    partition.domain === OZON_DOMAIN &&
    normalizeText(partition.brand) === normalizeText(brand) &&
    !["complete", "no_results"].includes(partition.status) &&
    ELIGIBLE_FAILURE.test(partition.message?.trim() ?? "")
  ));
}

async function requireRun(repository: Repository, runId: string): Promise<RunState> {
  const run = await repository.getRun(runId);
  if (!run) throw new Error("Запуск не найден");
  return run;
}

async function withCompanionLease<T>(repository: Repository, runId: string, operation: () => Promise<T>): Promise<T> {
  const scope = `companion:ozon:${runId}`;
  const previous = companionQueues.get(scope) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const gate = new Promise<void>((resolve) => { releaseLocal = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  companionQueues.set(scope, tail);
  await previous.catch(() => undefined);
  let lease: { token: string; keys: string[] } | undefined;
  try {
    if (repository.acquireLease && repository.releaseLease) {
      lease = await repository.acquireLease(scope, 60_000);
    }
    return await operation();
  } finally {
    if (lease && repository.releaseLease) await repository.releaseLease(lease).catch(() => undefined);
    releaseLocal();
    if (companionQueues.get(scope) === tail) companionQueues.delete(scope);
  }
}

async function issueOzonCompanionSessionExclusive(
  repository: Repository,
  runId: string,
  ownerEmail: string,
  options: CompanionClock = {}
): Promise<OzonCompanionSession> {
  const run = await requireRun(repository, runId);
  assertOwner(run, ownerEmail);
  assertImportableRun(run);
  const eligibleBrands = eligibleOzonCompanionBrands(run);
  if (eligibleBrands.length === 0) {
    throw new Error("Локальный Chrome доступен только после подтверждённой блокировки или исчерпания облачного лимита Ozon");
  }
  const now = options.now?.() ?? new Date();
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  run.companionSessions = {
    ...run.companionSessions,
    ozon: {
      nonceHash: sha256(nonce),
      issuedAt: now.toISOString(),
      expiresAt,
      eligibleBrands
    }
  };
  run.updatedAt = now.toISOString();
  await repository.saveRun(run);
  return { version: 1, nonce, expiresAt, brands: eligibleBrands };
}

export function issueOzonCompanionSession(
  repository: Repository,
  runId: string,
  ownerEmail: string,
  options: CompanionClock = {}
): Promise<OzonCompanionSession> {
  return withCompanionLease(repository, runId, () =>
    issueOzonCompanionSessionExclusive(repository, runId, ownerEmail, options)
  );
}

function assertCanonicalOzonUrl(value: string, listingId: string): void {
  const url = new URL(value);
  const suffix = url.pathname.match(/(?:-|\/)(\d{5,20})\/?$/)?.[1];
  if (suffix !== listingId || url.search || url.hash) {
    throw new Error(`Ozon:${listingId}: ссылка не соответствует SKU`);
  }
}

function validatePayload(
  input: OzonCompanionImport,
  eligibleBrands: readonly string[],
  issuedAt: number,
  now: number
): Map<string, Observation[]> {
  const requestedByKey = new Map(eligibleBrands.map((brand) => [normalizeText(brand), brand]));
  const partitionsByKey = new Map<string, OzonCompanionImport["partitions"][number]>();
  for (const partition of input.partitions) {
    const key = normalizeText(partition.brand);
    if (!requestedByKey.has(key)) throw new Error(`Ozon / ${partition.brand}: бренд отсутствует в локальной сессии`);
    if (partitionsByKey.has(key)) throw new Error(`Ozon / ${partition.brand}: раздел продублирован`);
    partitionsByKey.set(key, partition);
  }
  if (partitionsByKey.size !== requestedByKey.size || [...requestedByKey].some(([key]) => !partitionsByKey.has(key))) {
    throw new Error("Локальный результат должен содержать итог по каждому запрошенному бренду Ozon");
  }

  const observationsByBrand = new Map<string, Observation[]>();
  const seenIds = new Set<string>();
  for (const item of input.observations) {
    const key = normalizeText(item.brand);
    const canonicalBrand = requestedByKey.get(key);
    if (!canonicalBrand) throw new Error(`Ozon / ${item.brand}: бренд отсутствует в локальной сессии`);
    if (seenIds.has(item.listingId)) throw new Error(`ozon.ru:${item.listingId}: SKU продублирован`);
    seenIds.add(item.listingId);
    assertCanonicalOzonUrl(item.canonicalUrl, item.listingId);
    if (!matchesBrand(item.product, canonicalBrand)) {
      throw new Error(`ozon.ru:${item.listingId}: название не подтверждает бренд ${canonicalBrand}`);
    }
    const captured = Date.parse(item.capturedAt);
    if (!Number.isFinite(captured) || captured < issuedAt - CAPTURE_CLOCK_SKEW_MS || captured > now + CAPTURE_CLOCK_SKEW_MS) {
      throw new Error(`ozon.ru:${item.listingId}: данные собраны вне текущей локальной сессии`);
    }
    if (item.status === "ok" && (item.reviews === null || item.reviews <= 0 || item.rating === null || item.rating <= 0)) {
      throw new Error(`ozon.ru:${item.listingId}: неполные метрики успешной карточки`);
    }
    if (item.status === "no_reviews" && (item.reviews !== 0 || item.rating !== null)) {
      throw new Error(`ozon.ru:${item.listingId}: карточка без отзывов должна иметь 0 и пустой рейтинг`);
    }
    const productEvidence = titleProductEvidence(
      item.product,
      { type: "sku", value: item.listingId },
      item.canonicalUrl
    );
    const productIdentity = analyzeProductIdentity({
      brand: canonicalBrand,
      product: item.product,
      url: item.canonicalUrl,
      evidence: productEvidence
    });
    const status = item.status !== "needs_review" && productIdentity.granularity === "variant"
      ? item.status
      : "needs_review";
    const observation: Observation = {
      domain: OZON_DOMAIN,
      platform: "ozon",
      listingId: item.listingId,
      brand: canonicalBrand,
      canonicalUrl: item.canonicalUrl,
      product: item.product,
      reviews: item.reviews,
      rating: item.rating,
      ...(item.rating === null ? {} : { rawRating: item.rating, rawRatingScale: 5 }),
      status,
      capturedAt: item.capturedAt,
      source: "ozon:composer-api:local-companion",
      productEvidence,
      productIdentity
    };
    const values = observationsByBrand.get(key) ?? [];
    values.push(observation);
    observationsByBrand.set(key, values);
  }

  for (const [key, brand] of requestedByKey) {
    const partition = partitionsByKey.get(key)!;
    const count = observationsByBrand.get(key)?.length ?? 0;
    if (partition.status === "no_results" && (partition.discovered !== 0 || partition.collected !== 0 || count !== 0)) {
      throw new Error(`Ozon / ${brand}: некорректный no_results`);
    }
    if (partition.status === "complete" && (
      partition.discovered === 0 || partition.discovered !== partition.collected || partition.collected !== count
    )) {
      throw new Error(`Ozon / ${brand}: число карточек не совпадает с итогом локального сбора`);
    }
  }
  return observationsByBrand;
}

async function importOzonCompanionResultExclusive(
  repository: Repository,
  runId: string,
  ownerEmail: string,
  candidate: unknown,
  options: CompanionClock = {}
): Promise<RunState> {
  const input = ozonCompanionImportSchema.parse(candidate);
  const run = await requireRun(repository, runId);
  assertOwner(run, ownerEmail);
  assertImportableRun(run);
  const session = ozonCompanionSessionStateSchema.parse(run.companionSessions?.ozon);
  const payloadHash = stableHash({ version: input.version, observations: input.observations, partitions: input.partitions });
  const suppliedNonceHash = sha256(input.nonce);
  if (!secureHashEqual(session.nonceHash, suppliedNonceHash)) throw new Error("Локальная сессия Ozon недействительна");
  if (session.usedAt) {
    if (session.payloadHash === payloadHash) return run;
    throw new Error("Локальная сессия Ozon уже использована с другим результатом");
  }
  const now = options.now?.() ?? new Date();
  if (Date.parse(session.expiresAt) < now.getTime()) throw new Error("Локальная сессия Ozon истекла — запустите сбор ещё раз");
  const currentEligible = eligibleOzonCompanionBrands(run);
  if (
    currentEligible.length !== session.eligibleBrands.length ||
    currentEligible.some((brand, index) => normalizeText(brand) !== normalizeText(session.eligibleBrands[index] ?? ""))
  ) {
    throw new Error("Состояние запуска изменилось — начните локальный сбор Ozon заново");
  }
  const observationsByBrand = validatePayload(
    input,
    session.eligibleBrands,
    Date.parse(session.issuedAt),
    now.getTime()
  );
  const eligibleKeys = new Set(session.eligibleBrands.map(normalizeText));
  const imported = [...observationsByBrand.values()].flat();
  const preserved = run.observations.filter((item) =>
    item.domain !== OZON_DOMAIN || !eligibleKeys.has(normalizeText(item.brand))
  );
  const seen = new Set(preserved.map((item) => productKey(item.domain, item.listingId)));
  for (const item of imported) {
    const key = productKey(item.domain, item.listingId);
    if (seen.has(key)) throw new Error(`${key}: SKU уже присутствует в другом разделе запуска`);
    seen.add(key);
  }
  const partitionsByBrand = new Map(input.partitions.map((item) => [normalizeText(item.brand), item]));
  run.partitions = run.partitions.map((partition) => {
    if (partition.domain !== OZON_DOMAIN || !eligibleKeys.has(normalizeText(partition.brand))) return partition;
    const importedPartition = partitionsByBrand.get(normalizeText(partition.brand))!;
    return {
      domain: OZON_DOMAIN,
      brand: partition.brand,
      status: importedPartition.status,
      discovered: importedPartition.discovered,
      collected: importedPartition.collected,
      message: importedPartition.status === "no_results"
        ? "Локальный Chrome исчерпал поиск Ozon: карточек нет"
        : "Собрано через локальный Chrome сотрудника"
    };
  });
  run.observations = [...preserved, ...imported].sort((left, right) =>
    run.request.domains.indexOf(left.domain) - run.request.domains.indexOf(right.domain) ||
    run.request.brands.indexOf(left.brand) - run.request.brands.indexOf(right.brand) ||
    left.product.localeCompare(right.product, "ru") || left.listingId.localeCompare(right.listingId)
  );
  run.errors = run.errors.filter((error) => {
    const match = error.partition.match(/^ozon\.ru\/(.+)$/i);
    return !match || !eligibleKeys.has(normalizeText(match[1] ?? ""));
  });
  run.status = "review";
  run.progress.completedPartitions = run.partitions.length;
  delete run.progress.current;
  run.publication = undefined;
  run.updatedAt = now.toISOString();
  run.companionSessions = {
    ...run.companionSessions,
    ozon: { ...session, usedAt: now.toISOString(), payloadHash }
  };
  run.qa = validateRun(run);
  run.payloadHash = stableHash({ request: run.request, observations: run.observations });
  await repository.saveRun(run);
  return run;
}

export function importOzonCompanionResult(
  repository: Repository,
  runId: string,
  ownerEmail: string,
  candidate: unknown,
  options: CompanionClock = {}
): Promise<RunState> {
  return withCompanionLease(repository, runId, () =>
    importOzonCompanionResultExclusive(repository, runId, ownerEmail, candidate, options)
  );
}
