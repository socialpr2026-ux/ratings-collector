import { createHash, randomUUID } from "node:crypto";
import type {
  Observation,
  ProductRecord,
  ProductRef,
  RunRequest,
  RunState,
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
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./adapters/errors.js";
import { safeErrorMessage } from "./utils/error-message.js";
import { normalizeText } from "./utils/normalize.js";
import { assertSafePublicUrl, extractSpreadsheetId } from "./utils/urls.js";
import { analyzeProductIdentity } from "./utils/product-name.js";
import { titleProductEvidence } from "./utils/product-evidence.js";
import { normalizeObservationFeedback } from "./feedback-count.js";

const RUN_SOFT_DEADLINE_MS = 26 * 60 * 1000;

export type AdapterResolver = (domain: string, request: RunRequest) => Promise<SiteAdapter>;

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
    /blocked[_\s-]*free[_\s-]*mode|captcha|капч|\bpow\b|заблокирован|блокирует|access\s*denied|forbidden|HTTP\s+(?:401|403|429|498)\b/i.test(message)
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
  await Promise.all(runners);
}

function brandConcurrency(domain: string): number {
  // Ozon is serialized so the live Apify fallback quota is checked between
  // capped Actor calls. WB keeps its own request queue, while Yandex reuses one
  // browser-backed cache. A generated SiteProfile carries one domain-wide rate
  // limit, so unknown domains must not run several brand partitions at once.
  return domain === "wildberries.ru" || domain === "market.yandex.ru" ? 4 : 1;
}

const SUCCESSFUL_PARTITION_STATUSES = new Set(["complete", "no_results"]);

function partitionKey(domain: string, brand: string): string {
  return `${domain}\u0000${brand}`;
}

export class RatingsService {
  private active = new Set<string>();

  constructor(private readonly repository: Repository, private readonly resolveAdapter: AdapterResolver) {}

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
    const retryTargets = isRetry
      ? expectedPartitions.filter(({ key }) => !SUCCESSFUL_PARTITION_STATUSES.has(previousPartitions.get(key)?.status ?? ""))
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
      run.qa = validateRun(run);
      await this.touch(run);
      return run;
    }

    const retryErrorPartitions = new Set(retryTargets.map(({ domain, brand }) => `${domain}/${brand}`));
    const preservedPartitions = isRetry
      ? expectedPartitions.flatMap(({ key }) => {
        const previous = previousPartitions.get(key);
        return previous && SUCCESSFUL_PARTITION_STATUSES.has(previous.status) ? [previous] : [];
      })
      : [];
    const preservedPartitionKeys = new Set(preservedPartitions.map((partition) =>
      partitionKey(partition.domain, partition.brand)
    ));
    run.status = "running";
    run.errors = isRetry
      ? run.errors.filter((error) => !retryErrorPartitions.has(error.partition) && error.partition !== "orchestrator")
      : [];
    run.observations = isRetry
      ? run.observations.filter((observation) => preservedPartitionKeys.has(partitionKey(observation.domain, observation.brand)))
      : [];
    run.partitions = preservedPartitions;
    run.qa = undefined;
    run.payloadHash = undefined;
    run.publication = undefined;
    run.progress.totalPartitions = expectedPartitions.length;
    run.progress.completedPartitions = preservedPartitions.length;
    delete run.progress.current;
    await this.touch(run);
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(new Error("run_deadline_exceeded")),
      RUN_SOFT_DEADLINE_MS
    );
    deadlineTimer.unref?.();
    try {
      const products = await this.repository.listProducts(extractSpreadsheetId(run.request.sheetUrl));
      const seen = new Map(run.observations.map((observation) => [
        productKey(observation.domain, observation.listingId),
        observation
      ]));
      let progressWrites = Promise.resolve();
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
      const retryBrandsByDomain = new Map<string, string[]>();
      for (const { domain, brand } of retryTargets) {
        const brands = retryBrandsByDomain.get(domain) ?? [];
        brands.push(brand);
        retryBrandsByDomain.set(domain, brands);
      }
      await Promise.all(run.request.domains.filter((domain) => retryBrandsByDomain.has(domain)).map(async (domain) => {
        const retryBrands = retryBrandsByDomain.get(domain)!;
        let adapter: SiteAdapter;
        try {
          deadline.signal.throwIfAborted();
          adapter = await this.resolveAdapter(domain, run.request);
          const health = await adapter.healthCheck({
            runId: run.id,
            brands: retryBrands,
            region: run.request.region,
            month: run.request.month,
            signal: deadline.signal
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
        } catch (error) {
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
          return;
        }
        await forEachWithConcurrency(retryBrands, brandConcurrency(domain), async (brand) => {
          run.progress.current = `${domain} / ${brand}`;
          const previousRecords = products.filter((item) => item.domain === domain && item.brand === brand);
          const previousIds = previousRecords.map((item) => item.listingId);
          const previousRefs = previousRecords.map((item) => ({ listingId: item.listingId, url: item.canonicalUrl }));
          try {
            deadline.signal.throwIfAborted();
            const discovered = validateDiscoveredRefs(await adapter.discover(brand, {
              runId: run.id,
              brands: retryBrands,
              region: run.request.region,
              month: run.request.month,
              previousIds,
              previousRefs,
              signal: deadline.signal
            }), domain, brand);
            if (!discovered.length) {
              this.addPartition(run, domain, brand, "no_results", 0, 0, "Поиск исчерпан, карточек нет");
              await saveProgress();
              return;
            }
            let collected = 0;
            let viableDiscovered = discovered.length;
            const previousById = new Map(previousRecords.map((item) => [item.listingId, item]));
            for (const ref of discovered) {
              deadline.signal.throwIfAborted();
              const observation = validateCollectedObservation(await adapter.collect(ref, {
                runId: run.id,
                brands: retryBrands,
                region: run.request.region,
                month: run.request.month,
                previousIds,
                previousRefs,
                signal: deadline.signal
              }), ref, domain, brand);
              normalizeObservationFeedback(observation);
              if (observation.status === "not_found") {
                const historical = previousById.get(observation.listingId);
                if (historical && observation.reviews === null && observation.rating === null) {
                  observation.historical = true;
                  observation.canonicalUrl = historical.canonicalUrl;
                  observation.product = historical.product;
                  observation.productIdentity = historical.productIdentity;
                  observation.brand = historical.brand;
                } else if (observation.source === "yandex_reviews_missing_candidate") {
                  // The search actor can occasionally return a stale modelId.
                  // An explicit Yandex missing-page screen proves that this is
                  // not a current product card and it must not enter the sheet.
                  viableDiscovered -= 1;
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
                observation.productIdentity = analyzeProductIdentity({
                  brand: observation.brand,
                  product: observation.product,
                  url: observation.canonicalUrl,
                  evidence: observation.productEvidence
                });
                if (
                  ["ok", "no_reviews"].includes(observation.status) &&
                  observation.productIdentity.granularity !== "variant" &&
                  !hasDeterministicAggregateProof(observation)
                ) {
                  observation.status = "needs_review";
                }
              }
              const key = productKey(observation.domain, observation.listingId);
              const existing = seen.get(key);
              if (existing && existing.brand !== observation.brand) {
                observation.status = "needs_review";
                existing.status = "needs_review";
                run.errors.push({ partition: `${domain}/${brand}`, message: `${key} найден у двух брендов` });
              } else if (!existing) {
                seen.set(key, observation);
                collected += 1;
              }
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
          } catch (error) {
            const kind = errorStatus(error);
            const message = safeErrorMessage(error);
            run.errors.push({ partition: `${domain}/${brand}`, message: `${kind}: ${message}` });
            this.addPartition(run, domain, brand, kind === "error" ? "error" : "blocked", 0, 0, `${kind}: ${message}`);
          }
          await saveProgress();
        });
      }));
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
      await this.refreshDraftProfileExamples(run);
      run.payloadHash = stableHash({ request: run.request, observations: run.observations });
      run.status = "review";
      run.qa = validateRun(run);
      await this.touch(run);
      return run;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async approveObservations(id: string, keys: string[]): Promise<RunState> {
    const run = await this.requireRun(id);
    if (run.status !== "review") {
      throw new Error(`Нельзя подтверждать карточки из статуса ${run.status}`);
    }
    const accepted = new Set(keys);
    const profiles = new Map<string, SiteProfile | undefined>();
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
      const identity = item.productIdentity;
      const exactVariant = identity?.granularity === "variant" && identity.confidence === "exact";
      const knownReviewAggregate = Boolean(identity && isKnownReviewAggregateDomain(item.domain) &&
        identity.granularity !== "not_product" && identity.confidence !== "ambiguous");
      const provenAggregate = Boolean(identity && ["family", "line"].includes(identity.granularity) &&
        identity.confidence !== "ambiguous" &&
        (identity.confidence === "exact" || item.productEvidence?.scope === "product_family" || isKnownReviewAggregateDomain(item.domain)));
      if (!exactVariant && !provenAggregate && !knownReviewAggregate) {
        throw new Error(`Карточка ${item.domain}:${item.listingId} не содержит доказанного товарного варианта`);
      }
      item.status = item.reviews === 0 ? "no_reviews" : "ok";
    }
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
    const records: ProductRecord[] = run.observations.map((item) => ({
      key: productKey(item.domain, item.listingId), domain: item.domain, listingId: item.listingId,
      brand: item.brand, canonicalUrl: item.canonicalUrl, product: item.product, platform: item.platform,
      groupId: item.groupId,
      productIdentity: item.productIdentity,
      firstSeenMonth: earlierMonth(
        existing.get(productKey(item.domain, item.listingId))?.firstSeenMonth,
        run.request.month
      ),
      lastSeenMonth: item.status === "not_found"
        ? existing.get(productKey(item.domain, item.listingId))?.lastSeenMonth ?? run.request.month
        : laterMonth(existing.get(productKey(item.domain, item.listingId))?.lastSeenMonth, run.request.month)
    }));
    await this.repository.saveProducts(spreadsheetId, records);
    await this.repository.saveSnapshot(spreadsheetId, run.request.month, run.observations);
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
