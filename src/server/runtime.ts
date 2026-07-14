import { OzonAdapter } from "./adapters/ozon.js";
import { OzonBrowserAdapter } from "./adapters/ozon-browser.js";
import { ResilientOzonAdapter } from "./adapters/ozon-resilient.js";
import { WildberriesAdapter } from "./adapters/wildberries.js";
import { YandexAdapter } from "./adapters/yandex.js";
import { WildberriesApifyAdapter, isWildberriesApifyRef } from "./adapters/wildberries-apify.js";
import { YandexApifyAdapter, isYandexApifyRef } from "./adapters/yandex-apify.js";
import { BudgetedAdapter, createSerialExecutor, type AsyncExclusive } from "./adapters/budgeted.js";
import { ResilientAdapter } from "./adapters/resilient.js";
import { createReviewSiteAdapters } from "./adapters/review-sites.js";
import { EaptekaAdapter } from "./adapters/eapteka.js";
import { FileEvidenceStore, type EvidenceStore } from "./evidence.js";
import { createAdapterResolver, RatingsService } from "./orchestrator.js";
import { FileRepository, type Repository } from "./repository.js";
import { readTextBounded, safeFetch } from "./utils/safe-fetch.js";

export type CollectorRuntime = { repository: Repository; service: RatingsService };
export type Runtime = CollectorRuntime;

export function apifyMonthlyBudget(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === "" ? 4.5 : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 4.5) {
    throw new Error("APIFY_MONTHLY_BUDGET_USD должен быть числом больше 0 и не выше 4.50");
  }
  return parsed;
}

async function apifyMonthlyUsageUsd(token: string | undefined, fetchImpl: typeof fetch): Promise<number> {
  if (!token?.trim()) throw new Error("APIFY_TOKEN не настроен");
  const response = await safeFetch("https://api.apify.com/v2/users/me/usage/monthly", {
    headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" }
  }, fetchImpl);
  if (!response.ok) throw new Error(`Не удалось проверить фактическую квоту Apify: HTTP ${response.status}`);
  const payload = JSON.parse(await readTextBounded(response, 1_000_000)) as { data?: { totalUsageCreditsUsdAfterVolumeDiscount?: number } };
  const usage = Number(payload.data?.totalUsageCreditsUsdAfterVolumeDiscount);
  if (!Number.isFinite(usage) || usage < 0) throw new Error("Apify вернул некорректное значение текущего использования");
  return usage;
}

export async function assertApifyCapacity(
  env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch, reserveUsd = 0.25
): Promise<void> {
  const limit = apifyMonthlyBudget(env.APIFY_MONTHLY_BUDGET_USD);
  const used = await apifyMonthlyUsageUsd(env.APIFY_TOKEN, fetchImpl);
  if (used + reserveUsd > limit + Number.EPSILON) {
    throw new Error(`Квота Apify: использовано ${used.toFixed(2)} USD, безопасный лимит ${limit.toFixed(2)} USD`);
  }
}

export async function createCollectorRuntime(options: {
  repository?: Repository; evidence?: EvidenceStore; fetch?: typeof fetch;
  /** Test/local override for direct fixed-origin Yandex Reviews requests. */
  reviewsFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  apifyExclusive?: AsyncExclusive;
} = {}): Promise<CollectorRuntime> {
  const env = options.env ?? process.env;
  const repository = options.repository ?? await FileRepository.open();
  const evidence = options.evidence ?? new FileEvidenceStore();
  const fetchImpl = options.fetch ?? fetch;
  const monthlyLimit = apifyMonthlyBudget(env.APIFY_MONTHLY_BUDGET_USD);
  // Every paid Actor request is capped to the exact amount reserved below.
  // Keeping these values coupled prevents a platform-specific environment
  // override from making a call more expensive than the shared budget gate
  // accounted for.
  const reservePerDiscovery = Math.min(0.25, monthlyLimit);
  // One Ozon Actor call covers every brand in the run. The adapter couples its
  // maxItems safety cap to this $0.25 charge ceiling, so a capped response can
  // never be mistaken for exhaustive discovery.
  const ozonReservePerDiscovery = Math.min(0.25, monthlyLimit);
  const externalUsageUsd = () => apifyMonthlyUsageUsd(env.APIFY_TOKEN, fetchImpl);
  const usageMonth = new Date().toISOString().slice(0, 7);
  const reserveCapacityUsd = async (amount: number) => {
    const actual = await externalUsageUsd();
    if (!Number.isFinite(actual) || actual < 0) {
      throw new Error("Apify returned an invalid current-usage value");
    }
    // v3 stores short-lived reservation amounts separately from authoritative
    // account usage. The previous half-hour bucket overlaps the current one,
    // protecting against delayed Apify usage without permanently leaking the
    // maximum reservation of completed or failed Actor calls.
    const windowMs = 30 * 60 * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    // v4 starts a clean reservation namespace after introducing settlement
    // for proven-empty Actor batches. Old v3 reservations used the maximum
    // charge as a non-releasable hold and must not keep blocking the corrected
    // accounting model; authoritative live Apify usage is still checked above.
    const currentKey = `apify:v4:${usageMonth}:${bucket}`;
    const previousKey = `apify:v4:${usageMonth}:${bucket - 1}`;
    const [currentReserved, previousReserved] = await Promise.all([
      repository.reserveUsage(currentKey, 0, monthlyLimit),
      repository.reserveUsage(previousKey, 0, monthlyLimit)
    ]);
    const available = monthlyLimit - actual;
    const pending = currentReserved + previousReserved + amount;
    if (available <= 0 || pending > available + Number.EPSILON) {
      throw new Error(`Квота ${monthlyLimit.toFixed(2)} исчерпана: использовано ${actual.toFixed(2)}, временно зарезервировано ${(currentReserved + previousReserved).toFixed(2)}`);
    }
    await repository.reserveUsage(currentKey, amount, available - previousReserved);
    // A zero-result Ozon run still has a tiny platform overhead even though it
    // cannot incur the per-result maximum. Keep a conservative cent pending
    // while releasing only the impossible result charge after empty proof.
    const emptyActorFloorUsd = Math.min(amount, 0.01);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const releasable = amount - emptyActorFloorUsd;
        if (releasable > 0) await repository.releaseUsage(currentKey, releasable);
      }
    };
  };
  const apifyExclusive = options.apifyExclusive ?? createSerialExecutor();
  const cappedFallback = (
    adapter: OzonAdapter | WildberriesApifyAdapter | YandexApifyAdapter,
    reserveUsd = reservePerDiscovery
  ) =>
    new BudgetedAdapter(adapter, {
      reservePerDiscovery: reserveUsd,
      monthlyLimit,
      reserveCapacityUsd,
      runExclusive: apifyExclusive
    });
  const apifyOzon = cappedFallback(new OzonAdapter({
    fetch: options.fetch,
    token: env.APIFY_TOKEN,
    maxTotalChargeUsd: ozonReservePerDiscovery
  }), ozonReservePerDiscovery);
  const ozon = new ResilientOzonAdapter(
    new OzonBrowserAdapter({ fetch: options.fetch }),
    apifyOzon
  );
  const wildberries = new ResilientAdapter(
    new WildberriesAdapter({ fetch: options.fetch }),
    cappedFallback(new WildberriesApifyAdapter({
      fetch: options.fetch,
      token: env.APIFY_TOKEN,
      maxTotalChargeUsd: reservePerDiscovery
    })),
    {
      isFallbackRef: isWildberriesApifyRef,
      // Buyer search throttling is transient. A failure for one brand must not
      // route all remaining brands through the paid monthly allowance.
      stickyPrimaryFailure: false
    }
  );
  const yandex = new ResilientAdapter(
    new YandexAdapter({ fetch: options.fetch }),
    cappedFallback(new YandexApifyAdapter({
      fetch: options.fetch,
      reviewsFetch: options.reviewsFetch,
      token: env.APIFY_TOKEN,
      maxTotalChargeUsd: reservePerDiscovery
    })),
    {
      isFallbackRef: isYandexApifyRef,
      // Reviews sitemap throttling and large-map timeouts are transient. A
      // selective retry must return to the free first-party path instead of
      // permanently consuming the shared paid fallback budget.
      stickyPrimaryFailure: false
    }
  );
  const known = [ozon, wildberries, yandex, new EaptekaAdapter(evidence, options.fetch), ...createReviewSiteAdapters(evidence, options.fetch)];
  const service = new RatingsService(repository, createAdapterResolver(known, repository, evidence, options.fetch));
  return { repository, service };
}

export async function createRuntime(options: {
  repository?: Repository; evidence?: EvidenceStore; fetch?: typeof fetch;
  reviewsFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  apifyExclusive?: AsyncExclusive;
} = {}): Promise<Runtime> {
  return createCollectorRuntime(options);
}
