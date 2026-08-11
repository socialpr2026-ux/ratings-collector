import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterActivityEvent,
  Observation,
  ProductRecord,
  ProductIdentity,
  ProductRef,
  RunHistoryItem,
  RunRequest,
  RunState,
  SourceCardRecord,
  SiteAdapter,
  SiteProfile
} from "../shared/types.js";
import { observationSchema, productRefSchema, runRequestSchema } from "../shared/types.js";
import { hasDeterministicAggregateProof, isKnownReviewAggregateDomain } from "../shared/review-aggregates.js";
import type { EvidenceStore } from "./evidence.js";
import { GenericSiteAdapter } from "./generic/adapter.js";
import { profileSite } from "./generic/profiler.js";
import { validateRun } from "./qa.js";
import { productKey, type Repository } from "./repository.js";
import { observationsForPublication } from "./publication-scope.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./adapters/errors.js";
import { safeErrorMessage } from "./utils/error-message.js";
import { matchesBrand, normalizeText } from "./utils/normalize.js";
import { assertSafePublicUrl, extractSpreadsheetId } from "./utils/urls.js";
import { analyzeProductIdentity } from "./utils/product-name.js";
import { titleProductEvidence } from "./utils/product-evidence.js";
import { normalizeObservationFeedback } from "./feedback-count.js";
import { RunActivityTracker, runtimeSignals } from "./runtime-activity.js";
import { normalizeProductOverride, resolveProductOverride } from "./utils/product-override.js";
import { compactProductCatalogEvidence, reconcileProductCatalog } from "./utils/product-catalog.js";

const RUN_SOFT_DEADLINE_MS = 26 * 60 * 1000;
export const DEFAULT_DOMAIN_CONCURRENCY = 12;
export const DEFAULT_ACTIVITY_CHECKPOINT_INTERVAL_MS = 5_000;

export type AdapterResolver = (domain: string, request: RunRequest) => Promise<SiteAdapter>;
export type DomainExclusive = <T>(domain: string, operation: () => Promise<T>) => Promise<T>;
export type RatingsServiceOptions = {
  runDeadlineMs?: number;
  domainExclusive?: DomainExclusive;
  domainConcurrency?: number;
  activityCheckpointIntervalMs?: number;
};

function domainOnly(input: string): string {
  const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = assertSafePublicUrl(candidate);
  if (url.protocol !== "https:") throw new Error("Разрешены только HTTPS-площадки");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`Укажите домен без пути: ${input}`);
  const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  // Yandex Reviews is the collection origin, while the stable public contract
  // and row identity use the marketplace domain.
  return hostname === "reviews.yandex.ru" ? "market.yandex.ru" : hostname;
}

function resolveYandexFamilyOverride(item: Observation, value: string): ProductIdentity | undefined {
  const label = normalizeProductOverride(value);
  if (
    item.domain !== "market.yandex.ru" ||
    normalizeText(label) !== normalizeText(item.brand) ||
    item.productEvidence?.scope !== "listing" ||
    !/^yandex_reviews_/i.test(item.source ?? "") ||
    !item.productEvidence.identifiers.some((identifier) =>
      identifier.type === "model_id" && identifier.value === item.listingId
    )
  ) return undefined;
  let url: URL;
  try { url = new URL(item.canonicalUrl); }
  catch { return undefined; }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "reviews.yandex.ru" ||
    !(
      url.pathname === `/product/${item.listingId}` ||
      url.pathname.startsWith("/product/") && url.pathname.endsWith(`--${item.listingId}`)
    )
  ) return undefined;
  return {
    label: item.brand,
    granularity: "family",
    confidence: "exact",
    missing: [],
    reasons: ["Точная семейная карточка Yandex подтверждена оператором"]
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueBrands(brands: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const brand of brands) {
    const key = normalizeText(brand);
    if (!key) throw new Error(`Некорректное название бренда: ${brand}`);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(brand.trim());
  }
  return result;
}

function validateDiscoveredRefs(candidates: readonly unknown[], domain: string, brand: string): ProductRef[] {
  const result = new Map<string, ProductRef>();
  for (const candidate of candidates) {
    const parsed = productRefSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ParserChangedError(`${domain}: поиск вернул некорректную ссылку карточки`);
    }
    const ref = parsed.data;
    if (ref.domain !== domain || normalizeText(ref.brand) !== normalizeText(brand)) {
      throw new ParserChangedError(`${domain}: поиск вернул карточку из другого раздела`);
    }
    const key = productKey(ref.domain, ref.listingId);
    if (!result.has(key)) result.set(key, ref);
  }
  return [...result.values()];
}

function validateCollectedObservation(candidate: unknown, ref: ProductRef, domain: string, brand: string): Observation {
  const parsed = observationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ParserChangedError(`${domain}:${ref.listingId}: сборщик вернул данные вне контракта`);
  }
  const observation = parsed.data;
  if (
    observation.domain !== domain ||
    observation.listingId !== ref.listingId ||
    normalizeText(observation.brand) !== normalizeText(brand)
  ) {
    throw new ParserChangedError(`${domain}:${ref.listingId}: сборщик вернул другую карточку или бренд`);
  }
  return observation;
}

function earlierMonth(left: string | undefined, right: string): string {
  return left && left < right ? left : right;
}

function laterMonth(left: string | undefined, right: string): string {
  return left && left > right ? left : right;
}

function errorStatus(error: unknown): "blocked" | "quota_exceeded" | "parser_changed" | "error" {
  if (error instanceof AdapterBlockedError) return "blocked";
  if (error instanceof AdapterQuotaError) return "quota_exceeded";
  if (error instanceof ParserChangedError) return "parser_changed";
  return "error";
}

type PartialDiscoveryFailure = {
  status: "blocked" | "quota_exceeded" | "parser_changed";
  message: string;
  total: number;
};

function partialDiscoveryFailure(refs: readonly ProductRef[]): PartialDiscoveryFailure | undefined {
  const marked = refs.filter((ref) => ref.metadata.partialDiscoveryStatus !== undefined);
  if (marked.length === 0) return undefined;
  if (marked.length !== refs.length) {
    throw new ParserChangedError("Сборщик смешал полную и частичную выдачу карточек");
  }
  const first = marked[0]!.metadata;
  const status = first.partialDiscoveryStatus;
  const message = first.partialDiscoveryMessage;
  const total = first.partialDiscoveryTotal;
  if (
    !["blocked", "quota_exceeded", "parser_changed"].includes(String(status)) ||
    typeof message !== "string" || !message.trim() ||
    !Number.isSafeInteger(total) || Number(total) < refs.length
  ) {
    throw new ParserChangedError("Сборщик вернул некорректный признак частичной выдачи");
  }
  if (marked.some((ref) =>
    ref.metadata.partialDiscoveryStatus !== status ||
    ref.metadata.partialDiscoveryMessage !== message ||
    ref.metadata.partialDiscoveryTotal !== total
  )) {
    throw new ParserChangedError("Сборщик вернул противоречивые причины частичной выдачи");
  }
  return { status: status as PartialDiscoveryFailure["status"], message, total: Number(total) };
}

function healthCheckFailure(message: string): AdapterBlockedError | AdapterQuotaError | ParserChangedError {
  // Merely mentioning Apify does not make a non-Apify adapter quota-bound
  // (for example: "Apify не используется"). Only an explicit quota/limit
  // signal is allowed to become quota_exceeded.
  if (
    /quota[_\s-]*exceeded|квот|лимит[^.]{0,80}(?:исчерпан|превышен)|limit\s*exceeded|sandbox[^.]{0,80}limit/i.test(message) ||
    /apify[^.]{0,120}(?:quota|квот|лимит|cost\s*(?:cap|limit)|budget)/i.test(message)
  ) {
    return new AdapterQuotaError(message);
  }
  if (
    /^\s*blocked\s*:|blocked[_\s-]*free[_\s-]*mode|captcha|капч|\bpow\b|заблокирован|блокирует|access\s*denied|forbidden|HTTP\s+(?:401|403|408|425|429|498|499|5\d\d)\b/i.test(message)
  ) {
    return new AdapterBlockedError(message);
  }
  return new ParserChangedError(message);
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    }
  );
  const settled = await Promise.allSettled(runners);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

function brandConcurrency(domain: string): number {
  // WB keeps its own low-rate request queue. Ozon and Yandex can both fall back
  // to a shared Google Translate route, so their brands stay serialized. A
  // generated SiteProfile also carries one domain-wide rate limit.
  return domain === "wildberries.ru" ? 4 : 1;
}

const SUCCESSFUL_PARTITION_STATUSES = new Set(["complete", "no_results"]);
const PUBLISHED_IDENTITY_REUSE_REASON =
  "Точное определение переиспользовано из опубликованной карточки с теми же ID, URL, брендом и названием";
const GENERIC_AGGREGATE_TITLE_TOKENS = new Set([
  "отзыв", "отзывы", "рейтинг", "оценка", "оценки", "препарат", "лекарство", "средство", "продукт", "бренд"
]);

function partitionKey(domain: string, brand: string): string {
  return `${domain}\u0000${brand}`;
}

function collapsesDistinctProductPages(
  identity: Observation["productIdentity"],
  evidence: Observation["productEvidence"],
  discoveredCount: number,
  brand: string,
  product: string
): boolean {
  if (discoveredCount <= 1 || !identity || !["family", "line"].includes(identity.granularity)) return false;
  if (identity.confidence === "exact" || (identity.variantCount ?? 0) > 1) return false;
  if (evidence?.scope !== "product_family" || (evidence.variants?.length ?? 0) > 0) return false;
  const brandTokens = new Set(normalizeText(brand).split(" ").filter(Boolean));
  const specificTokens = normalizeText(product).split(" ").filter((token) =>
    token && !brandTokens.has(token) && !GENERIC_AGGREGATE_TITLE_TOKENS.has(token)
  );
  return specificTokens.length > 0;
}

function canAutoAcceptDedicatedReviewAggregate(observation: Observation): boolean {
  const identity = observation.productIdentity;
  const sourceBoundDedicated = observation.profileVersion === undefined &&
    observation.historical !== true &&
    observation.productOverride === undefined &&
    Boolean(identity && ["family", "line"].includes(identity.granularity) && identity.confidence !== "ambiguous") &&
    matchesBrand(observation.product, observation.brand) &&
    hasDeterministicAggregateProof(observation);
  if (!sourceBoundDedicated) return false;
  // A Yandex Reviews model is already source-bound by its stable model_id.
  // Other review sites need explicit family-page evidence; a listing/profile
  // result is never enough for automatic publication.
  return observation.domain === "market.yandex.ru" || observation.domain === "reviews.yandex.ru" ||
    observation.productEvidence?.scope === "product_family";
}

function reusablePublishedProductIdentity(
  observation: Observation,
  analyzed: NonNullable<Observation["productIdentity"]>,
  previous: ProductRecord | undefined
): NonNullable<Observation["productIdentity"]> | undefined {
  const identity = previous?.productIdentity;
  if (!previous || !identity) return undefined;
  // A published decision may fill in details omitted by the same stable card,
  // but it must never overrule fresh contradictory or incomplete collection.
  if (!(["ok", "no_reviews"] as Observation["status"][]).includes(observation.status)) return undefined;
  if (analyzed.granularity !== "unresolved" || analyzed.confidence !== "partial") return undefined;
  if (identity.granularity !== "variant" || identity.confidence !== "exact") return undefined;
  if (previous.domain !== observation.domain || previous.listingId !== observation.listingId) return undefined;
  if (normalizeText(previous.brand) !== normalizeText(observation.brand)) return undefined;
  if (previous.canonicalUrl !== observation.canonicalUrl) return undefined;
  if (normalizeText(previous.product) !== normalizeText(observation.product)) return undefined;
  return {
    ...structuredClone(identity),
    reasons: [...new Set([...identity.reasons, PUBLISHED_IDENTITY_REUSE_REASON])]
  };
}

export class RatingsService {
  private active = new Set<string>();
  private readonly runDeadlineMs: number;
  private readonly domainExclusive: DomainExclusive;
  private readonly domainConcurrency: number;
  private readonly activityCheckpointIntervalMs: number;

  constructor(
    private readonly repository: Repository,
    private readonly resolveAdapter: AdapterResolver,
    options: RatingsServiceOptions = {}
  ) {
    this.runDeadlineMs = options.runDeadlineMs ?? RUN_SOFT_DEADLINE_MS;
    this.domainExclusive = options.domainExclusive ?? ((_domain, operation) => operation());
    this.domainConcurrency = options.domainConcurrency ?? DEFAULT_DOMAIN_CONCURRENCY;
    this.activityCheckpointIntervalMs = options.activityCheckpointIntervalMs ?? DEFAULT_ACTIVITY_CHECKPOINT_INTERVAL_MS;
    if (!Number.isFinite(this.runDeadlineMs) || this.runDeadlineMs < 1) {
      throw new RangeError("runDeadlineMs must be a positive finite number");
    }
    if (!Number.isSafeInteger(this.domainConcurrency) || this.domainConcurrency < 1) {
      throw new RangeError("domainConcurrency must be a positive integer");
    }
    if (!Number.isFinite(this.activityCheckpointIntervalMs) || this.activityCheckpointIntervalMs < 0) {
      throw new RangeError("activityCheckpointIntervalMs must be a non-negative finite number");
    }
  }

  async createRun(input: unknown, ownerEmail?: string): Promise<RunState> {
    const request = runRequestSchema.parse(input);
    extractSpreadsheetId(request.sheetUrl);
    request.domains = [...new Set(request.domains.map(domainOnly))];
    request.brands = uniqueBrands(request.brands);
    const now = new Date().toISOString();
    const run: RunState = {
      id: randomUUID(), request, status: "queued", createdAt: now, updatedAt: now,
      progress: { totalPartitions: request.domains.length * request.brands.length, completedPartitions: 0 },
      observations: [], partitions: [], errors: [], ownerEmail
    };
    await this.repository.saveRun(run);
    return run;
  }

  async getRun(id: string): Promise<RunState | undefined> { return this.repository.getRun(id); }

  /**
   * Converts a worker-level persistence interruption into an ordinary partial
   * result. It also finishes the narrow terminal checkpoint where the worker
   * durably saved every partition but was interrupted before writing its
   * review/QA state. Successful checkpoints stay intact; every request
   * partition that never reached durable storage becomes an explicit blocked
   * partition. This keeps completed-only publication and failed-only retry
   * available without treating an access failure as a zero.
   */
  async reconcileInterruptedRun(run: RunState): Promise<RunState> {
    const orchestratorErrors = run.errors.filter((error) => error.partition === "orchestrator");
    const expectedPartitions = run.request.domains.flatMap((domain) =>
      run.request.brands.map((brand) => ({ domain, brand, key: partitionKey(domain, brand) }))
    );
    const terminalCheckpoint = run.status === "running" &&
      run.partitions.length === expectedPartitions.length &&
      (run.activity?.active.length ?? 0) === 0;
    if ((run.status !== "failed" || orchestratorErrors.length === 0) && !terminalCheckpoint) return run;

    const existing = new Set(run.partitions.map((partition) => partitionKey(partition.domain, partition.brand)));
    const missing = expectedPartitions.filter(({ key }) => !existing.has(key));
    const interruption = orchestratorErrors.map((error) => error.message).join("; ");
    const recoveredAt = new Date().toISOString();

    new RunActivityTracker(run, () => recoveredAt);
    if (orchestratorErrors.length) run.errors = run.errors.filter((error) => error.partition !== "orchestrator");
    for (const { domain, brand } of missing) {
      const message = `Сбор прерван до сохранения результата: ${interruption}`;
      run.partitions.push({ domain, brand, status: "blocked", discovered: 0, collected: 0, message });
      run.errors.push({ partition: `${domain}/${brand}`, message });
    }
    run.partitions.sort((left, right) =>
      run.request.domains.indexOf(left.domain) - run.request.domains.indexOf(right.domain) ||
      run.request.brands.indexOf(left.brand) - run.request.brands.indexOf(right.brand)
    );
    run.observations.sort((left, right) =>
      run.request.domains.indexOf(left.domain) - run.request.domains.indexOf(right.domain) ||
      run.request.brands.indexOf(left.brand) - run.request.brands.indexOf(right.brand) ||
      left.product.localeCompare(right.product, "ru") || left.listingId.localeCompare(right.listingId)
    );
    run.progress.totalPartitions = expectedPartitions.length;
    run.progress.completedPartitions = run.partitions.length;
    delete run.progress.current;
    await this.refreshDraftProfileExamples(run);
    run.payloadHash = stableHash({ request: run.request, observations: run.observations });
    run.status = "review";
    run.collectionFinishedAt ??= recoveredAt;
    run.updatedAt = recoveredAt;
    run.qa = validateRun(run);
    await this.repository.saveRun(run);
    return run;
  }

  async listRecentRuns(ownerEmail?: string, limit = 8): Promise<RunHistoryItem[]> {
    return this.repository.listRecentRuns(ownerEmail, limit);
  }

  async executeRun(id: string): Promise<RunState> {
    if (this.active.has(id)) throw new Error("Запуск уже выполняется");
    this.active.add(id);
    try {
      return await this.executeRunExclusive(id);
    } finally {
      this.active.delete(id);
    }
  }

  private async executeRunExclusive(id: string): Promise<RunState> {
    const run = await this.requireRun(id);
    if (!['queued', 'failed', 'review'].includes(run.status)) throw new Error(`Нельзя запустить из статуса ${run.status}`);
    const expectedPartitions = run.request.domains.flatMap((domain) =>
      run.request.brands.map((brand) => ({ domain, brand, key: partitionKey(domain, brand) }))
    );
    const previousPartitions = new Map(run.partitions.map((partition) => [
      partitionKey(partition.domain, partition.brand),
      partition
    ]));
    const isRetry = run.status !== "queued" && run.partitions.length > 0;
    if (isRetry) run.publicationExclusions = undefined;
    const reviewPartitions = new Set(run.observations
      .filter((observation) => observation.status === "needs_review")
      .map((observation) => partitionKey(observation.domain, observation.brand)));
    const retryTargets = isRetry
      ? expectedPartitions.filter(({ key }) =>
        !SUCCESSFUL_PARTITION_STATUSES.has(previousPartitions.get(key)?.status ?? "") || reviewPartitions.has(key)
      )
      : expectedPartitions;

    // A repeated Agent request after every partition succeeded is a true
    // idempotent no-op. The caller may have lost the first HTTP response after
    // the completed run had already been persisted.
    if (isRetry && retryTargets.length === 0) {
      if (run.status !== "failed" || !run.errors.some((error) => error.partition === "orchestrator")) return run;
      // A worker can finish and checkpoint every partition, then fail while
      // calculating QA or persisting the final response. In that case there
      // is nothing to recollect: rebuild the deterministic review state from
      // the checkpoint instead of leaving the user with an unrecoverable run.
      run.errors = run.errors.filter((error) => error.partition !== "orchestrator");
      run.partitions.sort((a, b) =>
        run.request.domains.indexOf(a.domain) - run.request.domains.indexOf(b.domain) ||
        run.request.brands.indexOf(a.brand) - run.request.brands.indexOf(b.brand)
      );
      run.observations.sort((a, b) =>
        run.request.domains.indexOf(a.domain) - run.request.domains.indexOf(b.domain) ||
        run.request.brands.indexOf(a.brand) - run.request.brands.indexOf(b.brand) ||
        a.product.localeCompare(b.product, "ru") || a.listingId.localeCompare(b.listingId)
      );
      delete run.progress.current;
      await this.refreshDraftProfileExamples(run);
      run.payloadHash = stableHash({ request: run.request, observations: run.observations });
      run.status = "review";
      run.collectionFinishedAt ??= new Date().toISOString();
      run.qa = validateRun(run);
      await this.touch(run);
      return run;
    }

    const retryErrorPartitions = new Set(retryTargets.map(({ domain, brand }) => `${domain}/${brand}`));
    const retryTargetKeys = new Set(retryTargets.map(({ key }) => key));
    const preservedPartitions = isRetry
      ? expectedPartitions.flatMap(({ key }) => {
        const previous = previousPartitions.get(key);
        return previous && SUCCESSFUL_PARTITION_STATUSES.has(previous.status) && !retryTargetKeys.has(key) ? [previous] : [];
      })
      : [];
    run.status = "running";
    run.errors = isRetry
      ? run.errors.filter((error) => !retryErrorPartitions.has(error.partition) && error.partition !== "orchestrator")
      : [];
    if (!isRetry) run.observations = [];
    run.partitions = preservedPartitions;
    run.qa = undefined;
    run.payloadHash = undefined;
    run.publication = undefined;
    run.progress.totalPartitions = expectedPartitions.length;
    run.progress.completedPartitions = preservedPartitions.length;
    delete run.progress.current;
    run.collectionStartedAt ??= new Date().toISOString();
    run.collectionFinishedAt = undefined;
    const activity = new RunActivityTracker(run);
    activity.instant({
      stage: "prepare",
      label: "Подготовка запуска",
      detail: `${retryTargets.length} разделов в очереди`
    });
    await this.touch(run);
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(new Error("run_deadline_exceeded")),
      this.runDeadlineMs
    );
    // Keep the deadline referenced for the lifetime of the collection. Some
    // edge transports do not themselves keep Node's event loop referenced;
    // unref() allowed a stalled upstream request to outlive this guard.
    try {
      const spreadsheetId = extractSpreadsheetId(run.request.sheetUrl);
      const [products, sourceCards] = await Promise.all([
        this.repository.listProducts(spreadsheetId),
        this.repository.listSourceCards(spreadsheetId)
      ]);
      const requestedBrandKeys = new Set(run.request.brands.map(normalizeText));
      const catalogProducts = products.filter((product) => requestedBrandKeys.has(normalizeText(product.brand)));
      const productsByKey = new Map(products.map((product) => [product.key, product]));
      const seen = new Map(run.observations.map((observation) => [
        productKey(observation.domain, observation.listingId),
        observation
      ]));
      let progressWrites = Promise.resolve();
      let lastActivityWrite = 0;
      let firstNestedActivityPersisted = false;
      const saveProgress = async () => {
        // Persist observations together with their completed partition. This
        // makes a checkpoint self-contained if the Agent is interrupted before
        // the final sorting/QA pass and lets retry safely skip successful work.
        run.observations = [...seen.values()];
        run.updatedAt = new Date().toISOString();
        const snapshot = structuredClone(run);
        progressWrites = progressWrites.then(() => this.repository.saveRun(snapshot));
        await progressWrites;
      };
      const saveActivityProgress = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastActivityWrite < this.activityCheckpointIntervalMs) return;
        lastActivityWrite = now;
        await saveProgress();
      };
      const createAdapterActivityReporter = (base: { domain: string; brand?: string }) => {
        const activeOperations = new Map<string, string>();
        return {
          report: async (event: AdapterActivityEvent) => {
            const input = {
              stage: event.stage,
              label: event.label,
              domain: base.domain,
              brand: base.brand,
              listingId: event.listingId,
              channels: event.channels,
              parsers: event.parsers,
              detail: event.detail
            } as const;
            const existing = activeOperations.get(event.operationId);
            if (event.status === "active") {
              if (existing) {
                activity.progress(existing, {
                  channels: event.channels,
                  parsers: event.parsers,
                  detail: event.detail
                });
              } else {
                const id = activity.start(input);
                activeOperations.set(event.operationId, id);
              }
              // Persist the first active nested operation immediately. Parallel
              // product checks then share the same snapshot without flooding
              // the repository with one write per request.
              const force = !firstNestedActivityPersisted;
              firstNestedActivityPersisted = true;
              await saveActivityProgress(force);
              return;
            }
            if (existing) {
              activity.finish(existing, event.status, {
                channels: event.channels,
                parsers: event.parsers,
                detail: event.detail
              });
              activeOperations.delete(event.operationId);
            } else {
              activity.instant(input, event.status);
            }
            await saveActivityProgress();
          },
          warnActive: (message: string) => {
            for (const id of activeOperations.values()) activity.warn(id, { detail: message });
            activeOperations.clear();
          }
        };
      };
      const retryBrandsByDomain = new Map<string, string[]>();
      for (const { domain, brand } of retryTargets) {
        const brands = retryBrandsByDomain.get(domain) ?? [];
        brands.push(brand);
        retryBrandsByDomain.set(domain, brands);
      }
      await forEachWithConcurrency(
        run.request.domains.filter((domain) => retryBrandsByDomain.has(domain)),
        this.domainConcurrency,
        async (domain) => {
        const retryBrands = retryBrandsByDomain.get(domain)!;
        const retryBrandKeys = new Set(retryBrands.map(normalizeText));
        let domainStarted = false;
        const executeDomain = async () => {
        domainStarted = true;
        const previousDomainRecords = [
          ...sourceCards.filter((item) => item.domain === domain && retryBrandKeys.has(normalizeText(item.brand)))
            .map((item) => ({ listingId: item.listingId, url: item.canonicalUrl })),
          ...products.filter((item) => item.domain === domain && retryBrandKeys.has(normalizeText(item.brand)))
            .map((item) => ({ listingId: item.listingId, url: item.canonicalUrl, title: item.product }))
        ];
        const previousDomainRefs = [...new Map(previousDomainRecords.map((item) => [item.listingId, item])).values()];
        let adapter: SiteAdapter;
        const healthReporter = createAdapterActivityReporter({ domain });
        const healthActivity = activity.start({
          stage: "health_check",
          label: "Проверка канала сбора",
          domain
        });
        await saveActivityProgress();
        try {
          deadline.signal.throwIfAborted();
          adapter = await this.resolveAdapter(domain, run.request);
          const health = await adapter.healthCheck({
            runId: run.id,
            brands: retryBrands,
            region: run.request.region,
            month: run.request.month,
            previousIds: previousDomainRefs.map((item) => item.listingId),
            previousRefs: previousDomainRefs,
            refreshDiscovery: run.request.discoveryMode === "refresh",
            signal: deadline.signal,
            activity: healthReporter.report
          });
          deadline.signal.throwIfAborted();
          if (!health.ok) {
            const healthMessage = safeErrorMessage(health.message ?? "Canary-проверка не пройдена");
            const failure = healthCheckFailure(healthMessage);
            if (failure instanceof ParserChangedError) {
              const profile = await this.repository.getProfile(domain);
              if (profile?.status === "approved") {
                await this.repository.saveProfile({
                  ...profile,
                  status: "parser_changed",
                  updatedAt: new Date().toISOString(),
                  notes: [...profile.notes, `Canary ${new Date().toISOString()}: ${healthMessage}`]
                });
              }
            }
            throw failure;
          }
          activity.complete(healthActivity, {
            ...runtimeSignals(health.message),
            detail: health.message ?? "Контрольная проверка пройдена"
          });
        } catch (error) {
          deadline.signal.throwIfAborted();
          const kind = errorStatus(error);
          const message = safeErrorMessage(error);
          healthReporter.warnActive(message);
          activity.warn(healthActivity, {
            ...runtimeSignals(message),
            detail: message
          });
          for (const brand of retryBrands) {
            this.addPartition(
              run,
              domain,
              brand,
              kind === "error" ? "error" : "blocked",
              0,
              0,
              `${kind}: ${message}`
            );
          }
          await saveProgress();
          return;
        }
        await forEachWithConcurrency(retryBrands, brandConcurrency(domain), async (brand) => {
          run.progress.current = `${domain} / ${brand}`;
          const previousRecords = products.filter((item) =>
            item.domain === domain && normalizeText(item.brand) === normalizeText(brand)
          );
          const previousSourceCards = sourceCards.filter((item) =>
            item.domain === domain && normalizeText(item.brand) === normalizeText(brand)
          );
          const previousRefs = [...new Map([
            ...previousSourceCards.map((item) => ({ listingId: item.listingId, url: item.canonicalUrl })),
            ...previousRecords.map((item) => ({ listingId: item.listingId, url: item.canonicalUrl, title: item.product }))
          ].map((item) => [item.listingId, item])).values()];
          const previousIds = previousRefs.map((item) => item.listingId);
          const discoveryActivity = activity.start({
            stage: "discovery",
            label: "Поиск карточек",
            domain,
            brand
          });
          let activeCollection: string | undefined;
          let activeNormalization: string | undefined;
          let discoveredCount = 0;
          let viableDiscovered = 0;
          let collected = 0;
          const collectionFailures: Array<{ listingId: string; kind: ReturnType<typeof errorStatus>; message: string }> = [];
          const refreshedKeys = new Set<string>();
          const previousObservationKeys = new Set([...seen.entries()]
            .filter(([, observation]) =>
              observation.domain === domain && normalizeText(observation.brand) === normalizeText(brand)
            )
            .map(([key]) => key));
          const retainedSourceCards: SourceCardRecord[] = [];
          const adapterReporter = createAdapterActivityReporter({ domain, brand });
          // Discovery is frequently the longest operation (sitemaps, search
          // pagination and exact product proof), so always expose its start to
          // polling clients instead of leaving a stale health-check visible.
          await saveActivityProgress(true);
          try {
            deadline.signal.throwIfAborted();
            const discovered = validateDiscoveredRefs(await adapter.discover(brand, {
              runId: run.id,
              brands: retryBrands,
              region: run.request.region,
              month: run.request.month,
              previousIds,
              previousRefs,
              refreshDiscovery: run.request.discoveryMode === "refresh",
              signal: deadline.signal,
              activity: adapterReporter.report
            }), domain, brand);
            const partialFailure = partialDiscoveryFailure(discovered);
            discoveredCount = discovered.length;
            viableDiscovered = discovered.length;
            const discoverySignals = runtimeSignals(discovered.map((ref) => ref.metadata));
            activity.complete(discoveryActivity, {
              ...discoverySignals,
              detail: partialFailure
                ? `Доказано карточек: ${discovered.length} из ${partialFailure.total}`
                : discovered.length ? `Найдено карточек: ${discovered.length}` : "Поиск завершён без карточек"
            });
            if (!discovered.length) {
              for (const key of previousObservationKeys) seen.delete(key);
              this.addPartition(run, domain, brand, "no_results", 0, 0, "Поиск исчерпан, карточек нет");
              await saveProgress();
              return;
            }
            if (domain === "market.yandex.ru" && !partialFailure) {
              const discoveredAt = new Date().toISOString();
              // A complete exact Yandex discovery is expensive. Persist every
              // proven model before reading the first product so a dead Agent
              // execution can retry the cards without rescanning 330 shards.
              await this.repository.saveSourceCards(spreadsheetId, discovered.map((ref) => ({
                key: productKey(domain, ref.listingId),
                domain,
                listingId: ref.listingId,
                brand,
                canonicalUrl: ref.url,
                firstSeenAt: discoveredAt,
                lastSeenAt: discoveredAt
              })));
            }
            const previousById = new Map(previousRecords.map((item) => [item.listingId, item]));
            for (const ref of discovered) {
              deadline.signal.throwIfAborted();
              activeCollection = activity.start({
                stage: "collection",
                label: "Чтение карточки",
                domain,
                brand,
                listingId: ref.listingId
              });
              await saveActivityProgress();
              try {
              const observation = validateCollectedObservation(await adapter.collect(ref, {
                runId: run.id,
                brands: retryBrands,
                region: run.request.region,
                month: run.request.month,
                previousIds,
                previousRefs,
                refreshDiscovery: run.request.discoveryMode === "refresh",
                signal: deadline.signal,
                activity: adapterReporter.report
              }), ref, domain, brand);
              const observedSignals = runtimeSignals(ref.metadata, observation.source, observation.evidenceRef);
              activity.complete(activeCollection, {
                ...observedSignals,
                detail: "Отзывы и рейтинг извлечены"
              });
              activeCollection = undefined;
              activeNormalization = activity.start({
                stage: "normalization",
                label: "Нормализация продукта",
                domain,
                brand,
                listingId: ref.listingId,
                ...observedSignals
              });
              normalizeObservationFeedback(observation);
              if (observation.status === "not_found") {
                const historical = previousById.get(observation.listingId);
                if (historical && observation.reviews === null && observation.rating === null) {
                  observation.historical = true;
                  observation.canonicalUrl = historical.canonicalUrl;
                  observation.product = historical.product;
                  observation.productIdentity = historical.productIdentity;
                  observation.productEvidence = historical.productEvidence;
                  observation.productOverride = historical.productOverride;
                  observation.brand = historical.brand;
                } else if ([
                  "yandex_reviews_missing_candidate",
                  "otzovik_missing_candidate",
                  "review_site_missing_candidate",
                  "review_site_non_product_candidate"
                ].includes(observation.source ?? "")) {
                  // A first-party search may retain an explicitly removed
                  // candidate. Its exact missing-page proof means it is not a
                  // current card and must not enter the sheet or review queue.
                  viableDiscovered -= 1;
                  seen.delete(productKey(observation.domain, observation.listingId));
                  activity.complete(activeNormalization, { detail: "Удалённая карточка исключена" });
                  activeNormalization = undefined;
                  continue;
                } else {
                  // A 404/410 is only a valid empty monthly value for a card
                  // that was already present in this sheet's registry.
                  observation.status = "needs_review";
                  observation.historical = false;
                }
              }
              if (observation.status !== "not_found") {
                observation.productEvidence ??= titleProductEvidence(
                  observation.product,
                  {
                    type: observation.domain === "wildberries.ru" ? "nm_id" : observation.domain === "market.yandex.ru" ? "model_id" : observation.domain === "ozon.ru" ? "sku" : "product_id",
                    value: observation.listingId
                  },
                  observation.canonicalUrl
                );
                const analyzedIdentity = analyzeProductIdentity({
                  brand: observation.brand,
                  product: observation.product,
                  url: observation.canonicalUrl,
                  evidence: observation.productEvidence
                });
                observation.productIdentity = reusablePublishedProductIdentity(
                  observation,
                  analyzedIdentity,
                  productsByKey.get(productKey(observation.domain, observation.listingId))
                ) ?? analyzedIdentity;
              }
              const key = productKey(observation.domain, observation.listingId);
              const existing = seen.get(key);
              if (existing && existing.brand !== observation.brand) {
                observation.status = "needs_review";
                existing.status = "needs_review";
                run.errors.push({ partition: `${domain}/${brand}`, message: `${key} найден у двух брендов` });
              } else {
                seen.set(key, observation);
                if (!refreshedKeys.has(key)) {
                  refreshedKeys.add(key);
                  collected += 1;
                }
              }
              if (
                domain === "market.yandex.ru" &&
                ["ok", "no_reviews"].includes(observation.status) &&
                matchesBrand(observation.product, brand)
              ) {
                retainedSourceCards.push({
                  key,
                  domain: observation.domain,
                  listingId: observation.listingId,
                  brand,
                  canonicalUrl: observation.canonicalUrl,
                  firstSeenAt: observation.capturedAt,
                  lastSeenAt: observation.capturedAt
                });
              }
              activity.complete(activeNormalization, {
                detail: observation.productIdentity?.label ?? observation.product
              });
              activeNormalization = undefined;
              } catch (error) {
                deadline.signal.throwIfAborted();
                const kind = errorStatus(error);
                const message = safeErrorMessage(error);
                collectionFailures.push({ listingId: ref.listingId, kind, message });
                adapterReporter.warnActive(message);
                if (activeCollection) activity.warn(activeCollection, { ...runtimeSignals(message), detail: message });
                if (activeNormalization) activity.warn(activeNormalization, { detail: message });
                activeCollection = undefined;
                activeNormalization = undefined;
              }
            }
            if (partialFailure || collectionFailures.length > 0) {
              const failureDetails = [
                ...(partialFailure ? [`${partialFailure.status}: ${partialFailure.message}`] : []),
                ...collectionFailures.map((failure) =>
                  `${failure.listingId}: ${failure.kind}: ${failure.message}`
                )
              ];
              const message = failureDetails.join("; ");
              run.errors.push({ partition: `${domain}/${brand}`, message });
              const retainedCount = [...seen.values()].filter((observation) =>
                observation.domain === domain && normalizeText(observation.brand) === normalizeText(brand)
              ).length;
              this.addPartition(
                run,
                domain,
                brand,
                collectionFailures.some((failure) => failure.kind === "error") ? "error" : "blocked",
                partialFailure?.total ?? discoveredCount,
                retainedCount,
                message
              );
            } else {
              for (const key of previousObservationKeys) {
                if (!refreshedKeys.has(key)) seen.delete(key);
              }
              this.addPartition(
                run,
                domain,
                brand,
                viableDiscovered === 0 ? "no_results" : "complete",
                viableDiscovered,
                collected,
                viableDiscovered === 0 ? "Поиск исчерпан, живых карточек нет" : undefined
              );
            }
            if (retainedSourceCards.length > 0) {
              await this.repository.saveSourceCards(spreadsheetId, retainedSourceCards);
            }
          } catch (error) {
            deadline.signal.throwIfAborted();
            const kind = errorStatus(error);
            const message = safeErrorMessage(error);
            adapterReporter.warnActive(message);
            activity.warn(discoveryActivity, { ...runtimeSignals(message), detail: message });
            if (activeCollection) activity.warn(activeCollection, { ...runtimeSignals(message), detail: message });
            if (activeNormalization) activity.warn(activeNormalization, { detail: message });
            run.errors.push({ partition: `${domain}/${brand}`, message: `${kind}: ${message}` });
            const retainedCount = [...seen.values()].filter((observation) =>
              observation.domain === domain && normalizeText(observation.brand) === normalizeText(brand)
            ).length;
            this.addPartition(
              run,
              domain,
              brand,
              kind === "error" ? "error" : "blocked",
              Math.max(discoveredCount, retainedCount),
              Math.max(collected, retainedCount),
              `${kind}: ${message}`
            );
          }
          await saveProgress();
        });
        };
        try {
          await this.domainExclusive(domain, executeDomain);
        } catch (error) {
          deadline.signal.throwIfAborted();
          if (domainStarted) throw error;
          const kind = errorStatus(error);
          const message = safeErrorMessage(error);
          for (const brand of retryBrands) {
            this.addPartition(
              run,
              domain,
              brand,
              kind === "error" ? "error" : "blocked",
              0,
              0,
              `${kind}: ${message}`
            );
          }
          await saveProgress();
        }
        }
      );
      await progressWrites;
      run.partitions.sort((a, b) =>
        run.request.domains.indexOf(a.domain) - run.request.domains.indexOf(b.domain) ||
        run.request.brands.indexOf(a.brand) - run.request.brands.indexOf(b.brand)
      );
      run.observations = [...seen.values()].sort((a, b) =>
        run.request.domains.indexOf(a.domain) - run.request.domains.indexOf(b.domain) ||
        run.request.brands.indexOf(a.brand) - run.request.brands.indexOf(b.brand) ||
        a.product.localeCompare(b.product, "ru") || a.listingId.localeCompare(b.listingId)
      );
      run.observations = reconcileProductCatalog(run.observations, catalogProducts);
      for (const observation of run.observations) {
        if (!["ok", "no_reviews"].includes(observation.status)) continue;
        const partition = run.partitions.find((item) =>
          item.domain === observation.domain && normalizeText(item.brand) === normalizeText(observation.brand)
        );
        const collapsedDistinctProducts = collapsesDistinctProductPages(
          observation.productIdentity,
          observation.productEvidence,
          partition?.discovered ?? 1,
          observation.brand,
          observation.product
        );
        const autoAcceptedReviewAggregate = canAutoAcceptDedicatedReviewAggregate(observation);
        if (
          (collapsedDistinctProducts && !autoAcceptedReviewAggregate) ||
          (observation.productIdentity?.granularity !== "variant" && !autoAcceptedReviewAggregate)
        ) {
          observation.status = "needs_review";
        }
      }
      delete run.progress.current;
      await this.refreshDraftProfileExamples(run);
      run.payloadHash = stableHash({ request: run.request, observations: run.observations });
      run.status = "review";
      run.collectionFinishedAt = new Date().toISOString();
      const qaActivity = activity.start({
        stage: "qa",
        label: "Проверка целостности"
      });
      run.qa = validateRun(run);
      if (run.qa.ok) {
        activity.complete(qaActivity, { detail: "Снимок готов к публикации" });
      } else {
        activity.warn(qaActivity, { detail: `Требует внимания: ${run.qa.blockers.length}` });
      }
      await this.touch(run);
      return run;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async approveObservations(
    id: string,
    keys: string[],
    productLabels: Record<string, string> = {},
    rejectedKeys: string[] = []
  ): Promise<RunState> {
    const run = await this.requireRun(id);
    if (run.status !== "review") {
      throw new Error(`Нельзя подтверждать карточки из статуса ${run.status}`);
    }
    const accepted = new Set(keys);
    const rejected = new Set(rejectedKeys);
    const reviewKeys = new Set(run.observations
      .filter((item) => item.status === "needs_review")
      .map((item) => productKey(item.domain, item.listingId)));
    for (const key of accepted) {
      if (!reviewKeys.has(key)) throw new Error(`Карточка для подтверждения не найдена: ${key}`);
      if (rejected.has(key)) throw new Error(`Карточка одновременно подтверждена и исключена: ${key}`);
    }
    for (const key of rejected) {
      if (!reviewKeys.has(key)) throw new Error(`Карточка для исключения не найдена: ${key}`);
    }
    for (const [key, value] of Object.entries(productLabels)) {
      if (!accepted.has(key)) throw new Error(`Уточнение продукта передано для невыбранной карточки ${key}`);
      if (!reviewKeys.has(key)) throw new Error(`Карточка для уточнения не найдена: ${key}`);
      if (typeof value !== "string" || !normalizeProductOverride(value) || normalizeProductOverride(value).length > 240) {
        throw new Error(`Некорректное уточнение продукта для карточки ${key}`);
      }
    }
    const profiles = new Map<string, SiteProfile | undefined>();
    const resolved = new Map<string, Observation>();
    for (const item of run.observations) {
      if (item.status !== "needs_review" || !accepted.has(productKey(item.domain, item.listingId))) continue;
      // Dedicated adapters do not carry a generated profile version. A stale
      // generic profile left in the repository must not gate their evidence.
      if (item.profileVersion !== undefined) {
        if (!profiles.has(item.domain)) profiles.set(item.domain, await this.repository.getProfile(item.domain));
        const profile = profiles.get(item.domain);
        if (!profile || profile.status !== "approved") {
          throw new Error(`Сначала подтвердите профиль площадки ${item.domain} по трём контрольным карточкам`);
        }
        if (item.profileVersion !== profile.version) {
          throw new Error(`Карточка ${item.domain}:${item.listingId} собрана профилем другой версии; повторите запуск`);
        }
      }
      const key = productKey(item.domain, item.listingId);
      const productLabel = productLabels[key];
      if (productLabel !== undefined) {
        const manualIdentity = resolveProductOverride(item, productLabel) ??
          resolveYandexFamilyOverride(item, productLabel);
        if (!manualIdentity) {
          throw new Error(`Уточните форму, дозировку или упаковку товара для карточки ${key}`);
        }
        resolved.set(key, { ...item, productOverride: manualIdentity.label, productIdentity: manualIdentity });
      }
      const candidate = resolved.get(key) ?? item;
      const identity = candidate.productIdentity;
      const exactVariant = identity?.granularity === "variant" && identity.confidence === "exact";
      const knownReviewAggregate = Boolean(identity && isKnownReviewAggregateDomain(item.domain) &&
        identity.granularity !== "not_product" && identity.confidence !== "ambiguous");
      const provenAggregate = Boolean(identity && ["family", "line"].includes(identity.granularity) &&
        identity.confidence !== "ambiguous" &&
        (identity.confidence === "exact" || item.productEvidence?.scope === "product_family" || isKnownReviewAggregateDomain(item.domain)));
      if (!exactVariant && !provenAggregate && !knownReviewAggregate) {
        throw new Error(`Карточка ${item.domain}:${item.listingId} не содержит доказанного товарного варианта`);
      }
      resolved.set(key, { ...candidate, status: candidate.reviews === 0 ? "no_reviews" : "ok" });
    }
    const rejectedByPartition = new Map<string, number>();
    for (const item of run.observations) {
      if (item.status !== "needs_review" || !rejected.has(productKey(item.domain, item.listingId))) continue;
      const partitionKey = `${item.domain}\u0000${item.brand}`;
      rejectedByPartition.set(partitionKey, (rejectedByPartition.get(partitionKey) ?? 0) + 1);
    }
    run.observations = run.observations.flatMap((item) => {
      const key = productKey(item.domain, item.listingId);
      const acceptedItem = resolved.get(key);
      if (acceptedItem) return [acceptedItem];
      if (item.status === "needs_review" && rejected.has(key)) return [];
      return [item];
    });
    for (const partition of run.partitions) {
      const rejectedCount = rejectedByPartition.get(`${partition.domain}\u0000${partition.brand}`) ?? 0;
      if (rejectedCount === 0) continue;
      partition.discovered = Math.max(0, partition.discovered - rejectedCount);
      partition.collected = Math.max(0, partition.collected - rejectedCount);
    }
    const spreadsheetId = extractSpreadsheetId(run.request.sheetUrl);
    const requestedBrandKeys = new Set(run.request.brands.map(normalizeText));
    run.observations = reconcileProductCatalog(
      run.observations,
      (await this.repository.listProducts(spreadsheetId))
        .filter((product) => requestedBrandKeys.has(normalizeText(product.brand)))
    );
    run.qa = validateRun(run);
    run.payloadHash = stableHash({ request: run.request, observations: run.observations });
    await this.touch(run);
    return run;
  }

  async approveProfile(
    domainInput: string,
    examples: Array<{ url: string; title?: string }> = [],
    reviewCountMeaning: "reviews" | "ratings" | "feedback" | "unknown" = "unknown"
  ): Promise<SiteProfile> {
    const domain = domainOnly(domainInput);
    const profile = await this.repository.getProfile(domain);
    if (!profile) throw new Error("Профиль ещё не создан");
    if (profile.status === "blocked_free_mode") throw new Error("Площадка запрещает или блокирует бесплатный автоматический доступ");
    const researchedUrls = new Set(profile.testExamples.map((example) => example.url));
    const verifiedExamples = examples.filter((example, index, items) => {
      try {
        const url = assertSafePublicUrl(example.url);
        const host = url.hostname.replace(/^www\./, "");
        return researchedUrls.has(example.url) && (host === domain || host.endsWith(`.${domain}`)) &&
          items.findIndex((item) => item.url === example.url) === index;
      } catch { return false; }
    }).slice(0, 3);
    if (verifiedExamples.length !== 3) throw new Error("Для подтверждения профиля нужны ровно три контрольные карточки этого домена");
    if (reviewCountMeaning === "unknown") throw new Error("Укажите, что означает счётчик площадки: отзывы, оценки или общий feedback");
    const resolvedMeaning = reviewCountMeaning;
    const now = new Date().toISOString();
    const approved = {
      ...profile,
      status: "approved" as const,
      reviewCountMeaning: resolvedMeaning,
      testExamples: verifiedExamples,
      canaryUrls: verifiedExamples.map((example) => example.url),
      approvedAt: now,
      updatedAt: now
    };
    await this.repository.saveProfile(approved);
    return approved;
  }

  async commitSuccessfulRun(run: RunState): Promise<void> {
    await this.assertApprovedProfiles(run);
    const qa = validateRun(run);
    if (!qa.ok) throw new Error(`Публикация заблокирована: ${qa.blockers.join("; ")}`);
    const spreadsheetId = extractSpreadsheetId(run.request.sheetUrl);
    const existing = new Map((await this.repository.listProducts(spreadsheetId)).map((item) => [item.key, item]));
    const publishedObservations = observationsForPublication(run);
    const records: ProductRecord[] = publishedObservations.map((item) => ({
      key: productKey(item.domain, item.listingId), domain: item.domain, listingId: item.listingId,
      brand: item.brand, canonicalUrl: item.canonicalUrl, product: item.product, platform: item.platform,
      groupId: item.groupId,
      aggregateGroupId: item.aggregateGroupId,
      productIdentity: item.productIdentity,
      productEvidence: compactProductCatalogEvidence(item.productEvidence),
      productOverride: item.productOverride,
      firstSeenMonth: earlierMonth(
        existing.get(productKey(item.domain, item.listingId))?.firstSeenMonth,
        run.request.month
      ),
      lastSeenMonth: item.status === "not_found"
        ? existing.get(productKey(item.domain, item.listingId))?.lastSeenMonth ?? run.request.month
        : laterMonth(existing.get(productKey(item.domain, item.listingId))?.lastSeenMonth, run.request.month)
    }));
    await this.repository.saveProducts(spreadsheetId, records);
    await this.repository.saveSnapshot(spreadsheetId, run.request.month, publishedObservations);
  }

  async excludeFailedPartitionsFromPublication(id: string): Promise<RunState> {
    const run = await this.requireRun(id);
    const failed = run.partitions.filter((partition) =>
      !SUCCESSFUL_PARTITION_STATUSES.has(partition.status)
    );
    // A retry can recover data after a prior partial write. Older readback
    // reconciliation may restore its old marker as `published` although
    // failed partitions remain. Reopen only this narrow state so the employee
    // can create a new explicit partial publication; a complete publication
    // remains immutable.
    if (!(["review", "failed"] as RunState["status"][]).includes(run.status) &&
      !(run.status === "published" && failed.length > 0)) {
      throw new Error(`Нельзя изменить состав публикации из статуса ${run.status}`);
    }
    const successful = run.partitions.filter((partition) =>
      SUCCESSFUL_PARTITION_STATUSES.has(partition.status)
    );
    if (!failed.length) return run;
    if (!successful.length) throw new Error("Нет ни одной успешно проверенной площадки для записи");

    const excludedAt = new Date().toISOString();
    run.publicationExclusions = failed.map((partition) => ({
      domain: partition.domain,
      brand: partition.brand,
      reason: partition.message ?? partition.status,
      excludedAt
    }));
    run.payloadHash = stableHash({
      request: run.request,
      observations: observationsForPublication(run),
      publicationExclusions: run.publicationExclusions
    });
    run.status = "review";
    run.qa = validateRun(run);
    run.updatedAt = excludedAt;
    await this.repository.saveRun(run);
    return run;
  }

  async assertApprovedProfiles(run: RunState): Promise<void> {
    const cache = new Map<string, SiteProfile | undefined>();
    for (const item of run.observations) {
      if (item.profileVersion === undefined) continue;
      if (!cache.has(item.domain)) cache.set(item.domain, await this.repository.getProfile(item.domain));
      const profile = cache.get(item.domain);
      if (!profile || profile.status !== "approved" || profile.version !== item.profileVersion) {
        throw new Error(`Профиль ${item.domain} версии ${item.profileVersion} не одобрен или уже изменился`);
      }
    }
  }

  private async refreshDraftProfileExamples(run: RunState): Promise<void> {
    for (const domain of run.request.domains) {
      const profile = await this.repository.getProfile(domain);
      if (!profile || profile.status !== "draft") continue;
      const candidates = run.observations
        .filter((item) => item.domain === domain && item.profileVersion === profile.version && item.reviews !== null && (item.reviews === 0 || item.rating !== null))
        .map((item) => ({ url: item.canonicalUrl, title: item.product }));
      const merged = [...profile.testExamples, ...candidates].filter((item, index, items) =>
        items.findIndex((candidate) => candidate.url === item.url) === index
      ).slice(0, 3);
      if (merged.length === profile.testExamples.length) continue;
      await this.repository.saveProfile({ ...profile, testExamples: merged, canaryUrls: merged.map((item) => item.url), updatedAt: new Date().toISOString() });
    }
  }

  private async requireRun(id: string): Promise<RunState> {
    const run = await this.repository.getRun(id);
    if (!run) throw new Error("Запуск не найден");
    return run;
  }
  private addPartition(run: RunState, domain: string, brand: string, status: "complete" | "no_results" | "blocked" | "error", discovered: number, collected: number, message?: string) {
    run.partitions.push({ domain, brand, status, discovered, collected, message });
    run.progress.completedPartitions += 1;
  }
  private async touch(run: RunState) { run.updatedAt = new Date().toISOString(); await this.repository.saveRun(run); }
}

export function createAdapterResolver(
  known: SiteAdapter[], repository: Repository, evidence: EvidenceStore, fetchImpl?: typeof fetch
): AdapterResolver {
  return async (domain, request) => {
    const adapter = known.find((candidate) => candidate.supportedDomains.some((supported) => domain === supported.replace(/^www\./, "")));
    if (adapter) return adapter;
    if (!fetchImpl) {
      throw new AdapterBlockedError("Исследование новых площадок доступно только в защищённом браузерном Agent");
    }
    let profile = await repository.getProfile(domain);
    if (!profile) {
      profile = await profileSite(domain, request.brands[0], fetchImpl);
      await repository.saveProfile(profile);
    } else if (profile.status === "parser_changed") {
      const researched = await profileSite(domain, request.brands[0], fetchImpl);
      profile = {
        ...researched,
        version: profile.version + 1,
        createdAt: profile.createdAt,
        notes: [...profile.notes, ...researched.notes]
      };
      await repository.saveProfile(profile);
    }
    return new GenericSiteAdapter(profile, evidence, fetchImpl);
  };
}
