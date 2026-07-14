import type { AdapterContext, AdapterHealth, Observation, ProductRef, SiteAdapter } from "../../shared/types.js";
import { AdapterQuotaError } from "./errors.js";

export type AsyncExclusive = <T>(operation: () => Promise<T>) => Promise<T>;

type DiscoveryCacheAwareAdapter = SiteAdapter & {
  /** True only when discover() can return without starting another paid call. */
  isDiscoveryCached(brand: string, context: AdapterContext): boolean;
};

function hasCachedDiscovery(
  adapter: SiteAdapter,
  brand: string,
  context: AdapterContext
): boolean {
  const candidate = adapter as Partial<DiscoveryCacheAwareAdapter>;
  return typeof candidate.isDiscoveryCached === "function" &&
    candidate.isDiscoveryCached(brand, context);
}

/**
 * A small in-process gate used by all paid fallback adapters in one runtime.
 * The distributed Agent adds its account-wide lease inside the same gate.
 */
export function createSerialExecutor(): AsyncExclusive {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export class BudgetedAdapter implements SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];

  private readonly checks = new Map<string, Promise<void>>();

  constructor(
    private readonly inner: SiteAdapter,
    private readonly options: {
      reservePerDiscovery: number;
      monthlyLimit: number;
      externalUsageUsd?: () => Promise<number>;
      /**
       * Optional account-wide reservation. Runtime wiring uses this to keep a
       * persistent conservative usage floor while Apify's live usage endpoint
       * is still catching up with a just-finished Actor run.
       */
      reserveCapacityUsd?: (amount: number) => Promise<void>;
      runExclusive?: AsyncExclusive;
    }
  ) {
    if (!Number.isFinite(options.reservePerDiscovery) || options.reservePerDiscovery <= 0) {
      throw new RangeError("reservePerDiscovery must be a positive finite number");
    }
    if (!Number.isFinite(options.monthlyLimit) || options.monthlyLimit <= 0) {
      throw new RangeError("monthlyLimit must be a positive finite number");
    }
    if (options.reservePerDiscovery > options.monthlyLimit) {
      throw new RangeError("reservePerDiscovery must not exceed monthlyLimit");
    }
    this.id = inner.id;
    this.supportedDomains = inner.supportedDomains;
  }

  healthCheck(context: AdapterContext): Promise<AdapterHealth> { return this.inner.healthCheck(context); }
  collect(ref: ProductRef, context: AdapterContext): Promise<Observation> { return this.inner.collect(ref, context); }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    const operation = async () => {
      context.signal?.throwIfAborted();
      if (!hasCachedDiscovery(this.inner, brand, context)) {
        // Check live Apify usage immediately before the paid Actor call instead
        // of accumulating a stale synthetic ledger that over-reserves actual cost.
        const scope = `${context.runId ?? context.month ?? new Date().toISOString().slice(0, 7)}:${brand}`;
        let check = this.checks.get(scope);
        if (!check) {
          check = this.assertCapacity();
          this.checks.set(scope, check);
        }
        try {
          await check;
        } finally {
          // Coalesce only simultaneous duplicate calls. A later retry must read
          // the current account usage again before it can start another Actor run.
          if (this.checks.get(scope) === check) this.checks.delete(scope);
        }
      }
      context.signal?.throwIfAborted();
      return this.inner.discover(brand, context);
    };
    return this.options.runExclusive
      ? this.options.runExclusive(operation)
      : operation();
  }

  private async assertCapacity(): Promise<void> {
    try {
      if (this.options.reserveCapacityUsd) {
        await this.options.reserveCapacityUsd(this.options.reservePerDiscovery);
        return;
      }
      if (!this.options.externalUsageUsd) return;
      const actual = await this.options.externalUsageUsd();
      if (!Number.isFinite(actual) || actual < 0 || actual + this.options.reservePerDiscovery > this.options.monthlyLimit + Number.EPSILON) {
        throw new Error(
          `Фактическое использование Apify ${Number.isFinite(actual) ? actual.toFixed(2) : "не определено"} USD не оставляет безопасной квоты ${this.options.reservePerDiscovery.toFixed(2)} USD`
        );
      }
    } catch (error) {
      if (error instanceof AdapterQuotaError) throw error;
      throw new AdapterQuotaError(error instanceof Error ? error.message : String(error));
    }
  }
}
